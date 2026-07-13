/**
 * High-level analysis engine that ties together repository detection, workflow
 * discovery/parsing, optional GitHub history, the analysis rules, and report
 * assembly. Used by every CLI command and by the GitHub Action so behaviour is
 * identical across entrypoints.
 */
import { resolve } from 'node:path';
import type {
  WorkflowModel,
  AnalysisContext,
  HistoryData,
  JobTiming,
  CacheStats,
} from './types.js';
import type { ResolvedConfig } from './config.js';
import type { ReportBundle } from './reports/model.js';
import type { AnalyzeWorkflowResult } from './analysis/runner.js';
import type { GitInfo } from './git/repo.js';
import { detectRepo } from './git/repo.js';
import { discoverWorkflows, resolveWorkflowPath } from './git/discovery.js';
import { parseWorkflow, WorkflowParseError } from './parser/workflow.js';
import { analyzeWorkflow } from './analysis/runner.js';
import { GitHubClient, GitHubError, parseRepo, resolveToken } from './github/client.js';
import { fetchRunTimings } from './github/runs.js';
import { fetchCaches } from './github/caches.js';
import { aggregateByBaseName, mapTimingsToJobs } from './github/history.js';
import { readFileSync } from 'node:fs';
import { VERSION, TOOL_NAME } from './version.js';

export interface EngineOptions {
  cwd: string;
  /** Explicit workflow path arguments (CLI). */
  workflows?: string[];
  offline: boolean;
  token?: string;
  /** owner/repo override. */
  repo?: string;
  ref?: string;
  runs?: number;
  config: ResolvedConfig;
  verbose?: boolean;
  /** Sink for progress/verbose messages. */
  log?: (message: string) => void;
}

export interface EngineResult {
  bundle: ReportBundle;
  results: AnalyzeWorkflowResult[];
  gitInfo: GitInfo | null;
  /** Parsed models, including those with no findings. */
  workflows: WorkflowModel[];
}

function noop(): void {
  /* no-op logger */
}

/** Run the full engine and return an assembled report bundle. */
export async function runEngine(options: EngineOptions): Promise<EngineResult> {
  const log = options.verbose ? (options.log ?? ((m: string) => console.error(m))) : noop;
  const warnings: string[] = [];
  const gitInfo = detectRepo(options.cwd);
  const root = gitInfo?.root ?? options.cwd;
  if (!gitInfo) {
    warnings.push('Not inside a detected git repository; using the current directory as the root.');
  }

  // --- resolve the set of workflows to analyze --------------------------
  const workflowPaths = resolveWorkflowSet(options, root, warnings, log);
  if (workflowPaths.length === 0) {
    warnings.push('No workflow files found under .github/workflows/.');
  }

  // --- parse --------------------------------------------------------------
  const models: WorkflowModel[] = [];
  for (const wf of workflowPaths) {
    try {
      const contents = readFileSync(wf.absolutePath, 'utf8');
      models.push(parseWorkflow(contents, wf.relativePath));
    } catch (err) {
      if (err instanceof WorkflowParseError) {
        warnings.push(`Skipped ${wf.relativePath}: ${err.message}`);
      } else {
        warnings.push(
          `Skipped ${wf.relativePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // --- optional history ---------------------------------------------------
  const timings = new Map<string, Map<string, JobTiming>>();
  let cacheStats: CacheStats[] | undefined;
  const histories = new Map<string, HistoryData>();
  let usedHistory = false;

  const repoSlug = options.repo ?? gitInfo?.remoteSlug ?? null;
  const token = resolveToken(options.token);

  if (!options.offline && repoSlug && token) {
    log(`Fetching historical data for ${repoSlug}…`);
    try {
      const client = new GitHubClient({ token });
      const repoRef = parseRepo(repoSlug);
      const runs = options.runs ?? options.config.historyRuns;

      const cacheResult = await fetchCaches(client, repoRef);
      if (cacheResult.unavailable) {
        warnings.push('Cache metadata was unavailable (insufficient permissions or none exist).');
      } else {
        cacheStats = cacheResult.caches;
      }

      for (const model of models) {
        try {
          const samples = await fetchRunTimings(client, repoRef, {
            workflowPath: model.path,
            runs,
            ...(options.ref ? { branch: options.ref } : {}),
          });
          if (samples.length === 0) {
            warnings.push(`No historical runs found for ${model.path}.`);
            continue;
          }
          const byBase = aggregateByBaseName(samples);
          const mapped = mapTimingsToJobs(model, byBase);
          if (mapped.size > 0) {
            timings.set(model.path, mapped);
            usedHistory = true;
          }
          histories.set(model.path, {
            repo: repoSlug,
            workflowFile: model.path,
            runsAnalyzed: new Set(samples.map((s) => s.runId)).size,
            jobSamples: samples,
            caches: cacheStats ?? [],
            cacheDataUnavailable: cacheResult.unavailable,
          });
        } catch (err) {
          warnings.push(
            `History for ${model.path} unavailable: ${
              err instanceof GitHubError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : String(err)
            }`,
          );
        }
      }
    } catch (err) {
      warnings.push(
        `Historical data unavailable: ${err instanceof Error ? err.message : String(err)}. Continuing with static analysis.`,
      );
    }
  } else if (!options.offline && !token) {
    log('No GitHub token available; running static analysis only.');
  } else if (!options.offline && !repoSlug) {
    warnings.push('Could not determine owner/repo; pass --repo to enable historical analysis.');
  }

  // --- analyze ------------------------------------------------------------
  const context: AnalysisContext = {
    workflowPaths: models.map((m) => m.path),
    ...(timings.size > 0 ? { timings } : {}),
    ...(cacheStats ? { cacheStats } : {}),
    offline: options.offline,
    ignoredRules: new Set(options.config.ignoreRules),
    ignoredJobs: new Set(options.config.ignoreJobs),
    minimumSavingsSeconds: options.config.minimumSavingsSeconds,
    cost: {
      linuxPerMinute: options.config.cost.linuxPerMinute,
      macosPerMinute: options.config.cost.macosPerMinute,
      windowsPerMinute: options.config.cost.windowsPerMinute,
    },
  };

  const results: AnalyzeWorkflowResult[] = models.map((model) =>
    analyzeWorkflow(model, context, histories.get(model.path)),
  );

  const bundle: ReportBundle = {
    tool: { name: TOOL_NAME, version: VERSION },
    generatedAt: new Date().toISOString(),
    offline: options.offline,
    repo: repoSlug,
    usedHistory,
    workflows: results.map((r) => r.analysis),
    warnings,
  };

  return { bundle, results, gitInfo, workflows: models };
}

function resolveWorkflowSet(
  options: EngineOptions,
  root: string,
  warnings: string[],
  log: (m: string) => void,
): ReturnType<typeof discoverWorkflows> {
  // Explicit CLI paths take precedence.
  if (options.workflows && options.workflows.length > 0) {
    const out: ReturnType<typeof discoverWorkflows> = [];
    for (const input of options.workflows) {
      try {
        out.push(resolveWorkflowPath(root, input, options.cwd));
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : String(err));
      }
    }
    return out;
  }
  // Config-specified workflows next.
  if (options.config.workflows.length > 0) {
    log(`Using ${options.config.workflows.length} workflow(s) from config.`);
    const out: ReturnType<typeof discoverWorkflows> = [];
    for (const input of options.config.workflows) {
      try {
        out.push(resolveWorkflowPath(root, resolve(root, input), options.cwd));
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : String(err));
      }
    }
    return out;
  }
  // Otherwise discover everything.
  return discoverWorkflows(root);
}
