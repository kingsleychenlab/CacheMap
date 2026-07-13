/**
 * Rule: token permissions and safety. These are SECURITY findings — reported
 * separately from performance savings and never assigned a time-savings value.
 */
import type { Finding, PermissionsModel } from '../types.js';
import type { AnalysisInput } from './framework.js';
import { makeFinding } from './framework.js';

const RULE_WRITE = 'permissions-excessive-write';
const RULE_BLANKET = 'permissions-blanket-write';
const RULE_TOP_OVERRIDE = 'permissions-top-level-broad';
const RULE_PRT = 'pull-request-target-checkout';

function writeScopes(perms: PermissionsModel | undefined): string[] {
  if (!perms) return [];
  return Object.entries(perms.scopes)
    .filter(([, level]) => level === 'write')
    .map(([scope]) => scope);
}

export function analyzePermissions(input: AnalysisInput): Finding[] {
  const findings: Finding[] = [];
  const location = { file: input.workflow.path };
  const top = input.workflow.permissions;

  // Blanket write-all at the top level.
  if (top?.blanket === 'write-all') {
    findings.push(
      makeFinding({
        rule: RULE_BLANKET,
        seq: 1,
        kind: 'security',
        severity: 'high',
        title: 'Workflow grants `write-all` permissions',
        description:
          'The workflow sets top-level `permissions: write-all`, granting the `GITHUB_TOKEN` write access to every scope. If any step runs untrusted code, this maximizes the blast radius.',
        recommendation:
          'Set `permissions: {}` (or `contents: read`) at the top level and grant only the specific write scopes individual jobs require.',
        workflow: input.workflow.path,
        evidence: [{ label: 'permissions', detail: 'write-all' }],
        location,
      }),
    );
  } else if (top && top.blanket === undefined) {
    const writes = writeScopes(top);
    if (writes.length > 0) {
      findings.push(
        makeFinding({
          rule: RULE_TOP_OVERRIDE,
          seq: 1,
          kind: 'security',
          severity: 'medium',
          title: 'Top-level permissions grant write access to all jobs',
          description: `Top-level \`permissions\` grant write access (${writes.join(', ')}) to every job in the workflow, including jobs that only need read access.`,
          recommendation:
            'Keep top-level permissions minimal (e.g. `contents: read`) and move write scopes down to the specific jobs that need them.',
          workflow: input.workflow.path,
          evidence: writes.map((w) => ({ label: 'permissions', detail: `${w}: write` })),
          location,
        }),
      );
    }
  }

  // Per-job excessive write when the job appears read-only.
  let writeSeq = 1;
  for (const job of input.workflow.jobs) {
    if (input.context.ignoredJobs.has(job.id)) continue;
    const perms = job.permissions;
    if (!perms) continue;
    const writes = perms.blanket === 'write-all' ? ['(all scopes)'] : writeScopes(perms);
    if (writes.length === 0) continue;
    const jobWritesRepo = job.steps.some(
      (s) =>
        (s.run &&
          /git\s+push|gh\s+release|gh\s+pr\s+create|gh\s+issue|docker\s+push/.test(s.run)) ||
        (s.usesAction &&
          /release|create-pull-request|git-auto-commit|deploy|publish|pages-deploy/.test(
            s.usesAction,
          )),
    );
    if (!jobWritesRepo) {
      findings.push(
        makeFinding({
          rule: RULE_WRITE,
          seq: writeSeq++,
          kind: 'security',
          severity: 'medium',
          title: `Job \`${job.id}\` requests write permissions it may not need`,
          description: `Job \`${job.id}\` grants write permissions (${writes.join(', ')}), but no step appears to push, release, or otherwise write to GitHub. Excess token permissions increase risk if a dependency or step is compromised.`,
          recommendation:
            'Reduce this job to `contents: read` (or the minimal scopes it truly needs).',
          workflow: input.workflow.path,
          evidence: [{ label: `job ${job.id}`, detail: writes.join(', ') }],
          ...(job.location ? { location: job.location } : {}),
          jobs: [job.id],
        }),
      );
    }
  }

  // pull_request_target that checks out the PR head (dangerous pattern).
  if (input.workflow.triggers.events.includes('pull_request_target')) {
    let prtSeq = 1;
    for (const job of input.workflow.jobs) {
      if (input.context.ignoredJobs.has(job.id)) continue;
      const dangerousCheckout = job.steps.some(
        (s) =>
          s.usesAction === 'actions/checkout' &&
          s.with &&
          /(github\.event\.pull_request\.head|head\.sha|head\.ref)/.test(s.with['ref'] ?? ''),
      );
      if (dangerousCheckout) {
        findings.push(
          makeFinding({
            rule: RULE_PRT,
            seq: prtSeq++,
            kind: 'security',
            severity: 'critical',
            title: `\`pull_request_target\` checks out untrusted PR code in job \`${job.id}\``,
            description:
              'This workflow runs on `pull_request_target` (which has access to secrets and a write token) and checks out the pull-request head ref. Building or running that untrusted code can leak secrets or compromise the repository.',
            recommendation:
              "Do not check out and execute PR head code under `pull_request_target`. Use `pull_request` for untrusted code, or check out the base ref and avoid running PR-provided scripts. Review GitHub's guidance on `pull_request_target` before using it.",
            workflow: input.workflow.path,
            evidence: [{ label: `job ${job.id}`, detail: 'checkout ref references PR head' }],
            ...(job.location ? { location: job.location } : {}),
            jobs: [job.id],
          }),
        );
      }
    }
  }

  return findings;
}
