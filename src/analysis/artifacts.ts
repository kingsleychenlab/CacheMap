/**
 * Rule: artifact-flow analysis. Detects uploads never downloaded, broad
 * artifact paths, dependency folders uploaded as artifacts, excessive
 * retention, and duplicate artifact names across matrix jobs.
 */
import type { Finding } from '../types.js';
import type { AnalysisInput } from './framework.js';
import { makeFinding, inferredSavings, unknownSavings, measuredSavings } from './framework.js';
import { extractArtifacts } from '../parser/features.js';
import type { ArtifactRef } from '../parser/features.js';

const RULE_UNUSED = 'artifact-unused';
const RULE_BROAD = 'artifact-broad-path';
const RULE_DEPS = 'artifact-dependencies';
const RULE_RETENTION = 'artifact-excessive-retention';
const RULE_DUP = 'artifact-duplicate-name';

const DEFAULT_RETENTION_WARN_DAYS = 14;

function isDependencyPath(p: string): boolean {
  return /(^|\/)(node_modules|vendor\/bundle|\.venv|venv|target\/(debug|release)\/deps)(\/|$)/.test(
    p,
  );
}

function isBroadPath(p: string): boolean {
  const trimmed = p.trim();
  return trimmed === '.' || trimmed === './' || trimmed === '**' || trimmed === '**/*';
}

/** Historical artifact size for a named artifact, if present in history. */
function historicalSizeMb(): number | null {
  // Artifact byte sizes are not part of the run-timing history model we fetch;
  // returning null keeps size-based claims out unless real data is wired in.
  return null;
}

