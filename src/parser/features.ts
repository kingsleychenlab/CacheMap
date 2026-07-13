/**
 * Feature extraction: interpreting parsed steps into higher-level constructs
 * (caches, artifacts, checkouts, dependency installs, service usage) that both
 * the graph builder and the analysis rules consume. Centralising step
 * interpretation keeps the individual analyses small and consistent.
 */
import type { JobModel, StepModel, SourceLocation } from '../types.js';

export type CacheMode = 'read-write' | 'restore-only' | 'save-only';

export interface CacheRef {
  jobId: string;
  stepIndex: number;
  /** Normalized action name, e.g. "actions/cache" or "actions/setup-node". */
  action: string;
  /** True for setup-action built-in caching (key managed by the action). */
  builtIn: boolean;
  /** Raw cache key expression (empty for built-in caches). */
  key: string;
  restoreKeys: string[];
  paths: string[];
  mode: CacheMode;
  /** For built-in caches: the ecosystem, e.g. "npm", "pip", "cargo". */
  builtInTool?: string;
  location?: SourceLocation;
}

export interface ArtifactRef {
  jobId: string;
  stepIndex: number;
  kind: 'upload' | 'download';
  /** Raw artifact name (may contain expressions). */
  name: string;
  paths: string[];
  retentionDays?: number;
  location?: SourceLocation;
}

export interface CheckoutRef {
  jobId: string;
  stepIndex: number;
  fetchDepth?: string;
  fetchTags?: boolean;
  submodules?: string;
  lfs?: boolean;
  persistCredentials?: boolean;
  location?: SourceLocation;
}

export type Ecosystem = 'node' | 'python' | 'rust' | 'ruby' | 'go';

export interface DependencyInstall {
  jobId: string;
  stepIndex: number;
  ecosystem: Ecosystem;
  /** The specific command line matched. */
  command: string;
  /** Normalized signature used to detect equivalent repeated installs. */
  signature: string;
  location?: SourceLocation;
}

const CACHE_ACTIONS = new Set(['actions/cache', 'actions/cache/restore', 'actions/cache/save']);

const SETUP_CACHE_TOOLS: Record<string, string[]> = {
  'actions/setup-node': ['npm', 'yarn', 'pnpm'],
  'actions/setup-python': ['pip', 'pipenv', 'poetry'],
  'actions/setup-java': ['maven', 'gradle', 'sbt'],
  'actions/setup-go': ['go'],
  'actions/setup-dotnet': ['nuget'],
};

