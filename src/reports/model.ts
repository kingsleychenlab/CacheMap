/**
 * Report bundle shared by every report format. Represents the analysis of one
 * or more workflows plus run metadata. The JSON schema version is bumped only
 * on breaking changes to the serialized shape.
 */
import type { WorkflowAnalysis, Confidence, Severity } from '../types.js';

/** Stable, versioned JSON report schema version. */
export const JSON_SCHEMA_VERSION = 1;

export interface ReportBundle {
  tool: { name: string; version: string };
  generatedAt: string;
  offline: boolean;
  repo: string | null;
  /** True when any workflow used historical data. */
  usedHistory: boolean;
  workflows: WorkflowAnalysis[];
  /** Warnings surfaced during analysis (shallow clone, missing creds, etc.). */
  warnings: string[];
}

/** Format seconds as e.g. "18m 42s" or "45s". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
}

/** Human label for a confidence category. */
export function confidenceLabel(confidence: Confidence): string {
  switch (confidence) {
    case 'measured':
      return 'measured';
    case 'inferred':
      return 'estimated';
    case 'unknown':
      return 'unknown';
  }
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
};

/** Total minimum potential savings across all workflows (seconds). */
export function totalPotentialSavings(bundle: ReportBundle): number {
  return bundle.workflows.reduce((sum, w) => sum + w.potentialSavingsSeconds, 0);
}

/** Count findings by kind across the bundle. */
export function countFindings(bundle: ReportBundle): {
  performance: number;
  security: number;
  bySeverity: Record<Severity, number>;
} {
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  let performance = 0;
  let security = 0;
  for (const w of bundle.workflows) {
    for (const f of w.findings) {
      bySeverity[f.severity]++;
      if (f.kind === 'security') security++;
      else performance++;
    }
  }
  return { performance, security, bySeverity };
}
