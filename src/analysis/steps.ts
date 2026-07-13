/**
 * Rule: step-level inefficiencies within a single job — expensive steps placed
 * before cheap validation steps, and repeated setup actions.
 */
import type { Finding, StepModel } from '../types.js';
import type { AnalysisInput } from './framework.js';
import { makeFinding, inferredSavings } from './framework.js';
import { extractDependencyInstalls } from '../parser/features.js';

const RULE_ORDER = 'expensive-before-validation';
const RULE_SETUP_REPEAT = 'repeated-setup-action';

const CHEAP_VALIDATION_RE =
  /\b(lint|eslint|prettier|--check|fmt\s+--check|cargo\s+fmt|black\s+--check|flake8|ruff|typecheck|tsc\s+--noEmit|shellcheck|yamllint)\b/i;
const EXPENSIVE_RE =
  /\b(build|compile|cargo\s+build|cargo\s+test|test|webpack|vite\s+build|gradle|mvn|make\b|docker\s+build)\b/i;

function isExpensiveStep(step: StepModel, installIndexes: Set<number>): boolean {
  if (installIndexes.has(step.index)) return true;
  return Boolean(step.run && EXPENSIVE_RE.test(step.run));
}

function isCheapValidationStep(step: StepModel): boolean {
  return Boolean(step.run && CHEAP_VALIDATION_RE.test(step.run) && !EXPENSIVE_RE.test(step.run));
}

export function analyzeSteps(input: AnalysisInput): Finding[] {
  const findings: Finding[] = [];
  let orderSeq = 1;
  let setupSeq = 1;

  for (const job of input.workflow.jobs) {
    if (input.context.ignoredJobs.has(job.id)) continue;
    const installIndexes = new Set(extractDependencyInstalls(job).map((i) => i.stepIndex));

    // Expensive step before a cheap validation step.
    let firstExpensiveIndex = -1;
    for (const step of job.steps) {
      if (firstExpensiveIndex < 0 && isExpensiveStep(step, installIndexes) && step.run) {
        firstExpensiveIndex = step.index;
      } else if (firstExpensiveIndex >= 0 && isCheapValidationStep(step)) {
        const expensiveStep = job.steps.find((s) => s.index === firstExpensiveIndex);
        findings.push(
          makeFinding({
            rule: RULE_ORDER,
            seq: orderSeq++,
            kind: 'performance',
            severity: 'low',
            title: `Cheap validation runs after an expensive step in job \`${job.id}\``,
            description: `In job \`${job.id}\`, an expensive step (${expensiveStep?.name ?? `step ${firstExpensiveIndex}`}) runs before a cheap validation step (${step.name ?? `step ${step.index}`}). If the cheap check often fails, running it first would fail the job sooner and save the expensive work.`,
            recommendation:
              'Run fast checks (lint, format, typecheck) before expensive build/test steps so failures surface early.',
            workflow: input.workflow.path,
            evidence: [
              {
                label: `job ${job.id}`,
                detail: `expensive: ${expensiveStep?.name ?? `step ${firstExpensiveIndex}`}`,
              },
              {
                label: `job ${job.id}`,
                detail: `validation: ${step.name ?? `step ${step.index}`}`,
              },
            ],
            ...(step.location ? { location: step.location } : {}),
            savings: inferredSavings(
              0,
              30,
              'Savings only apply on runs where the cheap check fails; magnitude depends on failure rate. Inferred.',
            ),
            jobs: [job.id],
          }),
        );
        break; // one per job is enough
      }
    }

    // Repeated setup action within a job (e.g. two setup-node steps).
    const setupCounts = new Map<string, number>();
    for (const step of job.steps) {
      if (step.usesAction?.startsWith('actions/setup-')) {
        setupCounts.set(step.usesAction, (setupCounts.get(step.usesAction) ?? 0) + 1);
      }
    }
    for (const [action, count] of setupCounts) {
      if (count > 1) {
        findings.push(
          makeFinding({
            rule: RULE_SETUP_REPEAT,
            seq: setupSeq++,
            kind: 'performance',
            severity: 'low',
            title: `\`${action}\` runs ${count} times in job \`${job.id}\``,
            description: `Job \`${job.id}\` invokes \`${action}\` ${count} times. Unless each invocation configures a different version, the repetition duplicates setup work.`,
            recommendation:
              'Configure the toolchain once per job, using a matrix or a version list if multiple versions are needed.',
            workflow: input.workflow.path,
            evidence: [{ label: `job ${job.id}`, detail: `${action} × ${count}` }],
            ...(job.location ? { location: job.location } : {}),
            savings: inferredSavings(
              0,
              (count - 1) * 12,
              'Each redundant setup costs several seconds. Inferred.',
            ),
            jobs: [job.id],
          }),
        );
      }
    }
  }

  return findings;
}
