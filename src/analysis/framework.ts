/**
 * Shared analysis framework: the input bundle every rule receives, plus helpers
 * for constructing findings with deterministic ids and evidence-grounded
 * savings estimates.
 */
import type {
  WorkflowModel,
  CriticalPathResult,
  JobVariant,
  AnalysisContext,
  HistoryData,
  Finding,
  SavingsEstimate,
  Severity,
  Confidence,
  SourceLocation,
} from '../types.js';
import type { WorkflowGraph } from '../graph/model.js';

export interface AnalysisInput {
  workflow: WorkflowModel;
  graph: WorkflowGraph;
  criticalPath: CriticalPathResult;
  variantsByJob: Map<string, JobVariant[]>;
  context: AnalysisContext;
  history?: HistoryData;
}

export type AnalysisRule = (input: AnalysisInput) => Finding[];

/**
 * A conservative, static savings estimate (no historical data). Confidence is
 * `inferred`; the method string must describe the heuristic.
 */
export function inferredSavings(
  minSeconds: number,
  maxSeconds: number,
  method: string,
): SavingsEstimate {
  return {
    minSeconds: Math.max(0, Math.round(minSeconds)),
    maxSeconds: Math.max(0, Math.round(maxSeconds)),
    confidence: 'inferred',
    source: 'estimated',
    runsAnalyzed: 0,
    method,
  };
}

/** A savings estimate backed by measured historical run data. */
export function measuredSavings(
  minSeconds: number,
  maxSeconds: number,
  runsAnalyzed: number,
  method: string,
): SavingsEstimate {
  return {
    minSeconds: Math.max(0, Math.round(minSeconds)),
    maxSeconds: Math.max(0, Math.round(maxSeconds)),
    confidence: 'measured',
    source: 'historical',
    runsAnalyzed,
    method,
  };
}

/** A finding whose time impact cannot be supported by evidence. */
export function unknownSavings(method: string): SavingsEstimate {
  return {
    minSeconds: 0,
    maxSeconds: 0,
    confidence: 'unknown',
    source: 'unknown',
    runsAnalyzed: 0,
    method,
  };
}

export interface FindingSpec {
  rule: string;
  seq: number;
  kind: Finding['kind'];
  severity: Severity;
  title: string;
  description: string;
  recommendation: string;
  workflow: string;
  evidence: Finding['evidence'];
  location?: SourceLocation;
  savings?: SavingsEstimate;
  jobs?: string[];
  details?: Record<string, string>;
}

/** Construct a finding with a deterministic `<rule>-<seq>` id. */
export function makeFinding(spec: FindingSpec): Finding {
  return {
    id: `${spec.rule}-${spec.seq}`,
    rule: spec.rule,
    kind: spec.kind,
    severity: spec.severity,
    title: spec.title,
    description: spec.description,
    evidence: spec.evidence,
    recommendation: spec.recommendation,
    workflow: spec.workflow,
    ...(spec.location ? { location: spec.location } : {}),
    ...(spec.savings ? { savings: spec.savings } : {}),
    ...(spec.jobs ? { jobs: spec.jobs } : {}),
    ...(spec.details ? { details: spec.details } : {}),
  };
}

/** Overall confidence of a set of findings' savings, for report summaries. */
export function combinedConfidence(findings: Finding[]): Confidence {
  const withSavings = findings.filter((f) => f.savings);
  if (withSavings.length === 0) return 'unknown';
  if (withSavings.every((f) => f.savings?.confidence === 'measured')) return 'measured';
  if (withSavings.some((f) => f.savings?.confidence === 'inferred')) return 'inferred';
  return 'unknown';
}
