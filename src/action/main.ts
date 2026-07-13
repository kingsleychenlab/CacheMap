/**
 * CacheMap GitHub Action entrypoint.
 *
 * Behaviour:
 *  - Runs CacheMap against changed workflow files (on pull requests) or all
 *    configured workflows otherwise.
 *  - Optionally compares each changed workflow against the base branch to mark
 *    newly-introduced findings.
 *  - Adds file/line annotations for findings.
 *  - Writes a Markdown job summary.
 *  - Writes JSON and SARIF reports and uploads them as an artifact.
 *  - Fails only when the configured threshold is reached.
 *
 * It never edits workflow files or posts pull-request comments.
 */
import * as core from '@actions/core';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runEngine } from '../engine.js';
import type { EngineOptions } from '../engine.js';
import { renderJsonReport } from '../reports/json.js';
import { renderSarifReport } from '../reports/sarif.js';
import { renderMarkdownReport } from '../reports/markdown.js';
import { loadConfig, parseConfig } from '../config.js';
import type { ResolvedConfig } from '../config.js';
import { readFileSync, existsSync } from 'node:fs';
import { parseWorkflow } from '../parser/workflow.js';
import { analyzeWorkflow } from '../analysis/runner.js';
import type { AnalysisContext, Finding, Severity } from '../types.js';
import { SEVERITY_ORDER } from '../types.js';

function severityToAnnotation(severity: Severity): 'error' | 'warning' | 'notice' {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'notice';
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Determine changed workflow files on a pull request, if possible. */
function changedWorkflows(cwd: string): string[] | null {
  const baseRef = process.env['GITHUB_BASE_REF'];
  if (!baseRef) return null;
  // Ensure the base ref is available (best-effort; requires sufficient history).
  const base = git(['rev-parse', `origin/${baseRef}`], cwd) ?? git(['rev-parse', baseRef], cwd);
  if (!base) {
    core.warning(
      `Could not resolve base ref origin/${baseRef}. Check out with fetch-depth: 0 to enable changed-file detection and base comparison.`,
    );
    return null;
  }
  const diff = git(['diff', '--name-only', `${base}...HEAD`], cwd);
  if (diff === null) return null;
  return diff
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\.github\/workflows\/.+\.ya?ml$/i.test(l));
}

/** Read a workflow's content at the base ref via `git show`. */
function baseWorkflowContent(cwd: string, path: string): string | null {
  const baseRef = process.env['GITHUB_BASE_REF'];
  if (!baseRef) return null;
  return (
    git(['show', `origin/${baseRef}:${path}`], cwd) ?? git(['show', `${baseRef}:${path}`], cwd)
  );
}

/** Analyze the base version of a workflow to find pre-existing finding ids. */
function baseFindingIds(cwd: string, path: string, config: ResolvedConfig): Set<string> {
  const content = baseWorkflowContent(cwd, path);
  if (!content) return new Set();
  try {
    const model = parseWorkflow(content, path);
    const context: AnalysisContext = {
      workflowPaths: [path],
      offline: true,
      ignoredRules: new Set(config.ignoreRules),
      ignoredJobs: new Set(config.ignoreJobs),
      minimumSavingsSeconds: config.minimumSavingsSeconds,
      cost: {
        linuxPerMinute: config.cost.linuxPerMinute,
        macosPerMinute: config.cost.macosPerMinute,
        windowsPerMinute: config.cost.windowsPerMinute,
      },
    };
    const { analysis } = analyzeWorkflow(model, context);
    return new Set(analysis.findings.map((f) => f.id));
  } catch {
    return new Set();
  }
}

function meetsThreshold(severity: Severity, failOn: Severity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[failOn];
}

async function uploadReports(cwd: string, files: string[]): Promise<void> {
  try {
    // Imported lazily so environments without the artifact backend still run.
    const { DefaultArtifactClient } = await import('@actions/artifact');
    const client = new DefaultArtifactClient();
    await client.uploadArtifact('cachemap-reports', files, cwd, { retentionDays: 7 });
    core.info('Uploaded cachemap-reports artifact (JSON + SARIF).');
  } catch (err) {
    core.warning(
      `Could not upload reports as an artifact (${err instanceof Error ? err.message : String(err)}). The files remain in the workspace and are exposed as outputs.`,
    );
  }
}

