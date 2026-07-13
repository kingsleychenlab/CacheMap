/**
 * Rule: checkout inefficiency analysis for `actions/checkout`. Detects
 * unnecessary full history, repeated checkouts, needless submodule/LFS fetches,
 * and persisted credentials.
 */
import type { Finding } from '../types.js';
import type { AnalysisInput } from './framework.js';
import { makeFinding, inferredSavings, unknownSavings } from './framework.js';
import { extractCheckouts } from '../parser/features.js';

const RULE_FULL = 'checkout-full-history';
const RULE_REPEAT = 'checkout-repeated';
const RULE_SUBMODULES = 'checkout-submodules';
const RULE_LFS = 'checkout-lfs';
const RULE_CREDS = 'checkout-persist-credentials';

/** Heuristic: does any step in the job need full history or tags? */
function jobUsesHistory(jobSteps: { run?: string }[]): boolean {
  return jobSteps.some((s) => {
    if (!s.run) return false;
    return /git\s+(log|describe|rev-list|tag)\b|--tags\b|fetch-depth|git\s+merge-base|nx\s+affected|lerna\b|changesets?\b|semantic-release/.test(
      s.run,
    );
  });
}

export function analyzeCheckout(input: AnalysisInput): Finding[] {
  const findings: Finding[] = [];
  let fullSeq = 1;
  let repeatSeq = 1;
  let subSeq = 1;
  let lfsSeq = 1;
  let credsSeq = 1;

  for (const job of input.workflow.jobs) {
    if (input.context.ignoredJobs.has(job.id)) continue;
    const checkouts = extractCheckouts(job);
    if (checkouts.length === 0) continue;

    // Repeated checkout within a single job.
    if (checkouts.length > 1) {
      const first = checkouts[0];
      findings.push(
        makeFinding({
          rule: RULE_REPEAT,
          seq: repeatSeq++,
          kind: 'performance',
          severity: 'low',
          title: `Job \`${job.id}\` checks out the repository ${checkouts.length} times`,
          description: `Job \`${job.id}\` runs \`actions/checkout\` ${checkouts.length} times. Unless the steps deliberately reset the working tree, repeated checkouts duplicate work.`,
          recommendation:
            'Check out once at the start of the job unless a later checkout targets a different ref or path.',
          workflow: input.workflow.path,
          evidence: checkouts.map((c) => ({
            label: `job ${job.id}`,
            detail: `step ${c.stepIndex}`,
          })),
          ...(first?.location ? { location: first.location } : {}),
          savings: inferredSavings(
            3,
            10 * (checkouts.length - 1),
            'Each redundant checkout costs a few seconds. Inferred.',
          ),
          jobs: [job.id],
        }),
      );
    }

    const usesHistory = jobUsesHistory(job.steps);
    for (const checkout of checkouts) {
      // Full history when not needed.
      if (checkout.fetchDepth === '0' && !usesHistory) {
        findings.push(
          makeFinding({
            rule: RULE_FULL,
            seq: fullSeq++,
            kind: 'performance',
            severity: 'low',
            title: `Job \`${job.id}\` fetches full git history unnecessarily`,
            description: `\`actions/checkout\` uses \`fetch-depth: 0\` (full history) in job \`${job.id}\`, but no step in the job appears to use git history, tags, or merge-base information. Full history is slow to fetch on large repositories.`,
            recommendation:
              'Remove `fetch-depth: 0` (the default shallow checkout is faster) unless a step needs full history, tags, or merge-base — in which case keep it.',
            workflow: input.workflow.path,
            evidence: [{ label: `job ${job.id}`, detail: 'fetch-depth: 0' }],
            ...(checkout.location ? { location: checkout.location } : {}),
            savings: inferredSavings(
              0,
              30,
              'Upper bound is the extra fetch time on a large repository; small repos see little difference. Inferred.',
            ),
            jobs: [job.id],
          }),
        );
      }

      // Submodules fetched — flag only as a prompt to verify necessity.
      if (checkout.submodules === 'true' || checkout.submodules === 'recursive') {
        findings.push(
          makeFinding({
            rule: RULE_SUBMODULES,
            seq: subSeq++,
            kind: 'performance',
            severity: 'low',
            title: `Job \`${job.id}\` fetches submodules`,
            description: `\`actions/checkout\` fetches submodules (\`submodules: ${checkout.submodules}\`) in job \`${job.id}\`. If the job does not build or test submodule code, this adds avoidable fetch time.`,
            recommendation: 'Fetch submodules only in jobs that actually need them.',
            workflow: input.workflow.path,
            evidence: [{ label: `job ${job.id}`, detail: `submodules: ${checkout.submodules}` }],
            ...(checkout.location ? { location: checkout.location } : {}),
            savings: unknownSavings('Depends on submodule size; needs history.'),
            jobs: [job.id],
          }),
        );
      }

      // LFS fetched.
      if (checkout.lfs === true) {
        findings.push(
          makeFinding({
            rule: RULE_LFS,
            seq: lfsSeq++,
            kind: 'performance',
            severity: 'low',
            title: `Job \`${job.id}\` fetches Git LFS objects`,
            description: `\`actions/checkout\` fetches LFS objects in job \`${job.id}\`. If the job does not use large files, this adds avoidable download time and bandwidth.`,
            recommendation: 'Enable `lfs: true` only in jobs that need the large files.',
            workflow: input.workflow.path,
            evidence: [{ label: `job ${job.id}`, detail: 'lfs: true' }],
            ...(checkout.location ? { location: checkout.location } : {}),
            savings: unknownSavings('Depends on LFS object size; needs history.'),
            jobs: [job.id],
          }),
        );
      }

      // Credentials persisted when not needed.
      if (checkout.persistCredentials !== false) {
        // persist-credentials defaults to true. We only surface this as a
        // safety-adjacent note when the job does not push back to the repo.
        const pushesBack = job.steps.some(
          (s) =>
            s.run && /git\s+push|gh\s+release|gh\s+pr|softprops\/action-gh-release/.test(s.run),
        );
        const usesGitPushAction = job.steps.some(
          (s) =>
            s.usesAction && /git-auto-commit|create-pull-request|gh-release/.test(s.usesAction),
        );
        if (!pushesBack && !usesGitPushAction && checkout.persistCredentials === undefined) {
          findings.push(
            makeFinding({
              rule: RULE_CREDS,
              seq: credsSeq++,
              kind: 'security',
              severity: 'low',
              title: `Job \`${job.id}\` persists checkout credentials`,
              description: `\`actions/checkout\` persists the GitHub token in the local git config by default. Job \`${job.id}\` does not appear to push back to the repository, so persisting credentials widens the token's exposure to later steps unnecessarily.`,
              recommendation:
                'Set `persist-credentials: false` on `actions/checkout` in jobs that do not push to the repository.',
              workflow: input.workflow.path,
              evidence: [
                {
                  label: `job ${job.id}`,
                  detail: 'persist-credentials not set (defaults to true)',
                },
              ],
              ...(checkout.location ? { location: checkout.location } : {}),
              jobs: [job.id],
            }),
          );
        }
      }
    }
  }

  return findings;
}
