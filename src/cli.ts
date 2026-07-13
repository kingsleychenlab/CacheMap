#!/usr/bin/env node
/**
 * CacheMap command-line interface.
 *
 * Commands: analyze, history, graph, explain, report, doctor, init, schema.
 * Exit codes: 0 = no finding at/above threshold, 1 = threshold exceeded,
 * 2 = invalid input / configuration / analysis failure.
 */
import { Command } from 'commander';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runEngine } from './engine.js';
import type { EngineOptions } from './engine.js';
import { VERSION, TOOL_NAME } from './version.js';
import { renderTextReport } from './reports/text.js';
import { renderJsonReport } from './reports/json.js';
import { renderMarkdownReport } from './reports/markdown.js';
import { renderSarifReport } from './reports/sarif.js';
import { renderMermaid, renderDot, renderGraphJson } from './reports/graph.js';
import { configJsonSchema } from './config.js';
import { JSON_SCHEMA_VERSION } from './reports/model.js';
import {
  CliError,
  loadCliConfig,
  validateFormat,
  validateFailOn,
  emit,
  computeExitCode,
  parsePositiveInt,
  shouldUseColor,
  REPORT_FORMATS,
  GRAPH_FORMATS,
} from './cli/shared.js';
import { GitHubClient, GitHubError, parseRepo, resolveToken } from './github/client.js';
import { detectRepo } from './git/repo.js';
import { fetchRunTimings } from './github/runs.js';
import { fetchCaches } from './github/caches.js';
import { summarizeHistory, aggregateByBaseName } from './github/history.js';
import { formatDuration } from './reports/model.js';
import type { HistoryData } from './types.js';

interface CommonOpts {
  repo?: string;
  workflow?: string;
  ref?: string;
  runs?: string;
  token?: string;
  color?: boolean;
  offline?: boolean;
  verbose?: boolean;
  config?: string;
}

function buildEngineOptions(
  cwd: string,
  workflowArg: string | undefined,
  opts: CommonOpts,
): EngineOptions {
  const config = loadCliConfig(cwd, opts.config);
  const workflows: string[] = [];
  if (workflowArg) workflows.push(workflowArg);
  if (opts.workflow) workflows.push(opts.workflow);
  const runs = parsePositiveInt(opts.runs, '--runs');
  return {
    cwd,
    ...(workflows.length > 0 ? { workflows } : {}),
    offline: Boolean(opts.offline),
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.repo ? { repo: opts.repo } : {}),
    ...(opts.ref ? { ref: opts.ref } : {}),
    ...(runs !== undefined ? { runs } : {}),
    config,
    ...(opts.verbose ? { verbose: true } : {}),
  };
}

function addCommonOptions(cmd: Command): Command {
  return cmd
    .option('--repo <owner/repo>', 'GitHub repository for historical data')
    .option('--workflow <name-or-path>', 'restrict analysis to one workflow')
    .option('--ref <git-ref>', 'branch/ref filter for historical runs')
    .option('--runs <number>', 'number of historical runs to analyze')
    .option('--token <token>', 'GitHub token (or set GITHUB_TOKEN)')
    .option('--no-color', 'disable coloured output')
    .option('--offline', 'never contact GitHub; static analysis only')
    .option('--verbose', 'verbose progress output')
    .option('--config <path>', 'path to a .cachemap.yml config file');
}

// --------------------------------------------------------------------------
// analyze / report
// --------------------------------------------------------------------------

async function runAnalyzeLike(
  workflowArg: string | undefined,
  opts: CommonOpts & { format?: string; output?: string; failOn?: string },
  defaultFormat: 'text' | 'markdown',
): Promise<number> {
  const cwd = process.cwd();
  const engineOptions = buildEngineOptions(cwd, workflowArg, opts);
  const format = validateFormat(opts.format, REPORT_FORMATS, defaultFormat);
  const failOn = validateFailOn(opts.failOn, engineOptions.config.failOn);

  const { bundle } = await runEngine(engineOptions);

  let content: string;
  switch (format) {
    case 'text':
      content = renderTextReport(bundle, shouldUseColor(opts.color) && !opts.output);
      break;
    case 'json':
      content = renderJsonReport(bundle);
      break;
    case 'markdown':
      content = renderMarkdownReport(bundle);
      break;
    case 'sarif':
      content = renderSarifReport(bundle);
      break;
  }

  emit(content, opts.output, cwd);
  return computeExitCode(bundle, failOn);
}

// --------------------------------------------------------------------------
// graph
// --------------------------------------------------------------------------

