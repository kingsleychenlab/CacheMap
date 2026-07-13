import { describe, it, expect } from 'vitest';
import { parseWorkflow, WorkflowParseError } from '../src/parser/workflow.js';
import { parseFixture } from './helpers.js';

describe('workflow parser', () => {
  it('parses a basic workflow with jobs, steps and triggers', () => {
    const wf = parseFixture('node-ci.yml');
    expect(wf.name).toBe('Node CI');
    expect(wf.jobs.map((j) => j.id)).toEqual(['lint', 'test', 'build']);
    expect(wf.triggers.events).toContain('push');
    expect(wf.triggers.events).toContain('pull_request');
    expect(wf.triggers.push?.branches).toEqual(['main']);
  });

  it('captures needs relationships', () => {
    const wf = parseFixture('node-ci.yml');
    const build = wf.jobs.find((j) => j.id === 'build');
    expect(build?.needs).toEqual(['lint', 'test']);
  });

  it('preserves multiline run commands verbatim', () => {
    const wf = parseWorkflow(
      `name: t
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo one
          echo two
          npm ci
`,
      '.github/workflows/t.yml',
    );
    const run = wf.jobs[0]?.steps[0]?.run ?? '';
    expect(run).toContain('echo one');
    expect(run).toContain('echo two');
    expect(run.split('\n').length).toBeGreaterThanOrEqual(3);
  });

  it('records source locations for steps', () => {
    const wf = parseFixture('node-ci.yml');
    const step = wf.jobs[0]?.steps[0];
    expect(step?.location?.line).toBeGreaterThan(0);
    expect(step?.location?.file).toBe('.github/workflows/node-ci.yml');
  });

  it('splits `uses` into action and version', () => {
    const wf = parseFixture('node-ci.yml');
    const checkout = wf.jobs[0]?.steps.find((s) => s.uses?.startsWith('actions/checkout'));
    expect(checkout?.usesAction).toBe('actions/checkout');
    expect(checkout?.usesVersion).toBe('v4');
  });

  it('parses `on` when YAML coerces it to the boolean true key', () => {
    const wf = parseWorkflow(
      `name: t
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: "echo hi" }]
`,
      '.github/workflows/t.yml',
    );
    expect(wf.triggers.events).toContain('push');
  });

  it('throws WorkflowParseError on malformed YAML', () => {
    expect(() => parseFixture('malformed.yml')).toThrow(WorkflowParseError);
  });

  it('handles reusable-workflow jobs (`uses` at job level)', () => {
    const wf = parseFixture('reusable-caller.yml');
    const ci = wf.jobs.find((j) => j.id === 'ci');
    expect(ci?.usesWorkflow).toBe('./.github/workflows/reusable-ci.yml');
  });

  it('marks dynamic runs-on as dynamic', () => {
    const wf = parseFixture('matrix.yml');
    const test = wf.jobs.find((j) => j.id === 'test');
    expect(test?.runsOn.dynamic).toBe(true);
    expect(test?.runsOn.raw).toContain('${{');
  });

  it('parses services with health-check detection', () => {
    const wf = parseFixture('python-ci.yml');
    const unit = wf.jobs.find((j) => j.id === 'unit');
    expect(unit?.services.map((s) => s.id)).toContain('postgres');
    expect(unit?.services[0]?.hasHealthCheck).toBe(false);
  });

  it('parses permissions (blanket and scoped)', () => {
    const wf = parseFixture('permissions.yml');
    expect(wf.permissions?.blanket).toBe('write-all');
    const build = wf.jobs.find((j) => j.id === 'build');
    expect(build?.permissions?.scopes['contents']).toBe('write');
  });

  it('handles paths with spaces and unicode in the workflow path argument', () => {
    const wf = parseWorkflow(
      'name: t\non: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo hi }]\n',
      '.github/workflows/コスト map file.yml',
    );
    expect(wf.path).toBe('.github/workflows/コスト map file.yml');
  });
});