export function analyzeArtifacts(input: AnalysisInput): Finding[] {
  const findings: Finding[] = [];
  const jobs = input.workflow.jobs.filter((j) => !input.context.ignoredJobs.has(j.id));

  const uploads: ArtifactRef[] = [];
  const downloads: ArtifactRef[] = [];
  for (const job of jobs) {
    for (const a of extractArtifacts(job)) {
      if (a.kind === 'upload') uploads.push(a);
      else downloads.push(a);
    }
  }

  const downloadNames = new Set(downloads.map((d) => d.name));
  const hasWildcardDownload = downloads.some((d) => d.name === '*');

  // --- uploaded but never downloaded ------------------------------------
  let unusedSeq = 1;
  for (const up of uploads) {
    if (up.name.includes('${{')) continue; // can't reason about dynamic names
    const downloaded = downloadNames.has(up.name) || hasWildcardDownload;
    if (!downloaded) {
      const sizeMb = historicalSizeMb();
      const savings =
        sizeMb !== null
          ? measuredSavings(
              sizeMb * 0.05,
              sizeMb * 0.2,
              input.history?.runsAnalyzed ?? 0,
              `Based on measured artifact size (${sizeMb} MB) and typical upload throughput.`,
            )
          : inferredSavings(
              0,
              15,
              'Upper bound is the artifact upload time avoided; actual size is unknown without history. Inferred.',
            );
      findings.push(
        makeFinding({
          rule: RULE_UNUSED,
          seq: unusedSeq++,
          kind: 'performance',
          severity: 'medium',
          title: `Artifact \`${up.name}\` is uploaded but never downloaded`,
          description: `Job \`${up.jobId}\` uploads artifact \`${up.name}\`, but no job downloads it. Uploading an artifact that is never consumed wastes upload time and storage.`,
          recommendation:
            'Remove the upload if the artifact is not needed downstream, or if it is only used for debugging, gate it behind a condition and a short retention period.',
          workflow: input.workflow.path,
          evidence: [{ label: `job ${up.jobId}`, detail: `uploads: ${up.name}` }],
          ...(up.location ? { location: up.location } : {}),
          savings,
          jobs: [up.jobId],
        }),
      );
    }
  }

  // --- broad artifact paths ---------------------------------------------
  let broadSeq = 1;
  for (const up of uploads) {
    if (up.paths.some(isBroadPath)) {
      findings.push(
        makeFinding({
          rule: RULE_BROAD,
          seq: broadSeq++,
          kind: 'performance',
          severity: 'low',
          title: `Artifact \`${up.name}\` uploads an overly broad path`,
          description: `Job \`${up.jobId}\` uploads \`${up.name}\` with a broad path (${up.paths.join(', ')}), which likely includes far more than needed and increases upload time and storage.`,
          recommendation: 'Narrow the upload path to the specific files consumers need.',
          workflow: input.workflow.path,
          evidence: [{ label: `job ${up.jobId}`, detail: `path: ${up.paths.join(', ')}` }],
          ...(up.location ? { location: up.location } : {}),
          savings: unknownSavings(
            'Time impact depends on how much extra data is captured; needs history.',
          ),
          jobs: [up.jobId],
        }),
      );
    }
  }

  // --- dependency folders uploaded as artifacts -------------------------
  let depsSeq = 1;
  for (const up of uploads) {
    if (up.paths.some(isDependencyPath)) {
      findings.push(
        makeFinding({
          rule: RULE_DEPS,
          seq: depsSeq++,
          kind: 'performance',
          severity: 'medium',
          title: `Artifact \`${up.name}\` uploads a dependency directory`,
          description: `Job \`${up.jobId}\` uploads a dependency directory (${up.paths.filter(isDependencyPath).join(', ')}) as an artifact. Dependencies are usually better shared with a cache keyed on the lockfile than transferred as artifacts.`,
          recommendation:
            'Use `actions/cache` (or a setup-action built-in cache) for dependencies instead of upload/download-artifact, which avoids re-uploading them on every run.',
          workflow: input.workflow.path,
          evidence: [{ label: `job ${up.jobId}`, detail: `path: ${up.paths.join(', ')}` }],
          ...(up.location ? { location: up.location } : {}),
          savings: inferredSavings(
            5,
            30,
            'Caching typically restores dependencies faster than artifact download and avoids re-upload. Inferred.',
          ),
          jobs: [up.jobId],
        }),
      );
    }
  }

  // --- excessive retention ----------------------------------------------
  let retSeq = 1;
  for (const up of uploads) {
    if (up.retentionDays !== undefined && up.retentionDays > DEFAULT_RETENTION_WARN_DAYS) {
      findings.push(
        makeFinding({
          rule: RULE_RETENTION,
          seq: retSeq++,
          kind: 'performance',
          severity: 'low',
          title: `Artifact \`${up.name}\` has ${up.retentionDays}-day retention`,
          description: `Job \`${up.jobId}\` keeps artifact \`${up.name}\` for ${up.retentionDays} days. Long retention increases storage usage for artifacts that are usually only needed briefly.`,
          recommendation: 'Reduce `retention-days` for short-lived build/test artifacts.',
          workflow: input.workflow.path,
          evidence: [{ label: `job ${up.jobId}`, detail: `retention-days: ${up.retentionDays}` }],
          ...(up.location ? { location: up.location } : {}),
          savings: unknownSavings('Retention affects storage cost, not run time.'),
          jobs: [up.jobId],
        }),
      );
    }
  }

  // --- duplicate artifact names across matrix jobs ----------------------
  let dupSeq = 1;
  const uploadNameJobs = new Map<string, Set<string>>();
  for (const up of uploads) {
    if (up.name.includes('${{')) continue;
    const set = uploadNameJobs.get(up.name) ?? new Set<string>();
    set.add(up.jobId);
    uploadNameJobs.set(up.name, set);
  }
  for (const [name, jobSet] of uploadNameJobs) {
    // A matrix job uploading a constant name collides across variants.
    for (const jobId of jobSet) {
      const job = input.workflow.jobs.find((j) => j.id === jobId);
      const variants = input.variantsByJob.get(jobId) ?? [];
      if (job?.matrix && variants.length > 1 && !name.includes('${{')) {
        findings.push(
          makeFinding({
            rule: RULE_DUP,
            seq: dupSeq++,
            kind: 'performance',
            severity: 'medium',
            title: `Matrix job \`${jobId}\` uploads a constant artifact name \`${name}\``,
            description: `Job \`${jobId}\` runs ${variants.length} matrix combinations but uploads artifact \`${name}\` with a fixed name. Since upload-artifact v4, duplicate names within a run fail or overwrite; either way the per-variant results collide.`,
            recommendation:
              'Include a matrix value in the artifact name (e.g. `name: ' +
              name +
              '-${{ matrix.os }}-${{ matrix.version }}`) so each variant produces a distinct artifact.',
            workflow: input.workflow.path,
            evidence: [
              { label: `job ${jobId}`, detail: `${variants.length} variants upload \`${name}\`` },
            ],
            ...(job.location ? { location: job.location } : {}),
            savings: unknownSavings(
              'This is a correctness/collision issue, not a direct time saving.',
            ),
            jobs: [jobId],
          }),
        );
      }
    }
  }

  return findings;
}
