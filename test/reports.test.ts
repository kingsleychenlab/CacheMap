import { describe, it, expect } from 'vitest';
import { analyzeWorkflow } from '../src/analysis/runner.js';
import { buildJsonReport, renderJsonReport } from '../src/reports/json.js';
import { buildSarifReport } from '../src/reports/sarif.js';
import { renderMarkdownReport } from '../src/reports/markdown.js';
import { renderTextReport } from '../src/reports/text.js';
import { renderMermaid, renderDot, renderGraphJson } from '../src/reports/graph.js';
import { markCriticalPath } from '../src/graph/criticalPath.js';
import { buildGraph } from '../src/graph/builder.js';
import type { ReportBundle } from '../src/reports/model.js';
import { formatDuration } from '../src/reports/model.js';
import { parseFixture, testContext } from './helpers.js';

function bundleFor(fixture: string): ReportBundle {
  const wf = parseFixture(fixture);
  const analysis = analyzeWorkflow(wf, testContext()).analysis;
  return {
    tool: { name: 'cachemap', version: '0.0.0-test' },
    generatedAt: '2020-01-01T00:00:00.000Z',
    offline: true,
    repo: 'owner/repo',
    usedHistory: false,
    workflows: [analysis],
    warnings: [],
  };
}

describe('duration formatting', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(125)).toBe('2m 5s');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(3660)).toBe('1h 1m');
  });
});

describe('JSON report', () => {
  it('has a stable schema version and expected top-level keys', () => {
    const report = buildJsonReport(bundleFor('node-ci.yml'));
    expect(report['schemaVersion']).toBe(1);
    expect(Object.keys(report).sort()).toEqual(
      [
        'generatedAt',
        'offline',
        'repo',
        'schemaVersion',
        'tool',
        'usedHistory',
        'warnings',
        'workflows',
      ].sort(),
    );
  });

  it('is deterministic for identical input', () => {
    expect(renderJsonReport(bundleFor('node-ci.yml'))).toBe(
      renderJsonReport(bundleFor('node-ci.yml')),
    );
  });

  it('serializes findings with savings metadata', () => {
    const report = buildJsonReport(bundleFor('node-ci.yml')) as any;
    const finding = report.workflows[0].findings.find(
      (f: any) => f.rule === 'repeated-dependency-install',
    );
    expect(finding.savings.confidence).toBe('inferred');
    expect(finding.savings).toHaveProperty('method');
    expect(finding.savings).toHaveProperty('runsAnalyzed');
  });
});

describe('SARIF report', () => {
  it('produces valid SARIF 2.1.0 structure', () => {
    const sarif = buildSarifReport(bundleFor('permissions.yml')) as any;
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toContain('sarif');
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.name).toBe('cachemap');
    expect(Array.isArray(sarif.runs[0].tool.driver.rules)).toBe(true);
    expect(Array.isArray(sarif.runs[0].results)).toBe(true);
  });

  it('every result references a defined rule index', () => {
    const sarif = buildSarifReport(bundleFor('node-ci.yml')) as any;
    const ruleCount = sarif.runs[0].tool.driver.rules.length;
    for (const result of sarif.runs[0].results) {
      expect(result.ruleIndex).toBeGreaterThanOrEqual(0);
      expect(result.ruleIndex).toBeLessThan(ruleCount);
      expect(result.locations[0].physicalLocation.artifactLocation.uri).toBeTruthy();
    }
  });

  it('marks security findings with a security-severity property', () => {
    const sarif = buildSarifReport(bundleFor('permissions.yml')) as any;
    const secRule = sarif.runs[0].tool.driver.rules.find(
      (r: any) => r.properties.kind === 'security',
    );
    expect(secRule.properties['security-severity']).toBeTruthy();
  });
});

describe('Markdown and text reports', () => {
  it('renders Markdown with a summary table', () => {
    const md = renderMarkdownReport(bundleFor('node-ci.yml'));
    expect(md).toContain('# CacheMap report');
    expect(md).toContain('## Node CI');
    expect(md).toContain('Recommendation');
  });

  it('renders text without ANSI when color disabled', () => {
    const text = renderTextReport(bundleFor('node-ci.yml'), false);
    expect(text).toContain('CACHEMAP REPORT');
    // No ANSI escape sequences (the ESC control character, U+001B).
    expect(text.includes(String.fromCharCode(27))).toBe(false);
  });
});

describe('graph rendering', () => {
  it('renders mermaid, dot and json', () => {
    const wf = parseFixture('node-ci.yml');
    const graph = buildGraph(wf);
    markCriticalPath(graph);
    expect(renderMermaid(graph)).toContain('flowchart TD');
    expect(renderDot(graph)).toContain('digraph');
    const json = JSON.parse(renderGraphJson(graph));
    expect(json.nodes.length).toBe(3);
    expect(json.edges.length).toBeGreaterThan(0);
  });
});