async function runGraph(
  workflowArg: string | undefined,
  opts: CommonOpts & { format?: string; output?: string },
): Promise<number> {
  const cwd = process.cwd();
  const engineOptions = buildEngineOptions(cwd, workflowArg, opts);
  const format = validateFormat(opts.format, GRAPH_FORMATS, 'mermaid');
  const { results } = await runEngine(engineOptions);

  if (results.length === 0) {
    throw new CliError('No workflows to graph.', 2);
  }

  const parts: string[] = [];
  for (const result of results) {
    const graph = result.input.graph;
    switch (format) {
      case 'mermaid':
        parts.push(`%% ${graph.workflowName}`, renderMermaid(graph));
        break;
      case 'dot':
        parts.push(renderDot(graph));
        break;
      case 'json':
        parts.push(renderGraphJson(graph));
        break;
    }
  }

  emit(parts.join('\n\n'), opts.output, cwd);
  return 0;
}

// --------------------------------------------------------------------------
// explain
// --------------------------------------------------------------------------

async function runExplain(findingId: string, opts: CommonOpts): Promise<number> {
  const cwd = process.cwd();
  const engineOptions = buildEngineOptions(cwd, undefined, opts);
  const { bundle } = await runEngine(engineOptions);

  for (const w of bundle.workflows) {
    const finding = w.findings.find((f) => f.id === findingId);
    if (!finding) continue;
    const lines: string[] = [];
    lines.push(`${finding.severity.toUpperCase()}  ${finding.title}`);
    lines.push(`id: ${finding.id}`);
    lines.push(`rule: ${finding.rule}`);
    lines.push(`kind: ${finding.kind}`);
    lines.push(`workflow: ${finding.workflow}`);
    if (finding.location?.line)
      lines.push(`location: ${finding.location.file}:${finding.location.line}`);
    lines.push('');
    lines.push('Description:');
    lines.push(`  ${finding.description}`);
    lines.push('');
    lines.push('Evidence:');
    for (const ev of finding.evidence)
      lines.push(`  - ${ev.label}${ev.detail ? ` (${ev.detail})` : ''}`);
    if (finding.savings) {
      lines.push('');
      lines.push('Timing / savings:');
      lines.push(`  confidence: ${finding.savings.confidence}`);
      lines.push(`  source: ${finding.savings.source}`);
      lines.push(`  runs analyzed: ${finding.savings.runsAnalyzed}`);
      if (finding.savings.maxSeconds > 0) {
        lines.push(
          `  estimated avoidable: ${formatDuration(finding.savings.minSeconds)}–${formatDuration(finding.savings.maxSeconds)}`,
        );
      }
      lines.push(`  method: ${finding.savings.method}`);
    }
    if (finding.details) {
      lines.push('');
      lines.push('Details:');
      for (const [k, v] of Object.entries(finding.details)) lines.push(`  ${k}: ${v}`);
    }
    lines.push('');
    lines.push('Recommendation:');
    for (const rline of finding.recommendation.split('\n')) lines.push(`  ${rline}`);
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }

  const available = bundle.workflows.flatMap((w) => w.findings.map((f) => f.id));
  throw new CliError(
    `No finding with id "${findingId}". ${
      available.length ? `Available ids: ${available.join(', ')}` : 'No findings were produced.'
    }`,
    2,
  );
}

// --------------------------------------------------------------------------
// history
// --------------------------------------------------------------------------

