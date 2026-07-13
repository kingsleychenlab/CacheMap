/**
 * Stable, versioned JSON report. The top-level `schemaVersion` is only bumped
 * on breaking changes to this shape; additive fields do not bump it. Output is
 * deterministic given deterministic input (no timestamps are invented here —
 * `generatedAt` comes from the bundle).
 */
import type { ReportBundle } from './model.js';
import { JSON_SCHEMA_VERSION } from './model.js';
import type { Finding, WorkflowAnalysis } from '../types.js';

interface JsonFinding {
  id: string;
  rule: string;
  kind: string;
  severity: string;
  title: string;
  description: string;
  recommendation: string;
  workflow: string;
  evidence: { label: string; detail?: string; location?: unknown }[];
  location?: { file: string; line?: number; column?: number };
  savings?: {
    minSeconds: number;
    maxSeconds: number;
    confidence: string;
    source: string;
    runsAnalyzed: number;
    method: string;
  };
  jobs?: string[];
  details?: Record<string, string>;
}

function serializeFinding(f: Finding): JsonFinding {
  return {
    id: f.id,
    rule: f.rule,
    kind: f.kind,
    severity: f.severity,
    title: f.title,
    description: f.description,
    recommendation: f.recommendation,
    workflow: f.workflow,
    evidence: f.evidence.map((e) => ({
      label: e.label,
      ...(e.detail !== undefined ? { detail: e.detail } : {}),
      ...(e.location !== undefined ? { location: e.location } : {}),
    })),
    ...(f.location ? { location: f.location } : {}),
    ...(f.savings ? { savings: f.savings } : {}),
    ...(f.jobs ? { jobs: f.jobs } : {}),
    ...(f.details ? { details: f.details } : {}),
  };
}

function serializeWorkflow(w: WorkflowAnalysis): Record<string, unknown> {
  return {
    path: w.workflow.path,
    name: w.workflow.name,
    estimatedDurationSeconds: w.estimatedDurationSeconds,
    durationConfidence: w.durationConfidence,
    potentialSavingsSeconds: w.potentialSavingsSeconds,
    usedHistory: w.usedHistory,
    criticalPath: {
      path: w.criticalPath.path,
      totalSeconds: w.criticalPath.totalSeconds,
      confidence: w.criticalPath.confidence,
      timingSource: w.criticalPath.timingSource,
      nonCriticalJobs: w.criticalPath.nonCriticalJobs,
    },
    jobTimings: w.jobTimings.map((t) => ({
      jobId: t.jobId,
      seconds: t.seconds,
      source: t.source,
      confidence: t.confidence,
      runsAnalyzed: t.runsAnalyzed,
    })),
    warnings: w.workflow.warnings,
    findings: w.findings.map(serializeFinding),
  };
}

/** Build the JSON report object (for programmatic use). */
export function buildJsonReport(bundle: ReportBundle): Record<string, unknown> {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    tool: bundle.tool,
    generatedAt: bundle.generatedAt,
    repo: bundle.repo,
    offline: bundle.offline,
    usedHistory: bundle.usedHistory,
    warnings: bundle.warnings,
    workflows: bundle.workflows.map(serializeWorkflow),
  };
}

/** Render the JSON report as a pretty-printed string. */
export function renderJsonReport(bundle: ReportBundle): string {
  return JSON.stringify(buildJsonReport(bundle), null, 2);
}
