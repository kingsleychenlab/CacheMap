/**
 * Workflow file discovery. Locates YAML files under `.github/workflows/`
 * relative to a repository root. Refuses to follow paths that escape the
 * repository root (defence against `../` traversal in user-supplied paths).
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';

const WORKFLOW_DIR = join('.github', 'workflows');
const YAML_EXT = /\.ya?ml$/i;

export interface DiscoveredWorkflow {
  /** Absolute path on disk. */
  absolutePath: string;
  /** Repository-relative path with POSIX separators. */
  relativePath: string;
}

/** True when `child` is contained within `root` (no traversal escape). */
export function isWithinRoot(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Discover all workflow YAML files under `.github/workflows/`. */
export function discoverWorkflows(root: string): DiscoveredWorkflow[] {
  const dir = resolve(root, WORKFLOW_DIR);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const results: DiscoveredWorkflow[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry);
    let isFile = false;
    try {
      isFile = statSync(abs).isFile();
    } catch {
      continue;
    }
    if (isFile && YAML_EXT.test(entry)) {
      results.push({
        absolutePath: abs,
        relativePath: toPosix(relative(root, abs)),
      });
    }
  }
  // Deterministic ordering by path.
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

/**
 * Resolve an explicit workflow path argument (which may be absolute, relative
 * to cwd, or a bare filename in `.github/workflows/`). Enforces containment.
 */
export function resolveWorkflowPath(root: string, input: string, cwd: string): DiscoveredWorkflow {
  const candidates: string[] = [];
  if (isAbsolute(input)) {
    candidates.push(input);
  } else {
    candidates.push(resolve(cwd, input));
    candidates.push(resolve(root, input));
    candidates.push(resolve(root, WORKFLOW_DIR, input));
  }
  for (const abs of candidates) {
    if (existsSync(abs) && statSync(abs).isFile()) {
      if (!isWithinRoot(root, abs)) {
        throw new DiscoveryError(`Refusing to analyze workflow outside repository root: ${input}`);
      }
      return { absolutePath: abs, relativePath: toPosix(relative(root, abs)) };
    }
  }
  throw new DiscoveryError(`Workflow file not found: ${input}`);
}
