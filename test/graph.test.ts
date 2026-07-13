import { describe, it, expect } from 'vitest';
import { parseWorkflow } from '../src/parser/workflow.js';
import { buildGraph } from '../src/graph/builder.js';
import { detectCycles, computeCriticalPath } from '../src/graph/criticalPath.js';
import { parseFixture } from './helpers.js';

describe('graph construction', () => {
  it('builds nodes and needs edges', () => {
    const wf = parseFixture('node-ci.yml');
    const graph = buildGraph(wf);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['build', 'lint', 'test']);
    const needsEdges = graph.edges.filter((e) => e.kind === 'needs');
    expect(needsEdges).toContainEqual(expect.objectContaining({ from: 'lint', to: 'build' }));
    expect(needsEdges).toContainEqual(expect.objectContaining({ from: 'test', to: 'build' }));
  });

  it('creates artifact-flow edges for matching upload/download names', () => {
    const wf = parseFixture('artifact-heavy.yml');
    const graph = buildGraph(wf);
    const artifactEdges = graph.edges.filter((e) => e.kind === 'artifact');
    expect(artifactEdges).toContainEqual(
      expect.objectContaining({ from: 'build', to: 'package', artifact: 'node-modules-cache' }),
    );
  });

  it('detects cycles', () => {
    const wf = parseWorkflow(
      `name: c
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    needs: [b]
    steps: [{ run: echo a }]
  b:
    runs-on: ubuntu-latest
    needs: [a]
    steps: [{ run: echo b }]
`,
      '.github/workflows/c.yml',
    );
    const graph = buildGraph(wf);
    const cycles = detectCycles(graph);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('reports no cycles for an acyclic graph', () => {
    const wf = parseFixture('node-ci.yml');
    const graph = buildGraph(wf);
    expect(detectCycles(graph)).toEqual([]);
  });

  it('computes a critical path through dependencies', () => {
    const wf = parseFixture('node-ci.yml');
    const graph = buildGraph(wf);
    const cp = computeCriticalPath(graph);
    // build depends on lint/test, so it must be the last node on the path.
    expect(cp.path[cp.path.length - 1]).toBe('build');
    expect(cp.totalSeconds).toBeGreaterThan(0);
    expect(cp.path.length).toBeGreaterThanOrEqual(2);
  });

  it('marks timing confidence as inferred without history', () => {
    const wf = parseFixture('node-ci.yml');
    const graph = buildGraph(wf);
    expect(graph.nodes.every((n) => n.confidence !== 'measured')).toBe(true);
    expect(graph.nodes.every((n) => n.timingSource === 'estimated')).toBe(true);
  });

  it('does not infinite-loop on a cyclic critical path', () => {
    const wf = parseWorkflow(
      `name: c
on: [push]
jobs:
  a: { runs-on: ubuntu-latest, needs: [b], steps: [{ run: echo a }] }
  b: { runs-on: ubuntu-latest, needs: [a], steps: [{ run: echo b }] }
`,
      '.github/workflows/c.yml',
    );
    const graph = buildGraph(wf);
    const cp = computeCriticalPath(graph);
    expect(cp.totalSeconds).toBeGreaterThanOrEqual(0);
  });
});
