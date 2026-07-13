/**
 * Static, heuristic duration estimation used ONLY when no historical timing is
 * available. These numbers are explicitly labelled `estimated`/`inferred` (never
 * `measured`) everywhere they surface, so reports never present them as fact.
 * The heuristic exists so the critical-path structure is meaningful offline; it
 * is intentionally coarse and conservative.
 */
import type { JobModel } from '../types.js';
import { extractDependencyInstalls } from '../parser/features.js';

/** Coarse per-construct second estimates. Documented, not measured. */
export const ESTIMATE = {
  runnerStartupSeconds: 10,
  checkoutSeconds: 5,
  setupActionSeconds: 12,
  dependencyInstallSeconds: 40,
  cacheStepSeconds: 8,
  artifactStepSeconds: 15,
  genericUsesStepSeconds: 10,
  genericRunStepSeconds: 25,
  emptyStepSeconds: 2,
};

const BUILD_TEST_RE =
  /\b(build|test|compile|lint|check|cargo\s+build|cargo\s+test|make|gradle|mvn)\b/i;

/**
 * Estimate the wall-clock seconds for a single job (one matrix variant).
 * Returns a coarse heuristic total.
 */
export function estimateJobSeconds(job: JobModel): number {
  if (job.usesWorkflow) {
    // Reusable workflow — we cannot see inside it statically.
    return ESTIMATE.runnerStartupSeconds + ESTIMATE.genericRunStepSeconds;
  }
  let total = ESTIMATE.runnerStartupSeconds;
  const installSteps = new Set(extractDependencyInstalls(job).map((i) => i.stepIndex));

  for (const step of job.steps) {
    if (installSteps.has(step.index) && step.run) {
      total += ESTIMATE.dependencyInstallSeconds;
      continue;
    }
    if (step.usesAction === 'actions/checkout') {
      total += ESTIMATE.checkoutSeconds;
    } else if (
      step.usesAction?.startsWith('actions/setup-') ||
      step.usesAction === 'Swatinem/rust-cache'
    ) {
      total += ESTIMATE.setupActionSeconds;
    } else if (
      step.usesAction === 'actions/cache' ||
      step.usesAction?.startsWith('actions/cache/')
    ) {
      total += ESTIMATE.cacheStepSeconds;
    } else if (
      step.usesAction === 'actions/upload-artifact' ||
      step.usesAction === 'actions/download-artifact'
    ) {
      total += ESTIMATE.artifactStepSeconds;
    } else if (step.uses) {
      total += ESTIMATE.genericUsesStepSeconds;
    } else if (step.run) {
      total += BUILD_TEST_RE.test(step.run)
        ? ESTIMATE.genericRunStepSeconds * 1.5
        : ESTIMATE.genericRunStepSeconds;
    } else {
      total += ESTIMATE.emptyStepSeconds;
    }
  }
  return Math.round(total);
}