export async function run(): Promise<void> {
  const cwd = process.env['GITHUB_WORKSPACE'] ?? process.cwd();

  const workflowInput = core.getInput('workflow');
  const runsInput = core.getInput('runs');
  const failOnInput = (core.getInput('fail-on') || 'high') as Severity;
  const token = core.getInput('github-token');
  const offline = core.getBooleanInput('offline');
  const configInput = core.getInput('config');
  const compareBase = core.getBooleanInput('compare-base');

  // Load config (explicit path or discovery).
  let config: ResolvedConfig;
  try {
    config = configInput
      ? parseConfig(readFileSync(join(cwd, configInput), 'utf8'), join(cwd, configInput))
      : loadConfig(cwd);
  } catch (err) {
    core.setFailed(`Configuration error: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Choose workflows: explicit input, else changed files (PR), else all.
  let workflows: string[] | undefined;
  if (workflowInput) {
    workflows = [workflowInput];
  } else {
    const changed = changedWorkflows(cwd);
    if (changed && changed.length > 0) {
      core.info(`Analyzing ${changed.length} changed workflow file(s).`);
      workflows = changed;
    } else if (changed && changed.length === 0) {
      core.info('No workflow files changed in this pull request; analyzing all workflows.');
    }
  }

  const engineOptions: EngineOptions = {
    cwd,
    ...(workflows ? { workflows } : {}),
    offline,
    ...(token ? { token } : {}),
    ...(runsInput ? { runs: Number(runsInput) } : {}),
    config,
    log: (m) => core.info(m),
  };

  let bundle;
  try {
    ({ bundle } = await runEngine(engineOptions));
  } catch (err) {
    core.setFailed(`CacheMap analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  for (const w of bundle.warnings) core.warning(w);

  // Optional base comparison to mark new findings.
  const newFindingIds = new Set<string>();
  if (compareBase && process.env['GITHUB_BASE_REF']) {
    for (const analysis of bundle.workflows) {
      const baseIds = baseFindingIds(cwd, analysis.workflow.path, config);
      for (const f of analysis.findings) {
        if (!baseIds.has(f.id)) newFindingIds.add(f.id);
      }
    }
  }

  // Annotations.
  let totalFindings = 0;
  let triggered = false;
  for (const analysis of bundle.workflows) {
    for (const finding of analysis.findings) {
      totalFindings++;
      if (meetsThreshold(finding.severity, failOnInput)) triggered = true;
      annotate(cwd, finding, newFindingIds.has(finding.id));
    }
  }

  // Reports on disk.
  const jsonPath = join(cwd, 'cachemap-report.json');
  const sarifPath = join(cwd, 'cachemap.sarif');
  writeFileSync(jsonPath, renderJsonReport(bundle), 'utf8');
  writeFileSync(sarifPath, renderSarifReport(bundle), 'utf8');

  // Job summary.
  try {
    await core.summary.addRaw(renderMarkdownReport(bundle)).write();
  } catch (err) {
    core.warning(
      `Could not write job summary: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Upload artifacts (best-effort).
  if (existsSync(jsonPath) && existsSync(sarifPath)) {
    await uploadReports(cwd, [jsonPath, sarifPath]);
  }

  // Outputs.
  core.setOutput('findings-count', String(totalFindings));
  core.setOutput('has-findings', String(totalFindings > 0));
  core.setOutput('new-findings-count', String(newFindingIds.size));
  core.setOutput('json-report', relative(cwd, jsonPath));
  core.setOutput('sarif-report', relative(cwd, sarifPath));
  core.setOutput('threshold-exceeded', String(triggered));

  if (triggered) {
    core.setFailed(
      `CacheMap found at least one finding at or above the "${failOnInput}" threshold. See the job summary and annotations.`,
    );
  } else {
    core.info(`CacheMap finished: ${totalFindings} finding(s), none at/above "${failOnInput}".`);
  }
}

function annotate(cwd: string, finding: Finding, isNew: boolean): void {
  const kind = severityToAnnotation(finding.severity);
  const props: core.AnnotationProperties = {
    title: `CacheMap: ${finding.title}${isNew ? ' (new in this PR)' : ''}`,
  };
  if (finding.location?.file) {
    props.file = relative(cwd, join(cwd, finding.location.file));
    if (finding.location.line) props.startLine = finding.location.line;
    if (finding.location.column) props.startColumn = finding.location.column;
  }
  const message = `${finding.description}\n\nRecommendation: ${finding.recommendation}`;
  if (kind === 'error') core.error(message, props);
  else if (kind === 'warning') core.warning(message, props);
  else core.notice(message, props);
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
