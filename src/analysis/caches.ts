/**
 * Rule: cache-key quality analysis for `actions/cache` and setup-action
 * built-in caches.
 *
 * We never claim a cache "will work" — findings describe the evidence and the
 * likely behaviour. Historical cache statistics, when available, refine the
 * picture but are handled by the cache-history rule separately.
 */
import type { Finding, SourceLocation } from '../types.js';
import type { AnalysisInput } from './framework.js';
import { makeFinding, inferredSavings, unknownSavings } from './framework.js';
import { extractCaches } from '../parser/features.js';
import type { CacheRef } from '../parser/features.js';
import {
  extractHashFilesGlobs,
  containsExpression,
  referencesHashFiles,
} from '../parser/expressions.js';

const RULE_KEY = 'cache-key-quality';
const RULE_UNRESTORED = 'cache-saved-not-restored';
const RULE_DUPLICATE = 'cache-duplicated';
const RULE_BUILD_OUTPUT = 'cache-build-output';

const LOCKFILE_GLOBS = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'go.sum',
  'Gemfile.lock',
  'requirements.txt',
  'composer.lock',
  'gradle.lockfile',
];

const BROAD_GLOBS = ['**/*', '**', '**/*.*', '*'];

/** Heuristic: does a glob look like it hashes a lockfile? */
function looksLikeLockfile(glob: string): boolean {
  return LOCKFILE_GLOBS.some((lock) => glob.includes(lock));
}

/** Heuristic: does a cache path look like build output rather than deps? */
function looksLikeBuildOutput(path: string): boolean {
  return /(^|\/)(target|dist|build|out|\.next|coverage|node_modules\/\.cache)(\/|$)/.test(path);
}

function analyzeCacheKey(input: AnalysisInput, cache: CacheRef, seq: () => number): Finding[] {
  const findings: Finding[] = [];
  const key = cache.key;
  const location: SourceLocation | undefined = cache.location;

  const issues: string[] = [];
  const details: Record<string, string> = { key };

  const globs = extractHashFilesGlobs(key);
  const usesHashFiles = referencesHashFiles(key);

  if (!usesHashFiles && containsExpression(key)) {
    issues.push(
      'the key contains expressions but does not hash a lockfile, so it may not change when dependencies change (risking stale caches) or may change too often',
    );
  }
  if (!containsExpression(key) && key.length > 0) {
    issues.push(
      'the key is fully static, so the cache is never invalidated when dependencies change and can serve stale content',
    );
  }
  const broad = globs.filter((g) => BROAD_GLOBS.includes(g.trim()));
  if (broad.length > 0) {
    issues.push(
      `the key hashes an overly broad glob (${broad.join(', ')}), so unrelated file changes (docs, source) invalidate the cache on nearly every commit`,
    );
    details['broadGlobs'] = broad.join(', ');
  }
  if (usesHashFiles && globs.length > 0 && !globs.some(looksLikeLockfile)) {
    issues.push(
      'the key hashes files that do not look like a lockfile, so it may not track the actual dependency set',
    );
  }
  if (!/runner\.os|matrix\.os/.test(key) && key.length > 0) {
    issues.push(
      'the key omits an OS dimension (`runner.os`), so caches can be shared across incompatible operating systems',
    );
  }

  // Restore-keys that are too broad (bare prefix with trailing dash and nothing else specific).
  const broadRestore = cache.restoreKeys.filter(
    (rk) => /^[a-zA-Z0-9._-]*-$/.test(rk) && rk.split('-').filter(Boolean).length <= 1,
  );
  if (broadRestore.length > 0) {
    issues.push(
      `restore-keys are very broad (${broadRestore.join(', ')}), which can restore an unrelated or outdated cache`,
    );
    details['broadRestoreKeys'] = broadRestore.join(', ');
  }

  if (issues.length === 0) return findings;

  // Suggest an improved key when we can.
  const suggestion = suggestKey(cache);
  if (suggestion) details['suggestedKey'] = suggestion;
  details['issueCount'] = String(issues.length);

  const severity =
    broad.length > 0 || (!containsExpression(key) && key.length > 0) ? 'medium' : 'low';

  findings.push(
    makeFinding({
      rule: RULE_KEY,
      seq: seq(),
      kind: 'performance',
      severity,
      title: `Cache key in job \`${cache.jobId}\` is likely to behave poorly`,
      description: `Cache key analysis found ${issues.length} issue(s): ${issues.join('; ')}.`,
      recommendation: suggestion
        ? `Consider a key such as:\n${suggestion}\nAdjust the lockfile glob to your project. A poor key either serves stale caches or misses on nearly every run.`
        : 'Key the cache on the OS, architecture, runtime version, and a lockfile hash so it is invalidated exactly when dependencies change.',
      workflow: input.workflow.path,
      evidence: [{ label: `job ${cache.jobId}`, detail: key ? `key: ${key}` : 'built-in cache' }],
      ...(location ? { location } : {}),
      // A poor key mostly causes cache misses; the time impact depends on
      // dependency size and is not statically knowable.
      savings: unknownSavings(
        'Impact depends on cache size and hit rate, which require historical data (run `cachemap history`).',
      ),
      jobs: [cache.jobId],
      details,
    }),
  );
  return findings;
}

function suggestKey(cache: CacheRef): string | null {
  const tool = cache.builtInTool ?? guessTool(cache);
  const lockGlob = lockfileForTool(tool);
  if (!lockGlob) return null;
  return '${{ runner.os }}-' + `${tool ?? 'deps'}-` + `\${{ hashFiles('${lockGlob}') }}`;
}

