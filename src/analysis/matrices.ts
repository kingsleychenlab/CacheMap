/**
 * Rule: matrix inefficiency analysis. We never remove matrix combinations
 * automatically — findings describe structural issues and let the author
 * decide.
 */
import type { Finding } from '../types.js';
import type { AnalysisInput } from './framework.js';
import { makeFinding, inferredSavings, unknownSavings } from './framework.js';
import { findDuplicateCombinations } from '../parser/matrices.js';
import { estimateJobSeconds } from '../graph/estimate.js';

const RULE_DUP = 'matrix-duplicate-combination';
const RULE_SINGLE = 'matrix-single-value-dimension';
const RULE_LARGE = 'matrix-large';
const RULE_FAILFAST = 'matrix-fail-fast-disabled';

const LARGE_MATRIX_THRESHOLD = 20;

export function analyzeMatrices(input: AnalysisInput): Finding[] {
  const findings: Finding[] = [];
  let dupSeq = 1;
  let singleSeq = 1;
  let largeSeq = 1;
  let failFastSeq = 1;

  for (const job of input.workflow.jobs) {
    if (input.context.ignoredJobs.has(job.id)) continue;
    if (!job.matrix) continue;
    const variants = input.variantsByJob.get(job.id) ?? [];
    const perVariantSeconds = estimateJobSeconds(job);

    // Duplicate combinations.
    const dups = findDuplicateCombinations(variants);
    for (const group of dups) {
      findings.push(
        makeFinding({
          rule: RULE_DUP,
          seq: dupSeq++,
          kind: 'performance',
          severity: 'medium',
          title: `Duplicate matrix combinations in job \`${job.id}\``,
          description: `Job \`${job.id}\` expands to ${group.length} identical matrix combinations, running the same work more than once.`,
          recommendation:
            'Remove the duplicate values or use `include`/`exclude` to keep the intended combinations only.',
          workflow: input.workflow.path,
          evidence: group.map((v) => ({ label: v })),
          ...(job.location ? { location: job.location } : {}),
          savings: inferredSavings(
            (group.length - 1) * perVariantSeconds,
            (group.length - 1) * perVariantSeconds,
            `Each duplicate combination runs the full job (~${perVariantSeconds}s estimated). Inferred, no history.`,
          ),
          jobs: [job.id],
        }),
      );
    }

    // Single-value dimensions add no variation.
    for (const dim of job.matrix.dimensions) {
      if (dim.values && dim.values.length === 1) {
        findings.push(
          makeFinding({
            rule: RULE_SINGLE,
            seq: singleSeq++,
            kind: 'performance',
            severity: 'low',
            title: `Matrix dimension \`${dim.name}\` in job \`${job.id}\` has a single value`,
            description: `The matrix dimension \`${dim.name}\` has only one value (${JSON.stringify(dim.values[0])}), so it adds no execution variation while complicating the matrix.`,
            recommendation:
              'Move the constant into `env` or a step input instead of a matrix dimension, or add the additional values you intended to test.',
            workflow: input.workflow.path,
            evidence: [{ label: `job ${job.id}`, detail: `${dim.name}: ${dim.raw}` }],
            ...(job.location ? { location: job.location } : {}),
            savings: unknownSavings(
              'A redundant dimension does not by itself add runtime; this is a clarity issue.',
            ),
            jobs: [job.id],
          }),
        );
      }
    }

    // Large matrix.
    if (!job.matrix.dynamic && variants.length >= LARGE_MATRIX_THRESHOLD) {
      findings.push(
        makeFinding({
          rule: RULE_LARGE,
          seq: largeSeq++,
          kind: 'performance',
          severity: 'medium',
          title: `Large matrix in job \`${job.id}\` (${variants.length} combinations)`,
          description: `Job \`${job.id}\` expands to ${variants.length} combinations. Large matrices multiply setup cost and compute usage; often only a subset provides meaningful coverage.`,
          recommendation:
            'Reduce the matrix to the combinations that add coverage using `include`/`exclude`, and reserve the full matrix for scheduled or release runs.',
          workflow: input.workflow.path,
          evidence: [{ label: `job ${job.id}`, detail: `${variants.length} combinations` }],
          ...(job.location ? { location: job.location } : {}),
          savings: inferredSavings(
            0,
            Math.round(variants.length * 0.25) * perVariantSeconds,
            `Upper bound assumes ~25% of combinations could be trimmed (${perVariantSeconds}s each). The right subset is a coverage decision, not automatic. Inferred.`,
          ),
          jobs: [job.id],
        }),
      );
    }

    // fail-fast disabled.
    if (job.failFast === false) {
      findings.push(
        makeFinding({
          rule: RULE_FAILFAST,
          seq: failFastSeq++,
          kind: 'performance',
          severity: 'low',
          title: `\`fail-fast: false\` in job \`${job.id}\``,
          description: `Job \`${job.id}\` disables fail-fast, so every matrix combination runs to completion even after one fails. This is useful for gathering full test results but increases compute usage on failing runs.`,
          recommendation:
            'Keep `fail-fast: false` only if you rely on seeing every combination fail; otherwise remove it to cancel siblings once one fails.',
          workflow: input.workflow.path,
          evidence: [{ label: `job ${job.id}`, detail: 'strategy.fail-fast: false' }],
          ...(job.location ? { location: job.location } : {}),
          savings: unknownSavings(
            'Only matters on failing runs; time impact depends on failure frequency (needs history).',
          ),
          jobs: [job.id],
        }),
      );
    }
  }

  return findings;
}