async function runHistory(
  opts: CommonOpts & { format?: string; output?: string },
): Promise<number> {
  const cwd = process.cwd();
  if (opts.offline)
    throw new CliError('`history` requires network access; do not pass --offline.', 2);
  const config = loadCliConfig(cwd, opts.config);
  const gitInfo = detectRepo(cwd);
  const repoSlug = opts.repo ?? gitInfo?.remoteSlug ?? null;
  if (!repoSlug) throw new CliError('Could not determine repository; pass --repo owner/repo.', 2);
  const token = resolveToken(opts.token);
  if (!token)
    throw new CliError('A GitHub token is required (pass --token or set GITHUB_TOKEN).', 2);

  const client = new GitHubClient({ token });
  const repoRef = parseRepo(repoSlug);
  const runs = parsePositiveInt(opts.runs, '--runs') ?? config.historyRuns;

  // Determine which workflow to inspect.
  const root = gitInfo?.root ?? cwd;
  const engineOptions = buildEngineOptions(cwd, opts.workflow, opts);
  const { workflows } = await runEngine({ ...engineOptions, offline: true });
  if (workflows.length === 0)
    throw new CliError('No workflow files found to fetch history for.', 2);

  const format = validateFormat(opts.format, ['text', 'json'], 'text');
  const outputs: string[] = [];
  const jsonData: unknown[] = [];

  const cacheResult = await fetchCaches(client, repoRef);

  for (const model of workflows) {
    try {
      const samples = await fetchRunTimings(client, repoRef, {
        workflowPath: model.path,
        runs,
        ...(opts.ref ? { branch: opts.ref } : {}),
      });
      const history: HistoryData = {
        repo: repoSlug,
        workflowFile: model.path,
        runsAnalyzed: new Set(samples.map((s) => s.runId)).size,
        jobSamples: samples,
        caches: cacheResult.caches,
        cacheDataUnavailable: cacheResult.unavailable,
      };
      const summary = summarizeHistory(history);
      const measured = aggregateByBaseName(samples);

      if (format === 'json') {
        jsonData.push({
          workflow: model.path,
          runsAnalyzed: history.runsAnalyzed,
          jobs: summary,
          cacheCount: cacheResult.caches.length,
          cacheDataUnavailable: cacheResult.unavailable,
        });
      } else {
        outputs.push(`Workflow: ${model.name} (${model.path})`);
        outputs.push(`Runs analyzed: ${history.runsAnalyzed}`);
        if (summary.length === 0) {
          outputs.push('  No completed run/job timing available.');
        } else {
          for (const s of summary) {
            const flag = measured.has(s.base) ? '' : ' (no successful runs)';
            outputs.push(
              `  ${s.base}: avg ${formatDuration(s.averageSeconds)} ` +
                `(min ${formatDuration(s.minSeconds)}, max ${formatDuration(s.maxSeconds)}, ${s.runsAnalyzed} runs)${flag}`,
            );
          }
        }
        outputs.push(
          cacheResult.unavailable
            ? '  Cache metadata: unavailable'
            : `  Caches: ${cacheResult.caches.length}`,
        );
        outputs.push('');
      }
    } catch (err) {
      const msg =
        err instanceof GitHubError ? err.message : err instanceof Error ? err.message : String(err);
      if (format === 'json') jsonData.push({ workflow: model.path, error: msg });
      else outputs.push(`Workflow ${model.path}: ${msg}`, '');
    }
  }

  void root;
  const content = format === 'json' ? JSON.stringify(jsonData, null, 2) : outputs.join('\n');
  emit(content, opts.output, cwd);
  return 0;
}

// --------------------------------------------------------------------------
// doctor
// --------------------------------------------------------------------------

async function runDoctor(opts: CommonOpts): Promise<number> {
  const cwd = process.cwd();
  const lines: string[] = [];
  let problems = 0;

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeOk = nodeMajor >= 20;
  lines.push(`${nodeOk ? '✓' : '✗'} Node.js ${process.versions.node} (require >= 20)`);
  if (!nodeOk) problems++;

  const gitInfo = detectRepo(cwd);
  lines.push(gitInfo ? `✓ Git repository: ${gitInfo.root}` : '✗ Not inside a git repository');
  if (!gitInfo) problems++;
  if (gitInfo?.isShallow) {
    lines.push(
      '! Shallow clone detected — base-branch comparison may be limited (fetch full history for the Action).',
    );
  }
  lines.push(
    gitInfo?.remoteSlug
      ? `✓ Remote: ${gitInfo.remoteSlug}`
      : '! No origin remote detected (pass --repo for history)',
  );

  const wfDir = resolve(gitInfo?.root ?? cwd, '.github/workflows');
  const hasWorkflows = existsSync(wfDir);
  lines.push(
    hasWorkflows ? `✓ Workflows directory: ${wfDir}` : '✗ No .github/workflows directory found',
  );
  if (!hasWorkflows) problems++;

  const token = resolveToken(opts.token);
  lines.push(
    token
      ? '✓ GitHub token available (historical analysis enabled)'
      : '! No GitHub token (GITHUB_TOKEN) — static analysis only',
  );

  try {
    const config = loadCliConfig(cwd, opts.config);
    lines.push(
      config.sourcePath
        ? `✓ Config: ${config.sourcePath}`
        : '! No .cachemap.yml found (using defaults) — run `cachemap init` to create one',
    );
  } catch (err) {
    lines.push(`✗ Config error: ${err instanceof CliError ? err.message : String(err)}`);
    problems++;
  }

  if (token && gitInfo?.remoteSlug && !opts.offline) {
    try {
      const client = new GitHubClient({ token });
      const repoRef = parseRepo(gitInfo.remoteSlug);
      await client.request((o) => o.rest.repos.get({ owner: repoRef.owner, repo: repoRef.repo }));
      lines.push('✓ GitHub API reachable and token authorized');
    } catch (err) {
      lines.push(
        `! GitHub API check failed: ${err instanceof GitHubError ? err.message : String(err)}`,
      );
    }
  }

  process.stdout.write(lines.join('\n') + '\n');
  return problems > 0 ? 2 : 0;
}

// --------------------------------------------------------------------------
// init
// --------------------------------------------------------------------------

