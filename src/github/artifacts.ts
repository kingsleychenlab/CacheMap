/**
 * Fetch repository artifact metadata (names and sizes) from recent runs. Used
 * to refine artifact findings with measured sizes when available.
 */
import type { GitHubClient, RepoRef } from './client.js';

export interface ArtifactStat {
  name: string;
  sizeBytes: number;
  expired: boolean;
  createdAt: string | null;
}

/** List recent artifacts for the repository (bounded by page limit). */
export async function fetchArtifacts(client: GitHubClient, repo: RepoRef): Promise<ArtifactStat[]> {
  const artifacts = await client.paginate(async (page) => {
    const resp = await client.request((o) =>
      o.rest.actions.listArtifactsForRepo({
        owner: repo.owner,
        repo: repo.repo,
        per_page: 100,
        page,
      }),
    );
    return resp.data.artifacts;
  });
  return artifacts.map((a) => ({
    name: a.name,
    sizeBytes: a.size_in_bytes,
    expired: a.expired,
    createdAt: a.created_at ?? null,
  }));
}

/** Average size (bytes) per artifact name across the fetched sample. */
export function averageSizeByName(artifacts: ArtifactStat[]): Map<string, number> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const a of artifacts) {
    const entry = sums.get(a.name) ?? { total: 0, count: 0 };
    entry.total += a.sizeBytes;
    entry.count += 1;
    sums.set(a.name, entry);
  }
  const out = new Map<string, number>();
  for (const [name, { total, count }] of sums) out.set(name, total / count);
  return out;
}
