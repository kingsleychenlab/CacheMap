/**
 * Rule: repeated dependency installation and identical commands across jobs.
 *
 * Detects the same dependency-install signature (e.g. `npm ci`) appearing in
 * multiple jobs without a shared preparation job, and identical `run` commands
 * duplicated across jobs. Savings are conservative and clearly inferred.
 */
import type { Finding } from '../types.js';
import type { AnalysisInput } from './framework.js';
import { makeFinding, inferredSavings } from './framework.js';
import { extractDependencyInstalls, extractCaches, normalizeCommand } from '../parser/features.js';
import { ESTIMATE } from '../graph/estimate.js';

const RULE = 'repeated-dependency-install';
const RULE_CMD = 'repeated-command';

interface InstallGroup {
  signature: string;
  ecosystem: string;
  jobs: string[];
  firstLocation?: Finding['location'];
}

export function analyzeRepeatedWork(input: AnalysisInput): Finding[] {
  const findings: Finding[] = [];
  const jobs = input.workflow.jobs.filter((j) => !input.context.ignoredJobs.has(j.id));

  // --- Repeated dependency installation ---------------------------------
  const groups = new Map<string, InstallGroup>();
  const jobsWithCacheForEcosystem = new Map<string, Set<string>>();

  for (const job of jobs) {
    const installs = extractDependencyInstalls(job);
    const caches = extractCaches(job);
    const seenSignaturesInJob = new Set<string>();
    for (const install of installs) {
      if (seenSignaturesInJob.has(install.signature)) continue;
      seenSignaturesInJob.add(install.signature);
      const group = groups.get(install.signature) ?? {
        signature: install.signature,
        ecosystem: install.ecosystem,
        jobs: [],
        ...(install.location ? { firstLocation: install.location } : {}),
      };
      group.jobs.push(job.id);
      groups.set(install.signature, group);
    }
    // Track which jobs have some cache configured (rough ecosystem match).
    if (caches.length > 0) {
      const set = jobsWithCacheForEcosystem.get(job.id) ?? new Set<string>();
      for (const c of caches) set.add(c.builtInTool ?? 'explicit');
      jobsWithCacheForEcosystem.set(job.id, set);
    }
  }

  let seq = 1;
  for (const group of groups.values()) {
    if (group.jobs.length < 2) continue;
    const extraJobs = group.jobs.length - 1;
    const jobsWithoutCache = group.jobs.filter((j) => !jobsWithCacheForEcosystem.has(j));
    const anyCached = group.jobs.length - jobsWithoutCache.length > 0;

    // Conservative savings: with a shared prep job (or a cache reused across
    // jobs) the redundant installs shrink toward a warm-cache restore.
    const minPer = anyCached ? 8 : 15;
    const maxPer = ESTIMATE.dependencyInstallSeconds;
    const severity = group.jobs.length >= 3 ? 'high' : 'medium';

    findings.push(
      makeFinding({
        rule: RULE,
        seq: seq++,
        kind: 'performance',
        severity,
        title: `${group.ecosystem} dependencies installed in ${group.jobs.length} jobs`,
        description:
          `The dependency-install command "${group.signature}" runs in ${group.jobs.length} ` +
          `separate jobs. Without a shared dependency-preparation job or a cache reused across ` +
          `jobs, each job pays the full installation cost.`,
        recommendation:
          'Create one dependency-preparation job (or reuse a dependency cache keyed by ' +
          'lockfile, OS, architecture, and runtime version) and have downstream jobs restore ' +
          'from it instead of installing from scratch.',
        workflow: input.workflow.path,
        evidence: group.jobs.map((j) => ({ label: j })),
        ...(group.firstLocation ? { location: group.firstLocation } : {}),
        savings: inferredSavings(
          extraJobs * minPer,
          extraJobs * maxPer,
          `Static estimate: ${extraJobs} redundant install(s) × ${minPer}-${maxPer}s per install ` +
            `(${anyCached ? 'some jobs already cache dependencies' : 'no dependency cache detected'}). ` +
            'No historical timing available.',
        ),
        jobs: group.jobs,
        details: {
          signature: group.signature,
          ecosystem: group.ecosystem,
          jobsWithCache: String(group.jobs.length - jobsWithoutCache.length),
        },
      }),
    );
  }

  // --- Identical run commands across jobs --------------------------------
  const commandJobs = new Map<
    string,
    { jobs: Set<string>; sample: string; location?: Finding['location'] }
  >();
  for (const job of jobs) {
    for (const step of job.steps) {
      if (!step.run) continue;
      const normalized = normalizeCommand(step.run);
      if (normalized.length < 8) continue; // ignore trivial one-liners
      const entry = commandJobs.get(normalized) ?? {
        jobs: new Set<string>(),
        sample: step.run.split('\n')[0]?.trim() ?? normalized,
        ...(step.location ? { location: step.location } : {}),
      };
      entry.jobs.add(job.id);
      commandJobs.set(normalized, entry);
    }
  }

  let cmdSeq = 1;
  for (const entry of commandJobs.values()) {
    if (entry.jobs.size < 3) continue; // only flag broad duplication
    const jobList = [...entry.jobs];
    findings.push(
      makeFinding({
        rule: RULE_CMD,
        seq: cmdSeq++,
        kind: 'performance',
        severity: 'low',
        title: `Identical command repeated across ${jobList.length} jobs`,
        description:
          `The command \`${entry.sample}\` (and its script) is duplicated across ${jobList.length} ` +
          'jobs. Duplicated build/setup work is a common source of wasted CI minutes.',
        recommendation:
          'Consider consolidating shared setup into a composite action or a single upstream job, ' +
          'or verify the repetition is intentional.',
        workflow: input.workflow.path,
        evidence: jobList.map((j) => ({ label: j })),
        ...(entry.location ? { location: entry.location } : {}),
        savings: inferredSavings(
          0,
          (jobList.length - 1) * ESTIMATE.genericRunStepSeconds,
          `Upper bound assumes each of ${jobList.length - 1} duplicate executions could be ` +
            'eliminated; the actual overlap depends on whether outputs are reused. Inferred, no history.',
        ),
        jobs: jobList,
      }),
    );
  }

  return findings;
}
