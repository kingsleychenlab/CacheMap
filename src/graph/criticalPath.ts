/**
 * Cycle detection and critical-path (longest weighted path) computation over
 * the `needs` dependency DAG. Job durations weight the nodes. The critical
 * path is the sequence of jobs that determines total wall-clock duration under
 * unlimited parallelism.
 */
import type { CriticalPathResult, Confidence, TimingSource } from '../types.js';
import type { WorkflowGraph } from './model.js';
import { predecessors } from './model.js';

/**
 * Detect dependency cycles using Kahn's algorithm. Returns the set of job ids
 * that participate in at least one cycle (empty when acyclic).
 */
export function detectCycles(graph: WorkflowGraph): string[] {
  const preds = predecessors(graph);
  const indegree = new Map<string, number>();
  for (const node of graph.nodes) {
    indegree.set(node.id, preds.get(node.id)?.length ?? 0);
  }
  const queue: string[] = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);

  const succ = new Map<string, string[]>();
  for (const node of graph.nodes) succ.set(node.id, []);
  for (const edge of graph.edges) {
    if (edge.kind !== 'needs') continue;
    succ.get(edge.from)?.push(edge.to);
  }

  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    visited++;
    for (const next of succ.get(id) ?? []) {
      const deg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  if (visited === graph.nodes.length) return [];
  // Remaining nodes with indegree > 0 are in or downstream of cycles.
  return graph.nodes.map((n) => n.id).filter((id) => (indegree.get(id) ?? 0) > 0);
}

interface FinishInfo {
  finish: number;
  from: string | null;
}

/**
 * Compute the critical path. Cycles are broken conservatively (back edges are
 * ignored) so this always terminates; callers should surface cycles via
 * {@link detectCycles} separately.
 */
export function computeCriticalPath(graph: WorkflowGraph): CriticalPathResult {
  const preds = predecessors(graph);
  const duration = new Map<string, number>();
  for (const node of graph.nodes) duration.set(node.id, node.durationSeconds);

  const finish = new Map<string, FinishInfo>();
  const inProgress = new Set<string>();

  const compute = (id: string): number => {
    const cached = finish.get(id);
    if (cached) return cached.finish;
    if (inProgress.has(id)) return 0; // break cycle
    inProgress.add(id);
    let best = 0;
    let bestFrom: string | null = null;
    for (const pred of preds.get(id) ?? []) {
      const predFinish = compute(pred);
      if (predFinish > best) {
        best = predFinish;
        bestFrom = pred;
      }
    }
    inProgress.delete(id);
    const info: FinishInfo = { finish: best + (duration.get(id) ?? 0), from: bestFrom };
    finish.set(id, info);
    return info.finish;
  };

  let endJob: string | null = null;
  let maxFinish = 0;
  for (const node of graph.nodes) {
    const f = compute(node.id);
    if (f >= maxFinish) {
      maxFinish = f;
      endJob = node.id;
    }
  }

  const path: string[] = [];
  let cursor = endJob;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    path.unshift(cursor);
    cursor = finish.get(cursor)?.from ?? null;
  }

  const criticalSet = new Set(path);
  const nonCriticalJobs = graph.nodes.map((n) => n.id).filter((id) => !criticalSet.has(id));

  // Aggregate confidence/source across the path.
  const { confidence, timingSource } = aggregateTiming(graph, path);

  return {
    path,
    totalSeconds: maxFinish,
    confidence,
    timingSource,
    nonCriticalJobs,
  };
}

function aggregateTiming(
  graph: WorkflowGraph,
  path: string[],
): { confidence: Confidence; timingSource: TimingSource } {
  if (path.length === 0) return { confidence: 'unknown', timingSource: 'unknown' };
  const nodes = path
    .map((id) => graph.nodes.find((n) => n.id === id))
    .filter((n) => n !== undefined);
  const allMeasured = nodes.every((n) => n.confidence === 'measured');
  const anyUnknown = nodes.some((n) => n.confidence === 'unknown');
  if (allMeasured) return { confidence: 'measured', timingSource: 'historical' };
  if (anyUnknown) return { confidence: 'unknown', timingSource: 'estimated' };
  return { confidence: 'inferred', timingSource: 'estimated' };
}

/**
 * Mark critical-path nodes and edges in place, returning the result. Useful
 * before rendering the graph so the path is highlighted.
 */
export function markCriticalPath(graph: WorkflowGraph): CriticalPathResult {
  const result = computeCriticalPath(graph);
  const set = new Set(result.path);
  for (const node of graph.nodes) node.onCriticalPath = set.has(node.id);
  for (const edge of graph.edges) {
    const idxFrom = result.path.indexOf(edge.from);
    edge.onCriticalPath =
      edge.kind === 'needs' && idxFrom >= 0 && result.path[idxFrom + 1] === edge.to;
  }
  return result;
}
