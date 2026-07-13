import { describe, it, expect } from 'vitest';
import {
  aggregateByBaseName,
  baseJobName,
  mapTimingsToJobs,
  summarizeHistory,
} from '../src/github/history.js';
import type { RunTimingSample, HistoryData } from '../src/types.js';
import { parseFixture } from './helpers.js';

function sample(
  runId: number,
  jobName: string,
  seconds: number,
  conclusion = 'success',
): RunTimingSample {
  return { runId, jobId: jobName, jobName, seconds, conclusion, createdAt: '2020-01-01T00:00:00Z' };
}

describe('history aggregation', () => {
  it('strips matrix suffixes from job names', () => {
    expect(baseJobName('test (ubuntu-latest, 20)')).toBe('test');
    expect(baseJobName('build')).toBe('build');
  });

  it('takes the slowest variant within a run, then averages across runs', () => {
    const samples = [
      sample(1, 'test (18)', 100),
      sample(1, 'test (20)', 200),
      sample(2, 'test (18)', 300),
      sample(2, 'test (20)', 100),
    ];
    const agg = aggregateByBaseName(samples);
    const test = agg.get('test');
    // run1 max = 200, run2 max = 300, avg = 250
    expect(test?.seconds).toBe(250);
    expect(test?.confidence).toBe('measured');
    expect(test?.source).toBe('historical');
    expect(test?.runsAnalyzed).toBe(2);
  });

  it('ignores non-successful runs', () => {
    const samples = [sample(1, 'a', 100, 'failure'), sample(2, 'a', 200, 'success')];
    const agg = aggregateByBaseName(samples);
    expect(agg.get('a')?.seconds).toBe(200);
    expect(agg.get('a')?.runsAnalyzed).toBe(1);
  });

  it('maps aggregated timings onto workflow job ids', () => {
    const wf = parseFixture('node-ci.yml');
    const agg = aggregateByBaseName([sample(1, 'build', 120), sample(1, 'lint', 30)]);
    const mapped = mapTimingsToJobs(wf, agg);
    expect(mapped.get('build')?.seconds).toBe(120);
    expect(mapped.get('lint')?.seconds).toBe(30);
    expect(mapped.get('build')?.jobId).toBe('build');
  });

  it('summarizes history with min/avg/max', () => {
    const history: HistoryData = {
      repo: 'o/r',
      workflowFile: 'ci.yml',
      runsAnalyzed: 2,
      jobSamples: [sample(1, 'a', 100), sample(2, 'a', 200)],
      caches: [],
      cacheDataUnavailable: false,
    };
    const summary = summarizeHistory(history);
    expect(summary[0]?.base).toBe('a');
    expect(summary[0]?.averageSeconds).toBe(150);
    expect(summary[0]?.minSeconds).toBe(100);
    expect(summary[0]?.maxSeconds).toBe(200);
  });
});
