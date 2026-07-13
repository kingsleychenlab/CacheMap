/**
 * Core domain types shared across parsing, graph construction, analysis, and
 * reporting. Keeping these in one place lets each module depend on stable
 * shapes without importing implementation details from siblings.
 */

/** Severity ordering is used for thresholds and sorting. Higher = worse. */
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export const SEVERITY_ORDER: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Whether a finding is a performance issue or a security issue. */
export type FindingKind = 'performance' | 'security';

/**
 * Confidence category for any timing/savings claim. We never emit arbitrary
 * percentage confidence scores — only these three evidence-grounded buckets.
 */
export type Confidence = 'measured' | 'inferred' | 'unknown';

/** Where a duration number came from. */
export type TimingSource = 'historical' | 'action-metadata' | 'estimated' | 'unknown';

export interface SourceLocation {
  /** Repository-relative path to the workflow file. */
  file: string;
  /** 1-indexed line, when known. */
  line?: number;
  /** 1-indexed column, when known. */
  column?: number;
}

/**
 * An estimated time saving attached to a finding. Every field is required so
 * that no saving can be reported without disclosing how it was derived.
 */
export interface SavingsEstimate {
  /** Lower bound of avoidable seconds (conservative). */
  minSeconds: number;
  /** Upper bound of avoidable seconds. */
  maxSeconds: number;
  confidence: Confidence;
  /** Human-readable description of the timing source. */
  source: TimingSource;
  /** How many historical runs informed this estimate (0 when static). */
  runsAnalyzed: number;
  /** Plain-language description of how the number was computed. */
  method: string;
}

export interface Evidence {
  /** Short label, e.g. a job or step name. */
  label: string;
  /** Optional additional detail. */
  detail?: string;
  location?: SourceLocation;
}

