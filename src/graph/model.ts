/**
 * Directed workflow-execution graph model. Nodes are base jobs (with their
 * expanded matrix variants attached); edges are `needs` dependencies. Caches,
 * artifacts, services, and reusable-workflow references are attached to nodes
 * so the graph output can render them and findings can be marked on nodes and
 * edges.
 */
import type { JobVariant, Confidence, TimingSource } from '../types.js';
import type { CacheRef, ArtifactRef } from '../parser/features.js';

export interface GraphNode {
  /** Base job id. */
  id: string;
  label: string;
  /** True for reusable-workflow jobs (`uses:` at job level). */
  reusable: boolean;
  reusableWorkflow?: string;
  runsOn: string;
  runsOnDynamic: boolean;
  variants: JobVariant[];
  caches: CacheRef[];
  artifactUploads: ArtifactRef[];
  artifactDownloads: ArtifactRef[];
  services: string[];
  /** Estimated/measured duration for the whole job (max over variants). */
  durationSeconds: number;
  timingSource: TimingSource;
  confidence: Confidence;
  /** Finding ids marked directly on this node. */
  findingIds: string[];
  onCriticalPath: boolean;
}

export type EdgeKind = 'needs' | 'artifact';

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Optional artifact name for artifact-flow edges. */
  artifact?: string;
  onCriticalPath: boolean;
  findingIds: string[];
}

export interface WorkflowGraph {
  workflowPath: string;
  workflowName: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Look up a node by id. */
export function getNode(graph: WorkflowGraph, id: string): GraphNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

/** Build an adjacency map of job id -> direct dependents (successors). */
export function successors(graph: WorkflowGraph): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const node of graph.nodes) map.set(node.id, []);
  for (const edge of graph.edges) {
    if (edge.kind !== 'needs') continue;
    const list = map.get(edge.from);
    if (list) list.push(edge.to);
  }
  return map;
}

/** Build an adjacency map of job id -> direct dependencies (predecessors). */
export function predecessors(graph: WorkflowGraph): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const node of graph.nodes) map.set(node.id, []);
  for (const edge of graph.edges) {
    if (edge.kind !== 'needs') continue;
    const list = map.get(edge.to);
    if (list) list.push(edge.from);
  }
  return map;
}
