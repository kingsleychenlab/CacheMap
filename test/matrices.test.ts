import { describe, it, expect } from 'vitest';
import { expandMatrix, findDuplicateCombinations } from '../src/parser/matrices.js';
import type { JobModel } from '../src/types.js';
import { parseFixture } from './helpers.js';

function jobWithMatrix(matrix: JobModel['matrix']): JobModel {
  return {
    id: 'test',
    runsOn: { value: 'ubuntu-latest', raw: 'ubuntu-latest', dynamic: false },
    needs: [],
    steps: [],
    services: [],
    ...(matrix ? { matrix } : {}),
  };
}

describe('matrix expansion', () => {
  it('expands a simple cartesian product', () => {
    const job = jobWithMatrix({
      dimensions: [
        { name: 'os', values: ['ubuntu-latest', 'macos-latest'], dynamic: false, raw: '' },
        { name: 'node', values: [18, 20], dynamic: false, raw: '' },
      ],
      include: [],
      exclude: [],
      dynamic: false,
      raw: {},
    });
    const variants = expandMatrix(job);
    expect(variants).toHaveLength(4);
    expect(variants.map((v) => v.variantId)).toContain('test (ubuntu-latest, 18)');
  });

  it('applies exclude to remove combinations', () => {
    const job = jobWithMatrix({
      dimensions: [
        { name: 'os', values: ['ubuntu-latest', 'macos-latest'], dynamic: false, raw: '' },
        { name: 'node', values: [16, 20], dynamic: false, raw: '' },
      ],
      include: [],
      exclude: [{ os: 'macos-latest', node: 16 }],
      dynamic: false,
      raw: {},
    });
    const variants = expandMatrix(job);
    expect(variants).toHaveLength(3);
    expect(
      variants.every(
        (v) => !(v.matrixValues['os'] === 'macos-latest' && v.matrixValues['node'] === 16),
      ),
    ).toBe(true);
  });

  it('applies include that extends every combination (extra keys only)', () => {
    const job = jobWithMatrix({
      dimensions: [{ name: 'node', values: [18, 20], dynamic: false, raw: '' }],
      include: [{ npm: 8 }],
      exclude: [],
      dynamic: false,
      raw: {},
    });
    const variants = expandMatrix(job);
    expect(variants).toHaveLength(2);
    expect(variants.every((v) => v.matrixValues['npm'] === 8)).toBe(true);
  });

  it('applies include that appends a new combination when it does not match', () => {
    const job = jobWithMatrix({
      dimensions: [{ name: 'node', values: [18, 20], dynamic: false, raw: '' }],
      include: [{ node: 21, experimental: true }],
      exclude: [],
      dynamic: false,
      raw: {},
    });
    const variants = expandMatrix(job);
    expect(variants).toHaveLength(3);
    expect(
      variants.some(
        (v) => v.matrixValues['node'] === 21 && v.matrixValues['experimental'] === true,
      ),
    ).toBe(true);
  });

  it('produces a single dynamic variant for expression-based matrices', () => {
    const job = jobWithMatrix({
      dimensions: [
        { name: 'shard', dynamic: true, raw: '${{ fromJson(needs.x.outputs.shards) }}' },
      ],
      include: [],
      exclude: [],
      dynamic: true,
      raw: {},
    });
    const variants = expandMatrix(job);
    expect(variants).toHaveLength(1);
    expect(variants[0]?.dynamic).toBe(true);
  });

  it('expands the fixture matrix with include/exclude', () => {
    const wf = parseFixture('matrix.yml');
    const test = wf.jobs.find((j) => j.id === 'test');
    const variants = expandMatrix(test!);
    // 3 os * 3 node * 1 arch = 9, minus 1 excluded (macos+16), plus 1 include (ubuntu 21) = 9
    expect(variants.length).toBe(9);
  });

  it('detects duplicate combinations', () => {
    const dupJob = jobWithMatrix({
      dimensions: [{ name: 'node', values: [20, 20], dynamic: false, raw: '' }],
      include: [],
      exclude: [],
      dynamic: false,
      raw: {},
    });
    const variants = expandMatrix(dupJob);
    const dups = findDuplicateCombinations(variants);
    expect(dups.length).toBe(1);
    expect(dups[0]?.length).toBe(2);
  });
});
