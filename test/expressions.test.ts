import { describe, it, expect } from 'vitest';
import {
  containsExpression,
  resolve,
  extractHashFilesGlobs,
  referencesHashFiles,
  extractReferences,
} from '../src/parser/expressions.js';

describe('expressions', () => {
  it('detects expressions', () => {
    expect(containsExpression('${{ matrix.os }}')).toBe(true);
    expect(containsExpression('ubuntu-latest')).toBe(false);
  });

  it('resolves matrix substitutions', () => {
    const r = resolve('node-${{ matrix.node }}', { matrix: { node: 20 } });
    expect(r.value).toBe('node-20');
    expect(r.dynamic).toBe(false);
  });

  it('marks unresolved expressions as dynamic and preserves them', () => {
    const r = resolve('${{ github.event.inputs.foo }}', {});
    expect(r.dynamic).toBe(true);
    expect(r.value).toContain('${{');
  });

  it('resolves string literals and runner context', () => {
    expect(resolve("${{ 'ubuntu-latest' }}", {}).value).toBe('ubuntu-latest');
    expect(resolve('${{ runner.os }}', { runner: { os: 'Linux' } }).value).toBe('Linux');
  });

  it('extracts hashFiles globs', () => {
    expect(extractHashFilesGlobs("${{ hashFiles('**/package-lock.json') }}")).toEqual([
      '**/package-lock.json',
    ]);
    expect(extractHashFilesGlobs("${{ hashFiles('a', 'b') }}")).toEqual(['a', 'b']);
    expect(referencesHashFiles("${{ hashFiles('x') }}")).toBe(true);
  });

  it('extracts distinct context references', () => {
    const refs = extractReferences('${{ runner.os }}-${{ matrix.node }}-${{ matrix.node }}');
    expect(refs).toContain('runner.os');
    expect(refs).toContain('matrix.node');
    expect(refs.length).toBe(2);
  });
});
