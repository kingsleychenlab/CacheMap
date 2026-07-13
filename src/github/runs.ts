/**
 * Fetch historical workflow-run timing. For each recent completed run of a
 * workflow we read the per-job start/finish times and record real durations.
 * These are the only "measured" numbers CacheMap ever reports.
 */
import type { GitHubClient, RepoRef } from './client.js';
import type { RunTimingSample } from '../types.js';
import { resolveWorkflow } from './workflows.js';

export interface FetchRunsOptions {
  /** Repository-relative workflow path. */
  workflowPath: string;
  /** Maximum number of runs to analyze. */
  runs: number;
  /** Optional branch filter. */
  branch?: string;
}

function durationSeconds(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / 1000;
}

/**
 * Fetch per-job timing samples for the most recent completed runs of a
 * workflow. Bounded by `runs` and the client's page limit.
 */
export async function fetchRunTimings(
  client: GitHubClient,
  repo: RepoRef,
  options: FetchRunsOptions,
): Promise<RunTimingSample[]> {
  const workflow = await resolveWorkflow(client, repo, options.workflowPath);
  const perPage = Math.min(100, Math.max(1, options.runs));

  // Collect run ids (completed only) up to the requested count.
  const runIds: { id: number; createdAt: string }[] = [];
  for (let page = 1; page <= client.maxPages && runIds.length < options.runs; page++) {
    const resp = await client.request((o) =>
      o.rest.actions.listWorkflowRuns({
        owner: repo.owner,
        repo: repo.repo,
        workflow_id: workflow.id,
        status: 'completed',
        per_page: perPage,
        page,
        ...(options.branch ? { branch: options.branch } : {}),
      }),
    );
    const runs = resp.data.workflow_runs;
    if (runs.length === 0) break;
    for (const run of runs) {
      if (runIds.length >= options.runs) break;
      runIds.push({ id: run.id, createdAt: run.created_at });
    }
  }

  const samples: RunTimingSample[] = [];
  for (const run of runIds) {
    const jobs = await client.paginate(async (page) => {
      const resp = await client.request((o) =>
        o.rest.actions.listJobsForWorkflowRun({
          owner: repo.owner,
          repo: repo.repo,
          run_id: run.id,
          per_page: 100,
          page,
          filter: 'latest',
        }),
      );
      return resp.data.jobs;
    });
    for (const job of jobs) {
      const seconds = durationSeconds(job.started_at ?? null, job.completed_at ?? null);
      if (seconds === null) continue;
      samples.push({
        runId: run.id,
        jobId: job.name,
        jobName: job.name,
        seconds,
        conclusion: job.conclusion ?? 'unknown',
        createdAt: run.createdAt,
      });
    }
  }

  return samples;
}