function withNumber(step: StepModel, key: string): number | undefined {
  const v = step.with?.[key];
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function withBool(step: StepModel, key: string): boolean | undefined {
  const v = step.with?.[key];
  if (v === undefined) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function splitPaths(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Extract cache usages (explicit and setup-action built-in) from a job. */
export function extractCaches(job: JobModel): CacheRef[] {
  const caches: CacheRef[] = [];
  for (const step of job.steps) {
    const action = step.usesAction;
    if (!action) continue;
    if (CACHE_ACTIONS.has(action)) {
      const mode: CacheMode =
        action === 'actions/cache/restore'
          ? 'restore-only'
          : action === 'actions/cache/save'
            ? 'save-only'
            : 'read-write';
      const ref: CacheRef = {
        jobId: job.id,
        stepIndex: step.index,
        action,
        builtIn: false,
        key: step.with?.['key'] ?? '',
        restoreKeys: splitPaths(step.with?.['restore-keys']),
        paths: splitPaths(step.with?.['path']),
        mode,
        ...(step.location ? { location: step.location } : {}),
      };
      caches.push(ref);
      continue;
    }
    const tools = SETUP_CACHE_TOOLS[action];
    if (tools) {
      const cacheInput = step.with?.['cache'];
      if (cacheInput && cacheInput.trim() && cacheInput !== 'false') {
        caches.push({
          jobId: job.id,
          stepIndex: step.index,
          action,
          builtIn: true,
          key: '',
          restoreKeys: [],
          paths: [],
          mode: 'read-write',
          builtInTool: cacheInput,
          ...(step.location ? { location: step.location } : {}),
        });
      }
    }
    // Swatinem/rust-cache and ruby/setup-ruby bundler-cache are built-in too.
    if (action === 'Swatinem/rust-cache') {
      caches.push({
        jobId: job.id,
        stepIndex: step.index,
        action,
        builtIn: true,
        key: '',
        restoreKeys: [],
        paths: [],
        mode: 'read-write',
        builtInTool: 'cargo',
        ...(step.location ? { location: step.location } : {}),
      });
    }
    if (action === 'ruby/setup-ruby' && withBool(step, 'bundler-cache')) {
      caches.push({
        jobId: job.id,
        stepIndex: step.index,
        action,
        builtIn: true,
        key: '',
        restoreKeys: [],
        paths: [],
        mode: 'read-write',
        builtInTool: 'bundler',
        ...(step.location ? { location: step.location } : {}),
      });
    }
  }
  return caches;
}

/** Extract artifact upload/download steps from a job. */
export function extractArtifacts(job: JobModel): ArtifactRef[] {
  const artifacts: ArtifactRef[] = [];
  for (const step of job.steps) {
    const action = step.usesAction;
    if (!action) continue;
    const isUpload = action === 'actions/upload-artifact';
    const isDownload = action === 'actions/download-artifact';
    if (!isUpload && !isDownload) continue;
    const retention = withNumber(step, 'retention-days');
    artifacts.push({
      jobId: job.id,
      stepIndex: step.index,
      kind: isUpload ? 'upload' : 'download',
      name: step.with?.['name'] ?? (isDownload ? '*' : 'artifact'),
      paths: splitPaths(step.with?.['path']),
      ...(retention !== undefined ? { retentionDays: retention } : {}),
      ...(step.location ? { location: step.location } : {}),
    });
  }
  return artifacts;
}

/** Extract checkout steps from a job. */
export function extractCheckouts(job: JobModel): CheckoutRef[] {
  const checkouts: CheckoutRef[] = [];
  for (const step of job.steps) {
    if (step.usesAction !== 'actions/checkout') continue;
    const fetchDepth = step.with?.['fetch-depth'];
    const fetchTags = withBool(step, 'fetch-tags');
    const submodules = step.with?.['submodules'];
    const lfs = withBool(step, 'lfs');
    const persist = withBool(step, 'persist-credentials');
    checkouts.push({
      jobId: job.id,
      stepIndex: step.index,
      ...(fetchDepth !== undefined ? { fetchDepth } : {}),
      ...(fetchTags !== undefined ? { fetchTags } : {}),
      ...(submodules !== undefined ? { submodules } : {}),
      ...(lfs !== undefined ? { lfs } : {}),
      ...(persist !== undefined ? { persistCredentials: persist } : {}),
      ...(step.location ? { location: step.location } : {}),
    });
  }
  return checkouts;
}

interface InstallPattern {
  ecosystem: Ecosystem;
  re: RegExp;
  /** Signature builder — equivalent commands share a signature. */
  signature: string;
}

const INSTALL_PATTERNS: InstallPattern[] = [
  { ecosystem: 'node', re: /\bnpm\s+(ci|install|i)\b/, signature: 'node:npm' },
  { ecosystem: 'node', re: /\bpnpm\s+(install|i)\b/, signature: 'node:pnpm' },
  {
    ecosystem: 'node',
    re: /\byarn\s+(install|--frozen-lockfile|--immutable)\b/,
    signature: 'node:yarn',
  },
  { ecosystem: 'python', re: /\bpip3?\s+install\b/, signature: 'python:pip' },
  { ecosystem: 'python', re: /\bpython3?\s+-m\s+pip\s+install\b/, signature: 'python:pip' },
  { ecosystem: 'python', re: /\bpoetry\s+install\b/, signature: 'python:poetry' },
  { ecosystem: 'python', re: /\bpipenv\s+install\b/, signature: 'python:pipenv' },
  { ecosystem: 'rust', re: /\bcargo\s+fetch\b/, signature: 'rust:cargo-fetch' },
  { ecosystem: 'ruby', re: /\bbundle\s+install\b/, signature: 'ruby:bundle' },
  { ecosystem: 'go', re: /\bgo\s+mod\s+download\b/, signature: 'go:mod-download' },
];

/**
 * Detect dependency-installation commands in a job's `run` steps. Multiline
 * scripts are split into individual command lines before matching.
 */
export function extractDependencyInstalls(job: JobModel): DependencyInstall[] {
  const installs: DependencyInstall[] = [];
  for (const step of job.steps) {
    if (!step.run) continue;
    const lines = step.run.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      for (const pattern of INSTALL_PATTERNS) {
        if (pattern.re.test(line)) {
          installs.push({
            jobId: job.id,
            stepIndex: step.index,
            ecosystem: pattern.ecosystem,
            command: line,
            signature: pattern.signature,
            ...(step.location ? { location: step.location } : {}),
          });
          break; // one signature per line is enough
        }
      }
    }
  }
  return installs;
}

/** Normalize a run command for cross-job duplicate detection. */
export function normalizeCommand(command: string): string {
  return command
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}
