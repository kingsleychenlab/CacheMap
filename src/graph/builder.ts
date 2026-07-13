/**
 * Build a {@link WorkflowGraph} from a parsed {@link WorkflowModel}. Matrix
 * variants are expanded and attached to their base job node. Job-level timing
 * is taken from historical data when supplied, otherwise from the static
 * estimator (clearly labelled inferred/estimated).
 */
import type { JobTiming, WorkflowModel } from '../types.js';
import type { WorkflowGraph, GraphNode, GraphEdge } from './model.js';
import { expandMatrix } from '../parser/matrices.js';
import { extractCaches, extractArtifacts } from '../parser/features.js';
import { estimateJobSeconds } from './estimate.js';

export interface BuildGraphOptions {
  /** Historical timing keyed by base job id. */
  timings?: Map<string, JobTiming>;
}

export function buildGraph(
  workflow: WorkflowModel,
  options: BuildGraphOptions = {},
): WorkflowGraph {
  const nodes: GraphNode[] = [];
  const knownJobIds = new Set(workflow.jobs.map((j) => j.id));

  for (const job of workflow.jobs) {
    const variants = expandMatrix(job);
    const caches = extractCaches(job);
    const artifacts = extractArtifacts(job);
    const uploads = artifacts.filter((a) => a.kind === 'upload');
    const downloads = artifacts.filter((a) => a.kind === 'download');

    const timing = options.timings?.get(job.id);
    const perVariantSeconds = timing ? timing.seconds : estimateJobSeconds(job);
    // Matrix variants run in parallel; the job "finishes" with the slowest one.
    // With per-variant history we would refine this; for now every variant
    // shares the same duration estimate, so max === perVariantSeconds.
    const durationSeconds = perVariantSeconds;

    const node: GraphNode = {
      id: job.id,
      label: job.name ?? job.id,
      reusable: Boolean(job.usesWorkflow),
      ...(job.usesWorkflow ? { reusableWorkflow: job.usesWorkflow } : {}),
      runsOn: job.runsOn.dynamic ? job.runsOn.raw : (job.runsOn.value ?? 'unknown'),
      runsOnDynamic: job.runsOn.dynamic,
      variants,
      caches,
      artifactUploads: uploads,
      artifactDownloads: downloads,
      services: job.services.map((s) => s.id),
      durationSeconds,
      timingSource: timing ? timing.source : 'estimated',
      confidence: timing
        ? timing.confidence
        : variants.some((v) => v.dynamic)
          ? 'unknown'
          : 'inferred',
      findingIds: [],
      onCriticalPath: false,
    };
    nodes.push(node);
  }

  const edges: GraphEdge[] = [];
  for (const job of workflow.jobs) {
    for (const need of job.needs) {
      if (!knownJobIds.has(need)) continue; // ignore dangling needs
      edges.push({
        from: need,
        to: job.id,
        kind: 'needs',
        onCriticalPath: false,
        findingIds: [],
      });
    }
  }

  // Artifact-flow edges: connect a job that uploads an artifact to jobs that
  // download the same statically-known name (and depend on it via needs).
  const uploadByName = new Map<string, string[]>();
  for (const node of nodes) {
    for (const up of node.artifactUploads) {
      if (up.name.includes('${{')) continue;
      const list = uploadByName.get(up.name) ?? [];
      list.push(node.id);
      uploadByName.set(up.name, list);
    }
  }
  for (const node of nodes) {
    for (const down of node.artifactDownloads) {
      if (down.name === '*' || down.name.includes('${{')) continue;
      const producers = uploadByName.get(down.name);
      if (!producers) continue;
      for (const producer of producers) {
        if (producer === node.id) continue;
        edges.push({
          from: producer,
          to: node.id,
          kind: 'artifact',
          artifact: down.name,
          onCriticalPath: false,
          findingIds: [],
        });
      }
    }
  }

  return {
    workflowPath: workflow.path,
    workflowName: workflow.name,
    nodes,
    edges,
  };
}
