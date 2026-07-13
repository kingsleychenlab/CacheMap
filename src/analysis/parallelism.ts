/**
 * Rule: job parallelism analysis. Flags unnecessary serialization, fan-in
 * bottlenecks, and setup jobs that block unrelated work. We never recommend
 * parallelizing across a genuine dependency (artifact flow or `needs`).
 */
import type { Finding } from '../types.js';
import type { AnalysisInput } from './framework.js';
import { makeFinding, inferredSavings } from './framework.js';
import { predecessors, successors } from '../graph/model.js';
import { extractArtifacts } from '../parser/features.js';

const RULE_SERIAL = 'unnecessary-serialization';
const RULE_FANIN = 'fan-in-bottleneck';

/**
 * Determine whether the dependency edge A -> B is justified by an artifact
 * flow: B downloads an artifact that A uploads. If so, the ordering is real.
 */
function edgeJustifiedByArtifact(input: AnalysisInput, from: string, to: string): boolean {
  const fromJob = input.workflow.jobs.find((j) => j.id === from);
  const toJob = input.workflow.jobs.find((j) => j.id === to);
  if (!fromJob || !toJob) return false;
  const uploads = new Set(
    extractArtifacts(fromJob)
      .filter((a) => a.kind === 'upload')
      .map((a) => a.name),
  );
  const downloads = extractArtifacts(toJob).filter((a) => a.kind === 'download');
  return downloads.some((d) => d.name === '*' || uploads.has(d.name));
}

export function analyzeParallelism(input: AnalysisInput): Finding[] {
  const findings: Finding[] = [];
  const preds = predecessors(input.graph);
  const succ = successors(input.graph);

  // --- Fan-in bottleneck: a single job that many jobs depend on and that ---
  // sits on the critical path, blocking downstream work.
  let fanInSeq = 1;
  for (const node of input.graph.nodes) {
    if (input.context.ignoredJobs.has(node.id)) continue;
    const dependents = succ.get(node.id) ?? [];
    if (dependents.length >= 3 && node.onCriticalPath) {
      findings.push(
        makeFinding({
          rule: RULE_FANIN,
          seq: fanInSeq++,
          kind: 'performance',
          severity: 'medium',
          title: `Job \`${node.id}\` is a fan-in bottleneck for ${dependents.length} jobs`,
          description: `Job \`${node.id}\` is on the critical path and ${dependents.length} jobs depend on it. Everything downstream waits for it to finish, so its duration directly bounds total runtime.`,
          recommendation:
            'Split `' +
            node.id +
            '` into the part that downstream jobs actually need (e.g. a fast build artifact) and the rest, so dependents can start sooner.',
          workflow: input.workflow.path,
          evidence: dependents.map((d) => ({ label: d, detail: `depends on ${node.id}` })),
          savings: inferredSavings(
            0,
            Math.round(node.durationSeconds * 0.3),
            `Upper bound assumes ~30% of \`${node.id}\` (~${node.durationSeconds}s ${node.timingSource}) could be moved off the critical path. Inferred.`,
          ),
          jobs: [node.id, ...dependents],
        }),
      );
    }
  }

  // --- Unnecessary serialization: A -> B where B does not consume A's -----
  // output (no artifact flow) and A is not a shared prerequisite. These are
  // candidates to run in parallel.
  let serialSeq = 1;
  const reported = new Set<string>();
  for (const edge of input.graph.edges) {
    if (edge.kind !== 'needs') continue;
    const { from, to } = edge;
    if (input.context.ignoredJobs.has(to) || input.context.ignoredJobs.has(from)) continue;
    // If `to` only needs `from` (a strict chain link) and there is no artifact
    // dependency, the ordering may be unnecessary.
    const toPreds = preds.get(to) ?? [];
    if (toPreds.length !== 1) continue; // keep it conservative: single-parent chains
    if (edgeJustifiedByArtifact(input, from, to)) continue;
    const toJob = input.workflow.jobs.find((j) => j.id === to);
    const fromJob = input.workflow.jobs.find((j) => j.id === from);
    if (!toJob || !fromJob) continue;
    // Heuristic: if `to` downloads no artifacts at all, the `needs` is likely
    // ordering-only and could be relaxed.
    const toDownloads = extractArtifacts(toJob).filter((a) => a.kind === 'download');
    if (toDownloads.length > 0) continue;

    const key = `${from}->${to}`;
    if (reported.has(key)) continue;
    reported.add(key);

    const fromNode = input.graph.nodes.find((n) => n.id === from);
    findings.push(
      makeFinding({
        rule: RULE_SERIAL,
        seq: serialSeq++,
        kind: 'performance',
        severity: 'medium',
        title: `Job \`${to}\` may be serialized behind \`${from}\` unnecessarily`,
        description: `Job \`${to}\` declares \`needs: ${from}\` but does not download any artifact from it, so the dependency may exist only to order execution. If \`${to}\` does not actually consume \`${from}\`'s results, the two could run in parallel.`,
        recommendation: `Confirm whether \`${to}\` requires \`${from}\` to have completed. If not, remove the \`needs\` entry so both jobs start immediately. Do not remove it if \`${from}\` produces state \`${to}\` relies on.`,
        workflow: input.workflow.path,
        evidence: [
          { label: to, detail: `needs: ${from}` },
          { label: from, detail: 'no artifact consumed by dependent' },
        ],
        ...(toJob.location ? { location: toJob.location } : {}),
        savings: inferredSavings(
          0,
          fromNode ? fromNode.durationSeconds : 0,
          `Upper bound is the full duration of \`${from}\` (~${fromNode?.durationSeconds ?? 0}s ${fromNode?.timingSource ?? 'estimated'}) if the two ran in parallel. Only valid if the dependency is truly ordering-only. Inferred.`,
        ),
        jobs: [from, to],
      }),
    );
  }

  return findings;
}
