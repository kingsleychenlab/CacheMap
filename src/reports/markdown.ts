/**
 * Markdown report, used by `cachemap report --format markdown` and by the
 * GitHub Action job summary. Renders a summary table plus per-workflow findings.
 */
import type { Finding, WorkflowAnalysis } from '../types.js';
import type { ReportBundle } from './model.js';
import { formatDuration, confidenceLabel, SEVERITY_LABEL, countFindings } from './model.js';

function severityBadge(finding: Finding): string {
  const emoji: Record<string, string> = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🔵',
  };
  return `${emoji[finding.severity] ?? ''} **${SEVERITY_LABEL[finding.severity]}**`;
}

function renderFinding(finding: Finding, lines: string[]): void {
  lines.push('');
  lines.push(`#### ${severityBadge(finding)} ${finding.title}`);
  lines.push('');
  lines.push(`\`${finding.id}\` · rule \`${finding.rule}\``);
  lines.push('');
  lines.push(finding.description);
  if (finding.evidence.length > 0) {
    lines.push('');
    lines.push('**Evidence:**');
    for (const ev of finding.evidence.slice(0, 12)) {
      lines.push(`- ${ev.label}${ev.detail ? ` — ${ev.detail}` : ''}`);
    }
    if (finding.evidence.length > 12) lines.push(`- … ${finding.evidence.length - 12} more`);
  }
  if (finding.savings && finding.savings.maxSeconds > 0) {
    const { minSeconds, maxSeconds, confidence, runsAnalyzed, method } = finding.savings;
    const range =
      minSeconds === maxSeconds
        ? formatDuration(maxSeconds)
        : `${formatDuration(minSeconds)}–${formatDuration(maxSeconds)}`;
    lines.push('');
    lines.push(
      `**Estimated avoidable time:** ${range} (${confidenceLabel(confidence)}${runsAnalyzed ? `, ${runsAnalyzed} runs` : ''})`,
    );
    lines.push('');
    lines.push(`<sub>${method}</sub>`);
  } else if (finding.savings) {
    lines.push('');
    lines.push(
      `**Time impact:** ${confidenceLabel(finding.savings.confidence)} — ${finding.savings.method}`,
    );
  }
  if (finding.location?.line) {
    lines.push('');
    lines.push(`<sub>Location: \`${finding.location.file}:${finding.location.line}\`</sub>`);
  }
  lines.push('');
  lines.push('**Recommendation:**');
  lines.push('');
  lines.push('```');
  lines.push(finding.recommendation);
  lines.push('```');
}

function renderWorkflow(analysis: WorkflowAnalysis, lines: string[]): void {
  const { workflow, criticalPath } = analysis;
  lines.push('');
  lines.push(`## ${workflow.name}`);
  lines.push('');
  lines.push(`\`${workflow.path}\``);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(
    `| Estimated duration | ${formatDuration(analysis.estimatedDurationSeconds)} (${confidenceLabel(analysis.durationConfidence)}) |`,
  );
  if (criticalPath.path.length > 0) {
    lines.push(`| Critical path | ${criticalPath.path.join(' → ')} |`);
  }
  if (analysis.potentialSavingsSeconds > 0) {
    lines.push(`| Potential savings | ${formatDuration(analysis.potentialSavingsSeconds)} |`);
  }
  lines.push(`| Findings | ${analysis.findings.length} |`);

  const performance = analysis.findings.filter((f) => f.kind === 'performance');
  const security = analysis.findings.filter((f) => f.kind === 'security');

  if (analysis.findings.length === 0) {
    lines.push('');
    lines.push('_No findings._');
    return;
  }
  if (performance.length > 0) {
    lines.push('');
    lines.push('### Performance findings');
    for (const f of performance) renderFinding(f, lines);
  }
  if (security.length > 0) {
    lines.push('');
    lines.push('### Security findings');
    for (const f of security) renderFinding(f, lines);
  }
}

/** Render the full Markdown report. */
export function renderMarkdownReport(bundle: ReportBundle): string {
  const lines: string[] = [];
  const counts = countFindings(bundle);

  lines.push('# CacheMap report');
  lines.push('');
  lines.push(
    `_Generated ${bundle.generatedAt}${bundle.repo ? ` for \`${bundle.repo}\`` : ''} · ` +
      `${bundle.offline ? 'offline' : bundle.usedHistory ? 'with historical data' : 'static'} analysis_`,
  );
  lines.push('');
  lines.push('| | Count |');
  lines.push('| --- | --- |');
  lines.push(`| Performance findings | ${counts.performance} |`);
  lines.push(`| Security findings | ${counts.security} |`);
  lines.push(`| Critical / High | ${counts.bySeverity.critical} / ${counts.bySeverity.high} |`);
  lines.push(`| Medium / Low | ${counts.bySeverity.medium} / ${counts.bySeverity.low} |`);

  if (bundle.warnings.length > 0) {
    lines.push('');
    lines.push('> **Warnings**');
    for (const w of bundle.warnings) lines.push(`> - ${w}`);
  }

  for (const analysis of bundle.workflows) {
    renderWorkflow(analysis, lines);
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    '<sub>Timing categories: **measured** (from historical runs), **estimated** (heuristic, no history), **unknown** (not supported by evidence). CacheMap never modifies workflow files.</sub>',
  );

  return lines.join('\n');
}
