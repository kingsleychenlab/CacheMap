/**
 * Shared CLI helpers: config loading, output writing, format validation, and
 * threshold/exit-code computation. Keeping these here keeps command handlers
 * small and consistent.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Severity } from '../types.js';
import { SEVERITY_ORDER } from '../types.js';
import type { ResolvedConfig } from '../config.js';
import { loadConfig, parseConfig, ConfigError, DEFAULT_CONFIG, DEFAULT_COST } from '../config.js';
import { readFileSync } from 'node:fs';
import type { ReportBundle } from '../reports/model.js';

export type ReportFormat = 'text' | 'json' | 'markdown' | 'sarif';
export type GraphFormat = 'mermaid' | 'dot' | 'json';

export const REPORT_FORMATS: ReportFormat[] = ['text', 'json', 'markdown', 'sarif'];
export const GRAPH_FORMATS: GraphFormat[] = ['mermaid', 'dot', 'json'];

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** Load config from an explicit path or by discovery in `cwd`. */
export function loadCliConfig(cwd: string, explicitPath: string | undefined): ResolvedConfig {
  try {
    if (explicitPath) {
      const abs = resolve(cwd, explicitPath);
      return parseConfig(readFileSync(abs, 'utf8'), abs);
    }
    return loadConfig(cwd);
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new CliError(err.message, 2);
    }
    throw new CliError(
      `Failed to load configuration: ${err instanceof Error ? err.message : String(err)}`,
      2,
    );
  }
}

/** Validate a --format value against an allowed set. */
export function validateFormat<T extends string>(
  value: string | undefined,
  allowed: T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if ((allowed as string[]).includes(value)) return value as T;
  throw new CliError(`Invalid --format "${value}". Expected one of: ${allowed.join(', ')}.`, 2);
}

/** Validate a --fail-on value. */
export function validateFailOn(value: string | undefined, fallback: Severity): Severity {
  if (value === undefined) return fallback;
  if (['low', 'medium', 'high', 'critical'].includes(value)) return value as Severity;
  throw new CliError(`Invalid --fail-on "${value}". Expected low, medium, high, or critical.`, 2);
}

/** Write output to a file or stdout. */
export function emit(content: string, outputPath: string | undefined, cwd: string): void {
  if (outputPath) {
    writeFileSync(resolve(cwd, outputPath), content, 'utf8');
    console.error(`Wrote report to ${outputPath}`);
  } else {
    process.stdout.write(content.endsWith('\n') ? content : content + '\n');
  }
}

/** True when `severity` meets or exceeds the `failOn` threshold. */
export function meetsThreshold(severity: Severity, failOn: Severity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[failOn];
}

/**
 * Compute the process exit code from a bundle and threshold:
 * 1 when any finding meets the threshold, otherwise 0.
 */
export function computeExitCode(bundle: ReportBundle, failOn: Severity): number {
  const triggered = bundle.workflows.some((w) =>
    w.findings.some((f) => meetsThreshold(f.severity, failOn)),
  );
  return triggered ? 1 : 0;
}

/** Parse a positive integer option or throw a CLI error. */
export function parsePositiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliError(`Invalid ${name} "${value}" (expected a positive integer).`, 2);
  }
  return n;
}

/** Whether colour should be used (respects --no-color and NO_COLOR/TTY). */
export function shouldUseColor(colorFlag: boolean | undefined): boolean {
  if (colorFlag === false) return false;
  if (process.env['NO_COLOR']) return false;
  return Boolean(process.stdout.isTTY);
}

export { DEFAULT_CONFIG, DEFAULT_COST };
