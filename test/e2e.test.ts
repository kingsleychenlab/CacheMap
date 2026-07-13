import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { runEngine } from '../src/engine.js';
import { renderTextReport } from '../src/reports/text.js';
import { renderJsonReport } from '../src/reports/json.js';
import { renderMarkdownReport } from '../src/reports/markdown.js';
import { renderSarifReport } from '../src/reports/sarif.js';
import { renderMermaid } from '../src/reports/graph.js';
import { computeExitCode } from '../src/cli/shared.js';
import { DEFAULT_CONFIG, DEFAULT_COST } from '../src/config.js';

const INEFFICIENT_WORKFLOW = `name: Inefficient CI
on:
  push:
  pull_request:

jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci

  lint:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run lint

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
      - uses: actions/upload-artifact@v4
        with:
          name: coverage-results
          path: coverage

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run build
      - uses: actions/cache@v4
        with:
          path: node_modules
          key: \${{ runner.os }}-\${{ hashFiles('**/*') }}
`;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// A directory name with a space and a Unicode character.
const REPO_DIR_NAME = 'cache map δοκιμή';

describe('end-to-end', () => {
  let repo: string;
  let workflowPath: string;
  const config = { ...DEFAULT_CONFIG, cost: { ...DEFAULT_COST } };

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), 'cachemap-e2e-'));
    repo = join(base, REPO_DIR_NAME);
    mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
    workflowPath = join(repo, '.github', 'workflows', 'ci.yml');
    writeFileSync(workflowPath, INEFFICIENT_WORKFLOW, 'utf8');
    // Initialize a real git repository.
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  });

  afterAll(() => {
    if (repo) rmSync(dirname(repo), { recursive: true, force: true });
  });

  it('detects the four core inefficiencies and does not modify the workflow file', async () => {
    const before = sha256(workflowPath);

    const { bundle } = await runEngine({ cwd: repo, offline: true, config });
    expect(bundle.workflows).toHaveLength(1);
    const findings = bundle.workflows[0]!.findings;
    const rules = new Set(findings.map((f) => f.rule));

    // 1. repeated dependency installation
    expect(rules.has('repeated-dependency-install')).toBe(true);
    // 2. poor cache key
    expect(rules.has('cache-key-quality')).toBe(true);
    // 3. unnecessary job serialization (lint needs setup, no artifact consumed)
    expect(rules.has('unnecessary-serialization')).toBe(true);
    // 4. unused artifact
    expect(
      findings.some((f) => f.rule === 'artifact-unused' && f.title.includes('coverage-results')),
    ).toBe(true);

    // Workflow file must be untouched.
    expect(sha256(workflowPath)).toBe(before);
  });

  it('generates text, JSON, Markdown, SARIF and graph reports', async () => {
    const { bundle, results } = await runEngine({ cwd: repo, offline: true, config });

    const text = renderTextReport(bundle, false);
    expect(text).toContain('CACHEMAP REPORT');

    const json = JSON.parse(renderJsonReport(bundle));
    expect(json.schemaVersion).toBe(1);
    expect(json.workflows[0].findings.length).toBeGreaterThan(0);

    const md = renderMarkdownReport(bundle);
    expect(md).toContain('# CacheMap report');

    const sarif = JSON.parse(renderSarifReport(bundle));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results.length).toBeGreaterThan(0);

    const mermaid = renderMermaid(results[0]!.input.graph);
    expect(mermaid).toContain('flowchart TD');
  });

  it('computes threshold exit codes correctly', async () => {
    const { bundle } = await runEngine({ cwd: repo, offline: true, config });
    // There is a high-severity repeated-install finding.
    expect(computeExitCode(bundle, 'high')).toBe(1);
    expect(computeExitCode(bundle, 'critical')).toBe(0);
    expect(computeExitCode(bundle, 'low')).toBe(1);
  });

  it('runs through the compiled-source CLI and honours --fail-on exit codes', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const cli = join(here, '..', 'src', 'cli.ts');
    // Run the TypeScript CLI through node's own binary with the tsx loader,
    // resolved to an absolute file URL. This is cross-platform (no reliance on
    // the extensionless `.bin/tsx` shell script, which is not executable on
    // Windows) and independent of the child's working directory.
    const require = createRequire(import.meta.url);
    const tsxLoader = pathToFileURL(require.resolve('tsx')).href;
    const env = { ...process.env, CACHEMAP_FORCE_CLI: '1', NO_COLOR: '1' };

    // fail-on critical → no critical finding → exit 0
    const ok = runCli(tsxLoader, cli, ['analyze', '--offline', '--fail-on', 'critical'], repo, env);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('CACHEMAP REPORT');

    // fail-on high → high finding present → exit 1
    const fail = runCli(tsxLoader, cli, ['analyze', '--offline', '--fail-on', 'high'], repo, env);
    expect(fail.status).toBe(1);
  });
});

function runCli(
  tsxLoader: string,
  cli: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', tsxLoader, cli, ...args], {
      cwd,
      env,
      encoding: 'utf8',
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string };
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout ? e.stdout.toString() : '',
    };
  }
}
