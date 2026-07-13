/**
 * SARIF 2.1.0 report. Valid for GitHub code scanning upload. Each CacheMap
 * rule becomes a SARIF reporting descriptor; each finding becomes a result with
 * a physical location (file/line) when known. Severity maps to SARIF `level`,
 * and security findings additionally carry a `security-severity` score.
 */
import type { Finding, Severity } from '../types.js';
import type { ReportBundle } from './model.js';

type SarifLevel = 'none' | 'note' | 'warning' | 'error';

function levelFor(severity: Severity): SarifLevel {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    case 'low':
      return 'note';
  }
}

/** GitHub code-scanning security-severity score (0–10) for security findings. */
function securitySeverityScore(severity: Severity): string {
  switch (severity) {
    case 'critical':
      return '9.5';
    case 'high':
      return '8.0';
    case 'medium':
      return '5.5';
    case 'low':
      return '3.0';
  }
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  defaultConfiguration: { level: SarifLevel };
  properties: Record<string, unknown>;
  helpUri: string;
}

function ruleTitle(rule: string): string {
  return rule
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function buildSarifReport(bundle: ReportBundle): Record<string, unknown> {
  const allFindings: Finding[] = bundle.workflows.flatMap((w) => w.findings);

  // Build a stable, de-duplicated rule catalogue.
  const ruleMap = new Map<string, SarifRule>();
  for (const f of allFindings) {
    if (ruleMap.has(f.rule)) continue;
    const rule: SarifRule = {
      id: f.rule,
      name: ruleTitle(f.rule),
      shortDescription: { text: f.title.replace(/`/g, '') },
      fullDescription: { text: f.description.replace(/`/g, '') },
      defaultConfiguration: { level: levelFor(f.severity) },
      properties: {
        kind: f.kind,
        ...(f.kind === 'security'
          ? { 'security-severity': securitySeverityScore(f.severity) }
          : {}),
        tags: [f.kind === 'security' ? 'security' : 'performance', 'github-actions', 'ci'],
      },
      helpUri: `https://github.com/kingsleychenlab/cachemap/blob/main/docs/RULES.md#${f.rule}`,
    };
    ruleMap.set(f.rule, rule);
  }
  const rules = [...ruleMap.values()];
  const ruleIndex = new Map<string, number>();
  rules.forEach((r, i) => ruleIndex.set(r.id, i));

  const results = allFindings.map((f) => {
    const region: Record<string, number> = {};
    if (f.location?.line) region['startLine'] = f.location.line;
    if (f.location?.column) region['startColumn'] = f.location.column;
    const messageText =
      `${f.description}\n\nRecommendation: ${f.recommendation}` +
      (f.savings && f.savings.maxSeconds > 0
        ? `\n\nEstimated avoidable time: ${f.savings.minSeconds}-${f.savings.maxSeconds}s (${f.savings.confidence}).`
        : '');
    return {
      ruleId: f.rule,
      ruleIndex: ruleIndex.get(f.rule) ?? 0,
      level: levelFor(f.severity),
      message: { text: messageText },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: f.location?.file ?? f.workflow, uriBaseId: 'SRCROOT' },
            ...(Object.keys(region).length > 0 ? { region } : {}),
          },
        },
      ],
      partialFingerprints: { cachemapFindingId: f.id },
      properties: {
        findingId: f.id,
        kind: f.kind,
        ...(f.savings ? { savingsConfidence: f.savings.confidence } : {}),
      },
    };
  });

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: bundle.tool.name,
            version: bundle.tool.version,
            informationUri: 'https://github.com/kingsleychenlab/cachemap',
            rules,
          },
        },
        originalUriBaseIds: {
          SRCROOT: { uri: 'file:///' },
        },
        results,
      },
    ],
  };
}

/** Render the SARIF report as a pretty-printed string. */
export function renderSarifReport(bundle: ReportBundle): string {
  return JSON.stringify(buildSarifReport(bundle), null, 2);
}
