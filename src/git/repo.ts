/**
 * Git repository detection and safe helpers. We never execute repository code
 * or workflow steps — we only inspect files and read git metadata to detect
 * the repository root and (best-effort) the owner/repo slug from the origin
 * remote. Shallow clones are detected so that history-dependent findings can
 * warn rather than mislead.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface GitInfo {
  root: string;
  isShallow: boolean;
  remoteSlug: string | null;
  currentRef: string | null;
}

function runGit(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * Walk upwards from `startDir` to find a directory containing `.github`.
 * Used as a fallback when git is unavailable (e.g. an unpacked tarball).
 */
function findByGithubDir(startDir: string): string | null {
  let current = resolve(startDir);
  // Bound the walk to avoid pathological loops.
  for (let i = 0; i < 64; i++) {
    if (existsSync(resolve(current, '.github', 'workflows'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** Parse an origin URL into an "owner/repo" slug, or null. */
export function parseRemoteSlug(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, '');
  // git@github.com:owner/repo
  const sshMatch = /^git@[^:]+:([^/]+)\/(.+)$/.exec(trimmed);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;
  // https://github.com/owner/repo or ssh://git@host/owner/repo
  const urlMatch = /^(?:https?|ssh|git):\/\/[^/]+\/([^/]+)\/(.+)$/.exec(trimmed);
  if (urlMatch) return `${urlMatch[1]}/${urlMatch[2]}`;
  return null;
}

/**
 * Detect git information starting at `startDir`. Returns null when no
 * repository (and no `.github/workflows`) can be located.
 */
export function detectRepo(startDir: string): GitInfo | null {
  const topLevel = runGit(['rev-parse', '--show-toplevel'], startDir);
  let root = topLevel;

  if (!root) {
    root = findByGithubDir(startDir);
    if (!root) return null;
    return { root, isShallow: false, remoteSlug: null, currentRef: null };
  }

  const shallowFlag = runGit(['rev-parse', '--is-shallow-repository'], root);
  const isShallow = shallowFlag === 'true';

  const originUrl = runGit(['config', '--get', 'remote.origin.url'], root);
  const remoteSlug = originUrl ? parseRemoteSlug(originUrl) : null;

  const currentRef = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root);

  return {
    root,
    isShallow,
    remoteSlug,
    currentRef: currentRef && currentRef !== 'HEAD' ? currentRef : null,
  };
}

/** True when `.git` exists and is a real repo directory. */
export function isGitRepository(dir: string): boolean {
  const gitPath = resolve(dir, '.git');
  if (!existsSync(gitPath)) return false;
  try {
    // `.git` is a directory in normal repos and a file in worktrees/submodules.
    statSync(gitPath);
    return true;
  } catch {
    return false;
  }
}
