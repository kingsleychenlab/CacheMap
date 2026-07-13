/**
 * Fetch the repository's GitHub Actions cache list (keys, sizes, timestamps).
 * Cache metadata may be unavailable (permissions, none created yet); callers
 * handle an empty result gracefully.
 */
import type { GitHubClient, RepoRef } from './client.js';
import type { CacheStats } from '../types.js';
import { GitHubError } from './client.js';

export interface FetchCachesResult {
  caches: CacheStats[];
  unavailable: boolean;
}

/** List Actions caches for the repository (best-effort). */
export async function fetchCaches(client: GitHubClient, repo: RepoRef): Promise<FetchCachesResult> {
  try {
    const caches = await client.paginate(async (page) => {
      const resp = await client.request((o) =>
        o.rest.actions.getActionsCacheList({
          owner: repo.owner,
          repo: repo.repo,
          per_page: 100,
          page,
          sort: 'last_accessed_at',
        }),
      );
      return resp.data.actions_caches;
    });
    return {
      caches: caches.map((c) => ({
        key: c.key ?? '',
        ...(c.ref ? { ref: c.ref } : {}),
        sizeBytes: c.size_in_bytes ?? 0,
        ...(c.created_at ? { createdAt: c.created_at } : {}),
        ...(c.last_accessed_at ? { lastAccessedAt: c.last_accessed_at } : {}),
      })),
      unavailable: false,
    };
  } catch (err) {
    if (err instanceof GitHubError && (err.kind === 'not-found' || err.kind === 'auth')) {
      return { caches: [], unavailable: true };
    }
    throw err;
  }
}
