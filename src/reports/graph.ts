/**
 * Graph rendering in Mermaid, Graphviz DOT, and JSON. The graph shows job
 * dependencies, matrix-variant counts, caches, artifact flow, reusable
 * workflows, the critical path, and findings marked on nodes/edges.
 */
import type { WorkflowGraph, GraphNode } from '../graph/model.js';
import { formatDuration } from './model.js';

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, '_');
}

function nodeSummary(node: GraphNode): string {
  const parts: string[] = [node.label];
  if (node.variants.length > 1) parts.push(`×${node.variants.length}`);
  parts.push(formatDuration(node.durationSeconds));
  if (node.caches.length > 0) parts.push(`cache:${node.caches.length}`);
  if (node.services.length > 0) parts.push(`svc:${node.services.length}`);
  if (node.reusable) parts.push('reusable');
  if (node.findingIds.length > 0) parts.push(`⚠${node.findingIds.length}`);
  return parts.join(' · ');
}

/** Render the graph as a Mermaid flowchart. */
export function renderMermaid(graph: WorkflowGraph): string {
  const lines: string[] = [];
  lines.push('flowchart TD');
  lines.push(`  %% Workflow: ${graph.workflowName} (${graph.workflowPath})`);

  for (const node of graph.nodes) {
    const id = sanitizeId(node.id);
    const label = nodeSummary(node).replace(/"/g, "'");
    if (node.reusable) {
      lines.push(`  ${id}[["${label}"]]`);
    } else {
      lines.push(`  ${id}["${label}"]`);
    }
  }

  for (const edge of graph.edges) {
    const from = sanitizeId(edge.from);
    const to = sanitizeId(edge.to);
    if (edge.kind === 'artifact') {
      lines.push(`  ${from} -. "${(edge.artifact ?? 'artifact').replace(/"/g, "'")}" .-> ${to}`);
    } else {
      lines.push(`  ${from} --> ${to}`);
    }
  }

  // Highlight critical-path nodes and findings.
  const criticalNodes = graph.nodes.filter((n) => n.onCriticalPath).map((n) => sanitizeId(n.id));
  const findingNodes = graph.nodes
    .filter((n) => n.findingIds.length > 0)
    .map((n) => sanitizeId(n.id));
  if (criticalNodes.length > 0) {
    lines.push('  classDef critical stroke:#d33,stroke-width:3px;');
    lines.push(`  class ${criticalNodes.join(',')} critical;`);
  }
  if (findingNodes.length > 0) {
    lines.push('  classDef finding fill:#fff3cd,stroke:#e0a800;');
    lines.push(`  class ${findingNodes.join(',')} finding;`);
  }

  return lines.join('\n');
}

/** Render the graph as Graphviz DOT. */
export function renderDot(graph: WorkflowGraph): string {
  const lines: string[] = [];
  lines.push(`digraph "${graph.workflowName}" {`);
  lines.push('  rankdir=TB;');
  lines.push('  node [shape=box, style=rounded];');

  for (const node of graph.nodes) {
    const id = sanitizeId(node.id);
    const label = nodeSummary(node).replace(/"/g, '\\"');
    const attrs: string[] = [`label="${label}"`];
    if (node.reusable) attrs.push('shape=box3d');
    if (node.onCriticalPath) attrs.push('color="#d33"', 'penwidth=3');
    if (node.findingIds.length > 0) attrs.push('style="rounded,filled"', 'fillcolor="#fff3cd"');
    lines.push(`  ${id} [${attrs.join(', ')}];`);
  }

  for (const edge of graph.edges) {
    const from = sanitizeId(edge.from);
    const to = sanitizeId(edge.to);
    const attrs: string[] = [];
    if (edge.kind === 'artifact') {
      attrs.push('style=dashed', `label="${(edge.artifact ?? 'artifact').replace(/"/g, '\\"')}"`);
    }
    if (edge.onCriticalPath) attrs.push('color="#d33"', 'penwidth=2');
    lines.push(`  ${from} -> ${to}${attrs.length ? ` [${attrs.join(', ')}]` : ''};`);
  }

  lines.push('}');
  return lines.join('\n');
}

/** Render the graph as a stable JSON structure. */
export function renderGraphJson(graph: WorkflowGraph): string {
  return JSON.stringify(
    {
      workflow: { path: graph.workflowPath, name: graph.workflowName },
      nodes: graph.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        reusable: n.reusable,
        ...(n.reusableWorkflow ? { reusableWorkflow: n.reusableWorkflow } : {}),
        runsOn: n.runsOn,
        runsOnDynamic: n.runsOnDynamic,
        variantCount: n.variants.length,
        variants: n.variants.map((v) => ({
          id: v.variantId,
          matrix: v.matrixValues,
          dynamic: v.dynamic,
        })),
        durationSeconds: n.durationSeconds,
        timingSource: n.timingSource,
        confidence: n.confidence,
        caches: n.caches.map((c) => ({ action: c.action, key: c.key, builtIn: c.builtIn })),
        artifactUploads: n.artifactUploads.map((a) => a.name),
        artifactDownloads: n.artifactDownloads.map((a) => a.name),
        services: n.services,
        onCriticalPath: n.onCriticalPath,
        findingIds: n.findingIds,
      })),
      edges: graph.edges.map((e) => ({
        from: e.from,
        to: e.to,
        kind: e.kind,
        ...(e.artifact ? { artifact: e.artifact } : {}),
        onCriticalPath: e.onCriticalPath,
        findingIds: e.findingIds,
      })),
    },
    null,
    2,
  );
}
