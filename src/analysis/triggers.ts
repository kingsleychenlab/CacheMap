/**
 * Rule: trigger (`on:`) inefficiency analysis. Detects missing path filters,
 * duplicate push/PR execution, over-frequent schedules, and missing
 * concurrency cancellation for superseded PR runs.
 */
import type { Finding } from '../types.js';
import type { AnalysisInput } from './framework.js';
import { makeFinding, inferredSavings, unknownSavings } from './framework.js';

const RULE_PATHS = 'trigger-missing-path-filter';
const RULE_DUP = 'trigger-duplicate-push-pr';
const RULE_SCHEDULE = 'trigger-frequent-schedule';
const RULE_CONCURRENCY = 'trigger-missing-concurrency';

/** Parse the minute field of a cron expression to detect sub-hourly schedules. */
function scheduleTooFrequent(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const minute = parts[0] ?? '*';
  const hour = parts[1] ?? '*';
  // e.g. "*/5 * * * *" or "* * * * *" run many times per hour.
  if (minute === '*' || /^\*\/([1-9]|[1-5]\d)$/.test(minute)) {
    const m = /^\*\/(\d+)$/.exec(minute);
    if (minute === '*') return true;
    if (m && Number(m[1]) < 30) return true;
  }
  // Multiple explicit minutes within an hour with wildcard hour.
  if (hour === '*' && minute.includes(',')) return true;
  return false;
}

export function analyzeTriggers(input: AnalysisInput): Finding[] {
  const findings: Finding[] = [];
  const triggers = input.workflow.triggers;
  const location = { file: input.workflow.path };

  const hasPush = triggers.events.includes('push');
  const hasPr =
    triggers.events.includes('pull_request') || triggers.events.includes('pull_request_target');

  // --- missing path filter on push/PR of a build-heavy workflow ----------
  const pushHasPaths = Boolean(triggers.push?.paths || triggers.push?.pathsIgnore);
  const prHasPaths = Boolean(triggers.pullRequest?.paths || triggers.pullRequest?.pathsIgnore);
  const jobCount = input.workflow.jobs.length;
  if ((hasPush && !pushHasPaths) || (hasPr && !prHasPaths)) {
    if (jobCount > 0) {
      findings.push(
        makeFinding({
          rule: RULE_PATHS,
          seq: 1,
          kind: 'performance',
          severity: 'low',
          title: 'Workflow runs on all changes with no path filter',
          description:
            'This workflow triggers on push/pull_request without `paths` or `paths-ignore` filters, so it runs even for documentation-only or unrelated changes.',
          recommendation:
            'Add `paths`/`paths-ignore` filters (or `paths-ignore: [ "**.md", "docs/**" ]`) so the workflow only runs when relevant files change. Keep required status checks in mind — filtered-out runs report as skipped.',
          workflow: input.workflow.path,
          evidence: [{ label: 'on', detail: triggers.events.join(', ') }],
          location,
          savings: unknownSavings(
            'Savings depend on how many irrelevant changes trigger the workflow; needs history.',
          ),
        }),
      );
    }
  }

  // --- duplicate push + pull_request on the same branches ---------------
  if (hasPush && hasPr) {
    const pushBranches = new Set(triggers.push?.branches ?? []);
    const prBranches = new Set(triggers.pullRequest?.branches ?? []);
    const overlap = [...pushBranches].filter((b) => prBranches.has(b));
    // The classic double-run: push to a branch that also has an open PR.
    if (pushBranches.size === 0 || overlap.length > 0) {
      findings.push(
        makeFinding({
          rule: RULE_DUP,
          seq: 1,
          kind: 'performance',
          severity: 'medium',
          title: 'Push and pull_request triggers may double-run the workflow',
          description:
            'The workflow runs on both `push` and `pull_request`. For branches with an open pull request, both events fire, running the entire workflow twice for the same commit.',
          recommendation:
            'Restrict `push` to protected branches (e.g. `branches: [main]`) and rely on `pull_request` for feature branches, or add a concurrency group that cancels superseded runs.',
          workflow: input.workflow.path,
          evidence: [
            { label: 'push', detail: [...pushBranches].join(', ') || 'all branches' },
            { label: 'pull_request', detail: [...prBranches].join(', ') || 'all branches' },
          ],
          location,
          savings: inferredSavings(
            0,
            Math.round(input.criticalPath.totalSeconds),
            `Upper bound is one full duplicate run (~${Math.round(input.criticalPath.totalSeconds)}s ${input.criticalPath.timingSource}) avoided per PR commit. Inferred.`,
          ),
        }),
      );
    }
  }

  // --- over-frequent schedule -------------------------------------------
  let schedSeq = 1;
  for (const s of triggers.schedule ?? []) {
    if (scheduleTooFrequent(s.cron)) {
      findings.push(
        makeFinding({
          rule: RULE_SCHEDULE,
          seq: schedSeq++,
          kind: 'performance',
          severity: 'low',
          title: `Scheduled trigger runs very frequently (\`${s.cron}\`)`,
          description: `The cron schedule \`${s.cron}\` runs the workflow many times per hour, which can consume significant compute for little benefit.`,
          recommendation:
            'Increase the schedule interval unless high frequency is genuinely required.',
          workflow: input.workflow.path,
          evidence: [{ label: 'schedule', detail: s.cron }],
          location,
          savings: unknownSavings(
            'Depends on run duration and how much can be spaced out; needs history.',
          ),
        }),
      );
    }
  }

  // --- missing concurrency cancellation for PRs -------------------------
  const cancels =
    input.workflow.concurrency?.cancelInProgress === true ||
    (typeof input.workflow.concurrency?.cancelInProgress === 'string' &&
      input.workflow.concurrency.cancelInProgress.includes('${{'));
  if (hasPr && !cancels) {
    findings.push(
      makeFinding({
        rule: RULE_CONCURRENCY,
        seq: 1,
        kind: 'performance',
        severity: 'medium',
        title: 'No concurrency cancellation for superseded pull-request runs',
        description:
          'This pull-request workflow has no `concurrency` group with `cancel-in-progress: true`, so pushing new commits to a PR leaves outdated runs executing to completion alongside the new one.',
        recommendation:
          'Add:\nconcurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\nso a new push cancels the in-progress run for the same ref.',
        workflow: input.workflow.path,
        evidence: [
          {
            label: 'concurrency',
            detail: input.workflow.concurrency
              ? 'present but cancel-in-progress not enabled'
              : 'not configured',
          },
        ],
        location,
        savings: inferredSavings(
          0,
          Math.round(input.criticalPath.totalSeconds),
          `Upper bound is one full superseded run (~${Math.round(input.criticalPath.totalSeconds)}s ${input.criticalPath.timingSource}) avoided per rapid push. Inferred.`,
        ),
      }),
    );
  }

  return findings;
}