export interface Finding {
  /** Stable, deterministic identifier, e.g. "repeated-deps-1". */
  id: string;
  /** Rule that produced the finding, e.g. "repeated-dependency-install". */
  rule: string;
  kind: FindingKind;
  severity: Severity;
  title: string;
  /** One or two sentence summary of the problem. */
  description: string;
  /** Concrete evidence backing the finding. */
  evidence: Evidence[];
  /** Actionable recommendation text. */
  recommendation: string;
  /** Primary location for annotations (file/line). */
  location?: SourceLocation;
  /** Optional savings estimate; omitted for security findings. */
  savings?: SavingsEstimate;
  /** Workflow this finding belongs to (path). */
  workflow: string;
  /** Optional related job ids. */
  jobs?: string[];
  /** Extra structured detail for the `explain` command. */
  details?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Parsed workflow model
// ---------------------------------------------------------------------------

/**
 * A value that may be a resolved literal or an unresolved GitHub Actions
 * expression. `dynamic` marks values we could not statically evaluate.
 */
export interface ResolvedValue<T> {
  value: T | undefined;
  raw: string;
  dynamic: boolean;
}

export interface StepModel {
  index: number;
  name?: string;
  /** `uses` action reference, e.g. "actions/checkout@v4". */
  uses?: string;
  /** Action name without version, e.g. "actions/checkout". */
  usesAction?: string;
  /** Action version/ref, e.g. "v4". */
  usesVersion?: string;
  /** `run` shell command(s), preserved verbatim (may be multiline). */
  run?: string;
  /** `with` inputs for `uses` steps. */
  with?: Record<string, string>;
  /** `if` condition expression, verbatim. */
  if?: string;
  /** Environment variables declared on the step. */
  env?: Record<string, string>;
  location?: SourceLocation;
}

export interface ServiceModel {
  id: string;
  image?: string;
  ports?: string[];
  hasHealthCheck: boolean;
  location?: SourceLocation;
}

export interface MatrixDimension {
  name: string;
  /** Statically known values, or undefined when dynamic. */
  values?: unknown[];
  dynamic: boolean;
  raw: string;
}

export interface RawMatrix {
  dimensions: MatrixDimension[];
  include: Record<string, unknown>[];
  exclude: Record<string, unknown>[];
  /** True if the matrix references expressions we cannot resolve. */
  dynamic: boolean;
  raw: unknown;
}

export interface JobModel {
  /** Job key as written in the YAML `jobs` map. */
  id: string;
  name?: string;
  runsOn: ResolvedValue<string>;
  needs: string[];
  if?: string;
  steps: StepModel[];
  services: ServiceModel[];
  matrix?: RawMatrix;
  failFast?: boolean;
  maxParallel?: number;
  /** For reusable-workflow jobs: the `uses` reference. */
  usesWorkflow?: string;
  /** Job-level permissions. */
  permissions?: PermissionsModel;
  /** Job-level environment. */
  env?: Record<string, string>;
  location?: SourceLocation;
}

export interface PermissionsModel {
  /** "read-all" | "write-all" | undefined when scoped. */
  blanket?: 'read-all' | 'write-all';
  scopes: Record<string, 'read' | 'write' | 'none'>;
  raw: unknown;
}

export interface TriggerModel {
  events: string[];
  /** Per-event configuration, keyed by event name. */
  push?: TriggerFilters;
  pullRequest?: TriggerFilters;
  pullRequestTarget?: TriggerFilters;
  schedule?: { cron: string }[];
  raw: unknown;
}

export interface TriggerFilters {
  branches?: string[];
  branchesIgnore?: string[];
  paths?: string[];
  pathsIgnore?: string[];
  tags?: string[];
}

export interface ConcurrencyModel {
  group: string;
  cancelInProgress: boolean | string;
}

export interface WorkflowModel {
  /** Repository-relative path. */
  path: string;
  name: string;
  triggers: TriggerModel;
  permissions?: PermissionsModel;
  concurrency?: ConcurrencyModel;
  defaults?: Record<string, unknown>;
  jobs: JobModel[];
  /** Non-fatal parse warnings. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Expanded (matrix-resolved) model used by the graph & analyses
// ---------------------------------------------------------------------------

export interface JobVariant {
  /** Base job id. */
  jobId: string;
  /** Unique variant id, e.g. "test (node-20, ubuntu-latest)". */
  variantId: string;
  /** Matrix values bound in this variant. */
  matrixValues: Record<string, unknown>;
  /** True when the variant was produced from a dynamic/partial matrix. */
  dynamic: boolean;
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export interface JobTiming {
  jobId: string;
  seconds: number;
  source: TimingSource;
  confidence: Confidence;
  runsAnalyzed: number;
}

// ---------------------------------------------------------------------------
// Analysis result
// ---------------------------------------------------------------------------

export interface CriticalPathResult {
  /** Ordered job ids along the longest path. */
  path: string[];
  /** Total seconds along the critical path. */
  totalSeconds: number;
  /** Whether timing was measured, inferred, or unknown overall. */
  confidence: Confidence;
  timingSource: TimingSource;
  /** Jobs that do not affect total duration (off critical path). */
  nonCriticalJobs: string[];
}

export interface WorkflowAnalysis {
  workflow: WorkflowModel;
  findings: Finding[];
  criticalPath: CriticalPathResult;
  /** Estimated total wall-clock duration in seconds. */
  estimatedDurationSeconds: number;
  durationConfidence: Confidence;
  /** Sum of avoidable seconds across findings (min bound). */
  potentialSavingsSeconds: number;
  jobTimings: JobTiming[];
  /** Whether any historical data was incorporated. */
  usedHistory: boolean;
}

export interface AnalysisContext {
  /** Repository-relative workflow paths that were analyzed. */
  workflowPaths: string[];
  /** Timing data keyed by workflow path -> job id, when available. */
  timings?: Map<string, Map<string, JobTiming>>;
  /** Historical cache statistics, when available. */
  cacheStats?: CacheStats[];
  offline: boolean;
  /** Rules disabled by configuration. */
  ignoredRules: Set<string>;
  /** Job ids disabled by configuration. */
  ignoredJobs: Set<string>;
  /** Performance findings with a concrete saving below this are suppressed. */
  minimumSavingsSeconds: number;
  /** Cost model for compute-cost estimates. */
  cost: CostModel;
}

export interface CostModel {
  linuxPerMinute: number;
  macosPerMinute: number;
  windowsPerMinute: number;
}

// ---------------------------------------------------------------------------
// GitHub history types
// ---------------------------------------------------------------------------

export interface CacheStats {
  key: string;
  ref?: string;
  sizeBytes: number;
  createdAt?: string;
  lastAccessedAt?: string;
}

export interface RunTimingSample {
  runId: number;
  jobId: string;
  jobName: string;
  seconds: number;
  conclusion: string;
  createdAt: string;
}

export interface HistoryData {
  repo: string;
  workflowFile: string;
  runsAnalyzed: number;
  jobSamples: RunTimingSample[];
  caches: CacheStats[];
  /** True when cache metadata could not be retrieved. */
  cacheDataUnavailable: boolean;
}
