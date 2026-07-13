import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseWorkflow } from '../src/parser/workflow.js';
import type { WorkflowModel, AnalysisContext } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));

export function fixturePath(name: string): string {
  return resolve(here, 'fixtures/workflows', name);
}

export function loadFixture(name: string): string {
  return readFileSync(fixturePath(name), 'utf8');
}

export function parseFixture(name: string): WorkflowModel {
  return parseWorkflow(loadFixture(name), `.github/workflows/${name}`);
}

export function testContext(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    workflowPaths: [],
    offline: true,
    ignoredRules: new Set(),
    ignoredJobs: new Set(),
    minimumSavingsSeconds: 20,
    cost: { linuxPerMinute: 0.008, macosPerMinute: 0.08, windowsPerMinute: 0.016 },
    ...overrides,
  };
}