const CONFIG_TEMPLATE = `# CacheMap configuration. See docs/CONFIG.md.
version: 1

# Optional: restrict analysis to specific workflow files.
# workflows:
#   - .github/workflows/ci.yml

history:
  runs: 30

ignore:
  rules: []
  jobs: []

thresholds:
  minimum-estimated-savings-seconds: 20
  fail-on: high

# Cost rates are YOUR estimates, not authoritative GitHub billing rates.
cost:
  linux-per-minute: 0.008
  macos-per-minute: 0.08
  windows-per-minute: 0.016
`;

function runInit(opts: { force?: boolean }): number {
  const cwd = process.cwd();
  const target = resolve(cwd, '.cachemap.yml');
  if (existsSync(target) && !opts.force) {
    throw new CliError('.cachemap.yml already exists (use --force to overwrite).', 2);
  }
  writeFileSync(target, CONFIG_TEMPLATE, 'utf8');
  process.stdout.write(`Created ${target}\n`);
  return 0;
}

// --------------------------------------------------------------------------
// schema
// --------------------------------------------------------------------------

function runSchema(opts: { report?: boolean }): number {
  if (opts.report) {
    process.stdout.write(
      JSON.stringify(
        {
          title: 'CacheMap JSON report',
          schemaVersion: JSON_SCHEMA_VERSION,
          description:
            'The JSON report emitted by `cachemap report --format json`. schemaVersion is bumped only on breaking changes.',
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }
  process.stdout.write(JSON.stringify(configJsonSchema(), null, 2) + '\n');
  return 0;
}

// --------------------------------------------------------------------------
// wiring
// --------------------------------------------------------------------------

function handle(fn: () => Promise<number> | number): void {
  Promise.resolve()
    .then(fn)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      if (err instanceof CliError) {
        console.error(`Error: ${err.message}`);
        process.exitCode = err.exitCode;
      } else {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name(TOOL_NAME)
    .description('Analyze GitHub Actions workflows to explain why CI is slow and how to fix it.')
    .version(VERSION);

  addCommonOptions(
    program
      .command('analyze [workflow]')
      .description('Analyze workflow(s) and print a report')
      .option('--format <format>', 'text|json|markdown|sarif', 'text')
      .option('--output <path>', 'write the report to a file instead of stdout')
      .option('--fail-on <severity>', 'exit 1 when a finding reaches this severity'),
  ).action(
    (
      workflow: string | undefined,
      opts: CommonOpts & { format?: string; output?: string; failOn?: string },
    ) => handle(() => runAnalyzeLike(workflow, opts, 'text')),
  );

  addCommonOptions(
    program
      .command('report [workflow]')
      .description('Generate a report (defaults to Markdown) for sharing or CI artifacts')
      .option('--format <format>', 'text|json|markdown|sarif', 'markdown')
      .option('--output <path>', 'write the report to a file instead of stdout')
      .option('--fail-on <severity>', 'exit 1 when a finding reaches this severity'),
  ).action(
    (
      workflow: string | undefined,
      opts: CommonOpts & { format?: string; output?: string; failOn?: string },
    ) => handle(() => runAnalyzeLike(workflow, opts, 'markdown')),
  );

  addCommonOptions(
    program
      .command('graph [workflow]')
      .description('Render the workflow execution graph')
      .option('--format <format>', 'mermaid|dot|json', 'mermaid')
      .option('--output <path>', 'write to a file instead of stdout'),
  ).action(
    (workflow: string | undefined, opts: CommonOpts & { format?: string; output?: string }) =>
      handle(() => runGraph(workflow, opts)),
  );

  addCommonOptions(
    program.command('explain <finding-id>').description('Explain a finding by id'),
  ).action((findingId: string, opts: CommonOpts) => handle(() => runExplain(findingId, opts)));

  addCommonOptions(
    program
      .command('history')
      .description('Fetch and summarize historical run and cache data (requires a token)')
      .option('--format <format>', 'text|json', 'text')
      .option('--output <path>', 'write to a file instead of stdout'),
  ).action((opts: CommonOpts & { format?: string; output?: string }) =>
    handle(() => runHistory(opts)),
  );

  addCommonOptions(
    program.command('doctor').description('Check the environment and configuration'),
  ).action((opts: CommonOpts) => handle(() => runDoctor(opts)));

  program
    .command('init')
    .description('Create a .cachemap.yml configuration file')
    .option('--force', 'overwrite an existing config')
    .action((opts: { force?: boolean }) => handle(() => runInit(opts)));

  program
    .command('schema')
    .description('Print the configuration JSON schema (or --report for the report schema)')
    .option('--report', 'print the JSON report schema info instead')
    .action((opts: { report?: boolean }) => handle(() => runSchema(opts)));

  return program;
}

// Only parse argv when executed as the CLI entrypoint.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain || process.env['CACHEMAP_FORCE_CLI'] === '1') {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 2;
    });
}
