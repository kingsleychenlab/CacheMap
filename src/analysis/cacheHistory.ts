/**
 * Rule: cache-history analysis. Uses MEASURED data from the GitHub Actions
 * cache list (sizes, key families, last-access) to surface frequently
 * invalidated keys and unusually large caches. When no cache metadata is
 * available this rule produces nothing (handled gracefully).
 */
import type { Finding, CacheStats } from '../types.js';
import type { AnalysisInput } from './framework.js';
import { makeFinding, measuredSavings, unknownSavings } from './framework.js';

const RULE_INVALIDATION = 'cache-frequently-invalidated';
const RULE_LARGE = 'cache-large-history';

/**
 * Reduce a concrete cache key to its "family" — the stable prefix before the
 * volatile hash segment. Used to count how often a key family is invalidated.
 */
function keyFamily(key: string): string {
  const segments = key.split('-');
  // Drop a trailing segment that looks like a content hash.
  if (segments.length > 1) {
    const last = segments[segments.length - 1] ?? '';
    if (/^[0-9a-f]{8,}$/i.test(last)) {
      return segments.slice(0, -1).join('-');
    }
  }
  return key;
}

const MB = 1024 * 1024;

export function analyzeCacheHistory(input: AnalysisInput): Finding[] {
  const caches: CacheStats[] = input.context.cacheStats ?? [];
  if (caches.length === 0) return [];

  const findings: Finding[] = [];
  const runsAnalyzed = input.history?.runsAnalyzed ?? 0;

  // --- frequently invalidated key families ------------------------------
  const families = new Map<string, CacheStats[]>();
  for (const cache of caches) {
    const family = keyFamily(cache.key);
    const list = families.get(family) ?? [];
    list.push(cache);
    families.set(family, list);
  }

  let invSeq = 1;
  for (const [family, list] of families) {
    if (list.length >= 5) {
      const avgSizeMb = list.reduce((sum, c) => sum + c.sizeBytes, 0) / list.length / MB;
      findings.push(
        makeFinding({
          rule: RULE_INVALIDATION,
          seq: invSeq++,
          kind: 'performance',
          severity: 'medium',
          title: `Cache key family \`${family}-*\` was invalidated ${list.length} times`,
          description: `The GitHub cache list shows ${list.length} distinct caches under the key family \`${family}-*\`. A key that changes this often produces frequent cache misses, so most runs rebuild from scratch instead of restoring.`,
          recommendation:
            'Narrow the hashed inputs so the key only changes when dependencies actually change (e.g. hash the lockfile, not source files), and add stable `restore-keys` for partial hits.',
          workflow: input.workflow.path,
          evidence: list
            .slice(0, 5)
            .map((c) => ({ label: c.key, detail: `${(c.sizeBytes / MB).toFixed(1)} MB` })),
          savings: measuredSavings(
            0,
            Math.round(avgSizeMb * 0.1),
            runsAnalyzed,
            `Measured from ${list.length} cache entries (avg ${avgSizeMb.toFixed(1)} MB). Upper bound approximates restore time recoverable if misses became hits.`,
          ),
          details: {
            family,
            distinctCaches: String(list.length),
            avgSizeMb: avgSizeMb.toFixed(1),
          },
        }),
      );
    }
  }

  // --- unusually large caches -------------------------------------------
  let largeSeq = 1;
  const LARGE_CACHE_MB = 500;
  for (const cache of caches) {
    const sizeMb = cache.sizeBytes / MB;
    if (sizeMb >= LARGE_CACHE_MB) {
      findings.push(
        makeFinding({
          rule: RULE_LARGE,
          seq: largeSeq++,
          kind: 'performance',
          severity: 'low',
          title: `Cache \`${cache.key}\` is large (${sizeMb.toFixed(0)} MB)`,
          description: `The cache \`${cache.key}\` is ${sizeMb.toFixed(0)} MB. Large caches take longer to restore and save, which can offset their benefit if the restored data is not fully used.`,
          recommendation:
            'Confirm the cache only contains reusable dependencies (not build output or the full workspace), and split or scope it if it has grown large.',
          workflow: input.workflow.path,
          evidence: [{ label: cache.key, detail: `${sizeMb.toFixed(0)} MB` }],
          savings: unknownSavings(
            'Whether a large cache helps or hurts depends on restore time vs. rebuild time; requires per-run timing.',
          ),
          details: { sizeMb: sizeMb.toFixed(0) },
        }),
      );
    }
  }

  return findings;
}
