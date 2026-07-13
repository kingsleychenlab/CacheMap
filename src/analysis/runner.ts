/**
 * Analysis orchestration: build the graph, compute the critical path, run every
 * rule, filter by configuration, and assemble a {@link WorkflowAnalysis}.
 *
 * Finding ids are deterministic (`<rule>-<seq>`) so `cachemap explain <id>` is
 * stable across runs of the same workflow.
 */
import type {
  WorkflowModel,
  WorkflowAnalysis,
  AnalysisContext,
  HistoryData,
  Finding,
  JobTiming,
  Severity,
} from '../types.js';
import { SEVERITY_ORDER } from '../types.js';
import { buildGraph } from '../graph/builder.js';
import { markCriticalPath } from '../graph/criticalPath.js';
import { expandMatrix } from '../parser/matrices.js';
import type { AnalysisInput, AnalysisRule } from './framework.js';
import { analyzeRepeatedWork } from './repeatedWork.js';
import { analyzeCaches } from './caches.js';
import { analyzeCacheHistory } from './cacheHistory.js';
import { analyzeMatrices } from './matrices.js';
import { analyzeParallelism } from './parallelism.js';
import { analyzeArtifacts } from './artifacts.js';
import { analyzeTriggers } from './triggers.js';
import { analyzeCheckout } from './checkout.js';
import { analyzeServices } from './services.js';
import { analyzePermissions } from './permissions.js';
import { analyzeSteps } from './steps.js';

/** Ordered list of all analysis rules. */
const RULES: { name: string; run: AnalysisRule }[] = [
  { name: 'repeatedWork', run: analyzeRepeatedWork },
  { name: 'caches', run: analyzeCaches },
  { name: 'cacheHistory', run: analyzeCacheHistory },
  { name: 'matrices', run: analyzeMatrices },
  { name: 'parallelism', run: analyzeParallelism },
  { name: 'artifacts', run: analyzeArtifacts },
  { name: 'triggers', run: analyzeTriggers },
  { name: 'checkout', run: analyzeCheckout },
  { name: 'services', run: analyzeServices },
  { name: 'permissions', run: analyzePermissions },
  { name: 'steps', run: analyzeSteps },
];

function severityRank(sev: Severity): number {
  return SEVERITY_ORDER[sev];
}

function savingsMax(f: Finding): number {
  return f.savings?.maxSeconds ?? 0;
}

/** Stable, deterministic ordering: severity desc, savings desc, id asc. */
function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const sev = severityRank(b.severity) - severityRank(a.severity);
    if (sev !== 0) return sev;
    const sav = savingsMax(b) - savingsMax(a);
    if (sav !== 0) return sav;
    return a.id.localeCompare(b.id);
  });
}

export interface AnalyzeWorkflowResult {
  analysis: WorkflowAnalysis;
  input: AnalysisInput;
}

/** Analyze a single parsed workflow. */
export function analyzeWorkflow(
  workflow: WorkflowModel,
  context: AnalysisContext,
  history?: HistoryData,
): AnalyzeWorkflowResult {
  const timings = context.timings?.get(workflow.path);
  const buildOpts = timings ? { timings } : {};
  const graph = buildGraph(workflow, buildOpts);
  const criticalPath = markCriticalPath(graph);

  const variantsByJob = new Map(workflow.jobs.map((j) => [j.id, expandMatrix(j)] as const));

  const input: AnalysisInput = {
    workflow,
    graph,
    criticalPath,
    variantsByJob,
    context,
    ...(history ? { history } : {}),
  };

  let findings: Finding[] = [];
  for (const rule of RULES) {
    try {
      findings.push(...rule.run(input));
    } catch (err) {
      // A single rule failure must not abort the whole analysis.
      workflow.warnings.push(
        `Rule "${rule.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Filter by configuration.
  findings = findings.filter((f) => !context.ignoredRules.has(f.rule));
  findings = findings.filter((f) => {
    // Suppress only LOW-severity performance noise whose concrete estimated
    // saving is below the configured minimum. Medium+ findings, security
    // findings, and unknown-savings findings are always kept.
    if (f.kind !== 'performance' || !f.savings) return true;
    if (f.severity !== 'low') return true;
    if (f.savings.confidence === 'unknown') return true;
    return f.savings.maxSeconds >= context.minimumSavingsSeconds;
  });

  findings = sortFindings(findings);

  // Mark findings on graph nodes/edges for graph output.
  const findingByJob = new Map<string, string[]>();
  for (const f of findings) {
    for (const jobId of f.jobs ?? []) {
      const list = findingByJob.get(jobId) ?? [];
      list.push(f.id);
      findingByJob.set(jobId, list);
    }
  }
  for (const node of graph.nodes) {
    node.findingIds = findingByJob.get(node.id) ?? [];
  }
  for (const edge of graph.edges) {
    const fromF = findingByJob.get(edge.from) ?? [];
    const toF = findingByJob.get(edge.to) ?? [];
    edge.findingIds = [...new Set([...fromF, ...toF])].filter((id) =>
      findings.some((f) => f.id === id && f.rule.includes('serial')),
    );
  }

  const jobTimings: JobTiming[] = graph.nodes.map((n) => ({
    jobId: n.id,
    seconds: n.durationSeconds,
    source: n.timingSource,
    confidence: n.confidence,
    runsAnalyzed: history?.runsAnalyzed ?? 0,
  }));

  const potentialSavingsSeconds = findings
    .filter((f) => f.kind === 'performance' && f.savings && f.savings.confidence !== 'unknown')
    .reduce((sum, f) => sum + (f.savings?.minSeconds ?? 0), 0);

  const analysis: WorkflowAnalysis = {
    workflow,
    findings,
    criticalPath,
    estimatedDurationSeconds: criticalPath.totalSeconds,
    durationConfidence: criticalPath.confidence,
    potentialSavingsSeconds,
    jobTimings,
    usedHistory: Boolean(history),
  };

  return { analysis, input };
}