function guessTool(cache: CacheRef): string | undefined {
  const joined = cache.paths.join(' ');
  if (/\.npm|node_modules/.test(joined)) return 'npm';
  if (/\.cargo|target/.test(joined)) return 'cargo';
  if (/\.cache\/pip|\.venv|site-packages/.test(joined)) return 'pip';
  if (/go\/pkg|go-build/.test(joined)) return 'go';
  if (/vendor\/bundle|\.gem/.test(joined)) return 'bundler';
  return undefined;
}

function lockfileForTool(tool: string | undefined): string | null {
  switch (tool) {
    case 'npm':
      return '**/package-lock.json';
    case 'yarn':
      return '**/yarn.lock';
    case 'pnpm':
      return '**/pnpm-lock.yaml';
    case 'cargo':
      return '**/Cargo.lock';
    case 'pip':
      return '**/requirements*.txt';
    case 'poetry':
      return '**/poetry.lock';
    case 'go':
      return '**/go.sum';
    case 'bundler':
      return '**/Gemfile.lock';
    default:
      return null;
  }
}

export function analyzeCaches(input: AnalysisInput): Finding[] {
  const findings: Finding[] = [];
  const jobs = input.workflow.jobs.filter((j) => !input.context.ignoredJobs.has(j.id));

  let keySeq = 1;
  const keySeqFn = () => keySeq++;

  const allCaches: CacheRef[] = [];
  for (const job of jobs) {
    const caches = extractCaches(job);
    allCaches.push(...caches);
    for (const cache of caches) {
      if (cache.builtIn) continue; // built-in caches manage their own key well
      findings.push(...analyzeCacheKey(input, cache, keySeqFn));

      // Cache path likely contains build output instead of dependencies.
      const buildPaths = cache.paths.filter(looksLikeBuildOutput);
      if (buildPaths.length > 0 && cache.paths.every(looksLikeBuildOutput)) {
        findings.push(
          makeFinding({
            rule: RULE_BUILD_OUTPUT,
            seq: keySeqFn(),
            kind: 'performance',
            severity: 'low',
            title: `Cache in job \`${cache.jobId}\` stores build output rather than dependencies`,
            description: `The cached path(s) (${buildPaths.join(', ')}) look like build output. Caching build output across commits often serves stale results because source changes are not reflected in dependency-oriented keys.`,
            recommendation:
              'Cache reusable dependency directories (package manager stores) rather than build output, or use a dedicated build-cache tool that keys on source inputs.',
            workflow: input.workflow.path,
            evidence: [{ label: `job ${cache.jobId}`, detail: `path: ${cache.paths.join(', ')}` }],
            ...(cache.location ? { location: cache.location } : {}),
            savings: unknownSavings(
              'Build-output caching correctness depends on inputs; time impact is not statically knowable.',
            ),
            jobs: [cache.jobId],
          }),
        );
      }
    }
  }

  // --- caches saved but never restored ----------------------------------
  let unrestoredSeq = 1;
  for (const cache of allCaches) {
    if (cache.mode !== 'save-only') continue;
    const key = cache.key;
    const restoredElsewhere = allCaches.some(
      (other) =>
        other !== cache &&
        (other.mode === 'restore-only' || other.mode === 'read-write') &&
        cacheKeysOverlap(other.key, key) &&
        cacheKeysOverlap(other.restoreKeys.join(' '), key),
    );
    const restoredByKey = allCaches.some(
      (other) =>
        other !== cache &&
        (other.mode === 'restore-only' || other.mode === 'read-write') &&
        other.key === key,
    );
    if (!restoredElsewhere && !restoredByKey) {
      findings.push(
        makeFinding({
          rule: RULE_UNRESTORED,
          seq: unrestoredSeq++,
          kind: 'performance',
          severity: 'low',
          title: `Cache saved in job \`${cache.jobId}\` is never restored`,
          description: `A save-only cache with key \`${key}\` was found, but no restore step references the same key. Saving a cache that is never restored wastes upload time and storage.`,
          recommendation:
            'Add a matching `actions/cache/restore` step, use `actions/cache` (which both restores and saves), or remove the save step if the cache is unused.',
          workflow: input.workflow.path,
          evidence: [{ label: `job ${cache.jobId}`, detail: `key: ${key}` }],
          ...(cache.location ? { location: cache.location } : {}),
          savings: inferredSavings(
            0,
            10,
            'Upper bound is the cache upload time avoided; depends on cache size. Inferred.',
          ),
          jobs: [cache.jobId],
        }),
      );
    }
  }

  // --- duplicated caches across jobs ------------------------------------
  const byKey = new Map<string, CacheRef[]>();
  for (const cache of allCaches) {
    if (cache.builtIn || !cache.key) continue;
    const list = byKey.get(cache.key) ?? [];
    list.push(cache);
    byKey.set(cache.key, list);
  }
  let dupSeq = 1;
  for (const [key, list] of byKey) {
    const distinctJobs = new Set(list.map((c) => c.jobId));
    if (distinctJobs.size >= 3 && key.length > 0) {
      findings.push(
        makeFinding({
          rule: RULE_DUPLICATE,
          seq: dupSeq++,
          kind: 'performance',
          severity: 'low',
          title: `Identical cache configuration duplicated across ${distinctJobs.size} jobs`,
          description: `The same cache key \`${key}\` is configured independently in ${distinctJobs.size} jobs. This is not wrong, but a shared restore in one upstream job (or a composite action) reduces duplication and drift.`,
          recommendation:
            'Consider centralising the cache restore in one place (a preparation job or composite action) to avoid the keys drifting out of sync.',
          workflow: input.workflow.path,
          evidence: [...distinctJobs].map((j) => ({ label: j })),
          savings: unknownSavings(
            'Duplication is a maintainability concern; time impact is not statically knowable.',
          ),
          jobs: [...distinctJobs],
        }),
      );
    }
  }

  return findings;
}

function cacheKeysOverlap(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}
