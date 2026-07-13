/**
 * Configuration loading and validation for `.cachemap.yml`.
 *
 * Unknown keys are rejected via Zod `.strict()` so that typos surface as
 * errors rather than silently doing nothing. Cost rates are treated as
 * user-provided estimates — there are no built-in GitHub billing defaults.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Severity } from './types.js';

const severitySchema = z.enum(['low', 'medium', 'high', 'critical']);

const thresholdsSchema = z
  .object({
    'minimum-estimated-savings-seconds': z.number().int().nonnegative().optional(),
    'fail-on': severitySchema.optional(),
  })
  .strict();

const costSchema = z
  .object({
    'linux-per-minute': z.number().nonnegative().optional(),
    'macos-per-minute': z.number().nonnegative().optional(),
    'windows-per-minute': z.number().nonnegative().optional(),
  })
  .strict();

const historySchema = z
  .object({
    runs: z.number().int().positive().optional(),
  })
  .strict();

const ignoreSchema = z
  .object({
    rules: z.array(z.string()).optional(),
    jobs: z.array(z.string()).optional(),
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1),
    workflows: z.array(z.string()).optional(),
    history: historySchema.optional(),
    ignore: ignoreSchema.optional(),
    thresholds: thresholdsSchema.optional(),
    cost: costSchema.optional(),
  })
  .strict();

export type RawConfig = z.infer<typeof configSchema>;

/** Fully-resolved configuration with defaults applied. */
export interface ResolvedConfig {
  version: 1;
  workflows: string[];
  historyRuns: number;
  ignoreRules: string[];
  ignoreJobs: string[];
  minimumSavingsSeconds: number;
  failOn: Severity;
  cost: {
    linuxPerMinute: number;
    macosPerMinute: number;
    windowsPerMinute: number;
  };
  /** Path the config was loaded from, or null when using defaults. */
  sourcePath: string | null;
}

/**
 * Default cost estimates. These are NOT authoritative GitHub billing rates —
 * they are conservative placeholders the user is expected to override.
 */
export const DEFAULT_COST = {
  linuxPerMinute: 0.008,
  macosPerMinute: 0.08,
  windowsPerMinute: 0.016,
};

export const DEFAULT_CONFIG: ResolvedConfig = {
  version: 1,
  workflows: [],
  historyRuns: 30,
  ignoreRules: [],
  ignoreJobs: [],
  minimumSavingsSeconds: 20,
  failOn: 'high',
  cost: { ...DEFAULT_COST },
  sourcePath: null,
};

const CONFIG_FILENAMES = ['.cachemap.yml', '.cachemap.yaml'];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Locate a config file in `dir`, returning its path or null. */
export function findConfigFile(dir: string): string | null {
  for (const name of CONFIG_FILENAMES) {
    const candidate = resolve(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      if (issue.code === 'unrecognized_keys') {
        return `Unknown key(s): ${(issue as z.ZodIssue & { keys?: string[] }).keys?.join(', ')}`;
      }
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/** Parse and validate config contents. Throws {@link ConfigError} on failure. */
export function parseConfig(contents: string, sourcePath: string): ResolvedConfig {
  let doc: unknown;
  try {
    doc = parseYaml(contents);
  } catch (err) {
    throw new ConfigError(
      `Failed to parse ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (doc === null || doc === undefined) {
    throw new ConfigError(`Config file ${sourcePath} is empty`);
  }
  const result = configSchema.safeParse(doc);
  if (!result.success) {
    throw new ConfigError(`Invalid config ${sourcePath}: ${formatZodError(result.error)}`);
  }
  return applyDefaults(result.data, sourcePath);
}

function applyDefaults(raw: RawConfig, sourcePath: string): ResolvedConfig {
  return {
    version: 1,
    workflows: raw.workflows ?? [],
    historyRuns: raw.history?.runs ?? DEFAULT_CONFIG.historyRuns,
    ignoreRules: raw.ignore?.rules ?? [],
    ignoreJobs: raw.ignore?.jobs ?? [],
    minimumSavingsSeconds:
      raw.thresholds?.['minimum-estimated-savings-seconds'] ?? DEFAULT_CONFIG.minimumSavingsSeconds,
    failOn: raw.thresholds?.['fail-on'] ?? DEFAULT_CONFIG.failOn,
    cost: {
      linuxPerMinute: raw.cost?.['linux-per-minute'] ?? DEFAULT_COST.linuxPerMinute,
      macosPerMinute: raw.cost?.['macos-per-minute'] ?? DEFAULT_COST.macosPerMinute,
      windowsPerMinute: raw.cost?.['windows-per-minute'] ?? DEFAULT_COST.windowsPerMinute,
    },
    sourcePath,
  };
}

/**
 * Load configuration from `dir`. Returns defaults (with `sourcePath: null`)
 * when no config file exists.
 */
export function loadConfig(dir: string): ResolvedConfig {
  const path = findConfigFile(dir);
  if (!path) {
    return { ...DEFAULT_CONFIG, cost: { ...DEFAULT_COST } };
  }
  const contents = readFileSync(path, 'utf8');
  return parseConfig(contents, path);
}

/** The JSON Schema equivalent, exposed by `cachemap schema --config`. */
export function configJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'CacheMap configuration',
    type: 'object',
    additionalProperties: false,
    required: ['version'],
    properties: {
      version: { const: 1 },
      workflows: { type: 'array', items: { type: 'string' } },
      history: {
        type: 'object',
        additionalProperties: false,
        properties: { runs: { type: 'integer', minimum: 1 } },
      },
      ignore: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rules: { type: 'array', items: { type: 'string' } },
          jobs: { type: 'array', items: { type: 'string' } },
        },
      },
      thresholds: {
        type: 'object',
        additionalProperties: false,
        properties: {
          'minimum-estimated-savings-seconds': { type: 'integer', minimum: 0 },
          'fail-on': { enum: ['low', 'medium', 'high', 'critical'] },
        },
      },
      cost: {
        type: 'object',
        additionalProperties: false,
        properties: {
          'linux-per-minute': { type: 'number', minimum: 0 },
          'macos-per-minute': { type: 'number', minimum: 0 },
          'windows-per-minute': { type: 'number', minimum: 0 },
        },
      },
    },
  };
}
