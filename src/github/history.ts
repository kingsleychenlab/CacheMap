/**
 * Aggregate raw historical run samples into measured per-job timings and map
 * them onto the parsed workflow's job ids. Matrix variants (job names like
 * "test (ubuntu-latest, 20)") are collapsed to their base job.
 *
 * A job in a run finishes only when all its matrix variants finish, so within a
 * run we take the slowest variant; across runs we average those per-run maxima.
 */
import type { RunTimingSample, JobTiming, WorkflowModel, HistoryData } from '../types.js';

/** Strip a matrix suffix from a GitHub job display name. */
export function baseJobName(name: string): string {
  const idx = name.indexOf(' (');
  return idx > 0 ? name.slice(0, idx) : name;
}

/**
 * Aggregate samples into per-base-name measured timings.
 * Returns a map keyed by base job name.
 */
export function aggregateByBaseName(samples: RunTimingSample[]): Map<string, JobTiming> {
  // run id -> base name -> max seconds among that run's variants
  const perRun = new Map<number, Map<string, number>>();
  for (const sample of samples) {
    if (sample.conclusion !== 'success') continue; // only successful runs are representative
    const base = baseJobName(sample.jobName);
    const runMap = perRun.get(sample.runId) ?? new Map<string, number>();
    runMap.set(base, Math.max(runMap.get(base) ?? 0, sample.seconds));
    perRun.set(sample.runId, runMap);
  }

  // base name -> list of per-run maxima
  const collected = new Map<string, number[]>();
  const runsSeen = new Map<string, Set<number>>();
  for (const [runId, runMap] of perRun) {
    for (const [base, seconds] of runMap) {
      const list = collected.get(base) ?? [];
      list.push(seconds);
      collected.set(base, list);
      const seen = runsSeen.get(base) ?? new Set<number>();
      seen.add(runId);
      runsSeen.set(base, seen);
    }
  }

  const out = new Map<string, JobTiming>();
  for (const [base, list] of collected) {
    const avg = list.reduce((a, b) => a + b, 0) / list.length;
    out.set(base, {
      jobId: base,
      seconds: Math.round(avg),
      source: 'historical',
      confidence: 'measured',
      runsAnalyzed: runsSeen.get(base)?.size ?? list.length,
    });
  }
  return out;
}

/**
 * Map aggregated base-name timings onto the workflow's job ids. A job matches
 * by its `name` (if set) or its id.
 */
export function mapTimingsToJobs(
  workflow: WorkflowModel,
  byBaseName: Map<string, JobTiming>,
): Map<string, JobTiming> {
  const out = new Map<string, JobTiming>();
  for (const job of workflow.jobs) {
    const candidates = [job.name, job.id].filter((c): c is string => Boolean(c));
    for (const candidate of candidates) {
      const timing = byBaseName.get(candidate);
      if (timing) {
        out.set(job.id, { ...timing, jobId: job.id });
        break;
      }
    }
  }
  return out;
}

/** Summary statistics for the `history` command output. */
export interface HistorySummary {
  base: string;
  averageSeconds: number;
  minSeconds: number;
  maxSeconds: number;
  runsAnalyzed: number;
}

export function summarizeHistory(history: HistoryData): HistorySummary[] {
  const byBase = new Map<string, { seconds: number[]; runs: Set<number> }>();
  for (const sample of history.jobSamples) {
    const base = baseJobName(sample.jobName);
    const entry = byBase.get(base) ?? { seconds: [], runs: new Set<number>() };
    entry.seconds.push(sample.seconds);
    entry.runs.add(sample.runId);
    byBase.set(base, entry);
  }
  const out: HistorySummary[] = [];
  for (const [base, entry] of byBase) {
    const avg = entry.seconds.reduce((a, b) => a + b, 0) / entry.seconds.length;
    out.push({
      base,
      averageSeconds: Math.round(avg),
      minSeconds: Math.round(Math.min(...entry.seconds)),
      maxSeconds: Math.round(Math.max(...entry.seconds)),
      runsAnalyzed: entry.runs.size,
    });
  }
  out.sort((a, b) => b.averageSeconds - a.averageSeconds);
  return out;
}
