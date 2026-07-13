/**
 * Human-readable terminal report. Mirrors the documented CACHEMAP REPORT
 * layout: per-workflow header, critical path, then findings grouped by kind
 * and ordered by severity. Colour is optional and controlled by the caller.
 */
import { createColors } from 'picocolors';
import type { Finding, Severity } from '../types.js';
import type { WorkflowAnalysis } from '../types.js';
import type { ReportBundle } from './model.js';
import { formatDuration, confidenceLabel, SEVERITY_LABEL, countFindings } from './model.js';

type Colors = ReturnType<typeof createColors>;

function severityColor(colors: Colors, severity: Severity): (s: string) => string {
  switch (severity) {
    case 'critical':
      return (s) => colors.bold(colors.magenta(s));
    case 'high':
      return (s) => colors.bold(colors.red(s));
    case 'medium':
      return (s) => colors.yellow(s);
    case 'low':
      return (s) => colors.cyan(s);
  }
}

function renderFinding(colors: Colors, finding: Finding, lines: string[]): void {
  const sevColor = severityColor(colors, finding.severity);
  lines.push('');
  lines.push(`${sevColor(SEVERITY_LABEL[finding.severity])}  ${colors.bold(finding.title)}`);
  lines.push(`  id: ${colors.dim(finding.id)}  rule: ${colors.dim(finding.rule)}`);
  lines.push(`  ${finding.description}`);

  if (finding.evidence.length > 0) {
    lines.push(`  ${colors.dim('Evidence:')}`);
    for (const ev of finding.evidence.slice(0, 8)) {
      lines.push(`    - ${ev.label}${ev.detail ? ` ${colors.dim(`(${ev.detail})`)}` : ''}`);
    }
    if (finding.evidence.length > 8) {
      lines.push(`    - ${colors.dim(`… ${finding.evidence.length - 8} more`)}`);
    }
  }

  if (finding.savings) {
    const { minSeconds, maxSeconds, confidence, runsAnalyzed } = finding.savings;
    if (maxSeconds > 0) {
      const range =
        minSeconds === maxSeconds
          ? formatDuration(maxSeconds)
          : `${formatDuration(minSeconds)}–${formatDuration(maxSeconds)}`;
      lines.push(
        `  ${colors.dim('Estimated avoidable time:')} ${range} ` +
          colors.dim(
            `(${confidenceLabel(confidence)}${runsAnalyzed ? `, ${runsAnalyzed} runs` : ''})`,
          ),
      );
    } else {
      lines.push(`  ${colors.dim('Time impact:')} ${colors.dim(confidenceLabel(confidence))}`);
    }
  }

  if (finding.location?.line) {
    lines.push(`  ${colors.dim(`Location: ${finding.location.file}:${finding.location.line}`)}`);
  }

  lines.push(`  ${colors.dim('Recommendation:')}`);
  for (const rline of finding.recommendation.split('\n')) {
    lines.push(`    ${rline}`);
  }
}

function renderWorkflow(colors: Colors, analysis: WorkflowAnalysis, lines: string[]): void {
  const { workflow, criticalPath } = analysis;
  lines.push('');
  lines.push(colors.bold(colors.underline(`Workflow: ${workflow.name}`)));
  lines.push(`  File: ${workflow.path}`);
  lines.push(
    `  Estimated duration: ${colors.bold(formatDuration(analysis.estimatedDurationSeconds))} ` +
      colors.dim(`(${confidenceLabel(analysis.durationConfidence)})`),
  );
  if (criticalPath.path.length > 0) {
    lines.push(`  Critical path: ${criticalPath.path.join(' → ')}`);
  }
  if (criticalPath.nonCriticalJobs.length > 0) {
    lines.push(
      `  ${colors.dim(`Off critical path (no effect on total): ${criticalPath.nonCriticalJobs.join(', ')}`)}`,
    );
  }
  if (analysis.potentialSavingsSeconds > 0) {
    lines.push(
      `  Potential savings: ${colors.bold(colors.green(formatDuration(analysis.potentialSavingsSeconds)))} ` +
        colors.dim('(conservative sum of estimated savings; individual estimates may overlap)'),
    );
  }

  if (workflow.warnings.length > 0) {
    lines.push(`  ${colors.yellow('Warnings:')}`);
    for (const w of workflow.warnings) lines.push(`    - ${w}`);
  }

  const performance = analysis.findings.filter((f) => f.kind === 'performance');
  const security = analysis.findings.filter((f) => f.kind === 'security');

  if (performance.length === 0 && security.length === 0) {
    lines.push(`  ${colors.green('No findings.')}`);
    return;
  }

  if (performance.length > 0) {
    lines.push('');
    lines.push(colors.bold('Performance findings'));
    for (const f of performance) renderFinding(colors, f, lines);
  }
  if (security.length > 0) {
    lines.push('');
    lines.push(colors.bold(colors.red('Security findings')));
    for (const f of security) renderFinding(colors, f, lines);
  }
}

/** Render the full text report. */
export function renderTextReport(bundle: ReportBundle, useColor: boolean): string {
  const colors: Colors = useColor ? createColors(true) : createColors(false);
  const lines: string[] = [];

  lines.push(colors.bold('CACHEMAP REPORT'));
  lines.push(
    colors.dim(`Generated ${bundle.generatedAt}${bundle.repo ? ` for ${bundle.repo}` : ''}`),
  );
  lines.push(
    colors.dim(
      bundle.offline
        ? 'Mode: offline (static analysis only — timings are estimates)'
        : bundle.usedHistory
          ? 'Mode: online (incorporating historical run data)'
          : 'Mode: online (no historical data used — timings are estimates)',
    ),
  );

  if (bundle.warnings.length > 0) {
    lines.push('');
    for (const w of bundle.warnings) lines.push(colors.yellow(`! ${w}`));
  }

  for (const analysis of bundle.workflows) {
    renderWorkflow(colors, analysis, lines);
  }

  const counts = countFindings(bundle);
  lines.push('');
  lines.push(colors.dim('─'.repeat(60)));
  lines.push(
    `Summary: ${counts.performance} performance, ${counts.security} security ` +
      `(${counts.bySeverity.critical} critical, ${counts.bySeverity.high} high, ` +
      `${counts.bySeverity.medium} medium, ${counts.bySeverity.low} low)`,
  );
  lines.push(
    colors.dim(
      'Timing categories: measured = from history, estimated = heuristic, unknown = unsupported.',
    ),
  );
  lines.push(colors.dim('Run `cachemap explain <finding-id>` for details on any finding.'));

  return lines.join('\n');
}
