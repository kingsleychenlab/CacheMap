import { describe, it, expect } from 'vitest';
import { analyzeWorkflow } from '../src/analysis/runner.js';
import { parseFixture, testContext } from './helpers.js';
import type { JobTiming, CacheStats } from '../src/types.js';

describe('measured timing integration', () => {
  it('uses historical timing and reports measured confidence on the critical path', () => {
    const wf = parseFixture('node-ci.yml');
    const timings = new Map<string, Map<string, JobTiming>>();
    const jobTimings = new Map<string, JobTiming>();
    for (const job of wf.jobs) {
      jobTimings.set(job.id, {
        jobId: job.id,
        seconds: 120,
        source: 'historical',
        confidence: 'measured',
        runsAnalyzed: 10,
      });
    }
    timings.set(wf.path, jobTimings);
    const result = analyzeWorkflow(wf, testContext({ timings, offline: false }), {
      repo: 'o/r',
      workflowFile: wf.path,
      runsAnalyzed: 10,
      jobSamples: [],
      caches: [],
      cacheDataUnavailable: false,
    });
    expect(result.analysis.durationConfidence).toBe('measured');
    expect(result.analysis.criticalPath.timingSource).toBe('historical');
    expect(result.analysis.usedHistory).toBe(true);
  });
});

describe('cache-history rule (measured)', () => {
  it('flags a frequently invalidated key family from the cache list', () => {
    const wf = parseFixture('rust-ci.yml');
    const caches: CacheStats[] = Array.from({ length: 6 }, (_, i) => ({
      key: `Linux-cargo-${'a'.repeat(8)}${i}`,
      sizeBytes: 200 * 1024 * 1024,
    }));
    const findings = analyzeWorkflow(wf, testContext({ cacheStats: caches }), {
      repo: 'o/r',
      workflowFile: wf.path,
      runsAnalyzed: 6,
      jobSamples: [],
      caches,
      cacheDataUnavailable: false,
    }).analysis.findings;
    const inv = findings.filter((f) => f.rule === 'cache-frequently-invalidated');
    expect(inv.length).toBeGreaterThanOrEqual(1);
    expect(inv[0]?.savings?.confidence).toBe('measured');
    expect(inv[0]?.savings?.runsAnalyzed).toBe(6);
  });

  it('produces nothing when there is no cache metadata', () => {
    const wf = parseFixture('rust-ci.yml');
    const findings = analyzeWorkflow(wf, testContext()).analysis.findings;
    expect(findings.filter((f) => f.rule === 'cache-frequently-invalidated')).toEqual([]);
  });
});
