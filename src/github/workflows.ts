/**
 * Resolve a repository workflow (by file path) to its numeric id via the
 * GitHub Actions API.
 */
import type { GitHubClient, RepoRef } from './client.js';
import { GitHubError } from './client.js';

export interface RemoteWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/** List all workflows configured in the repository. */
export async function listWorkflows(
  client: GitHubClient,
  repo: RepoRef,
): Promise<RemoteWorkflow[]> {
  const workflows = await client.paginate(async (page) => {
    const resp = await client.request((o) =>
      o.rest.actions.listRepoWorkflows({ owner: repo.owner, repo: repo.repo, per_page: 100, page }),
    );
    return resp.data.workflows;
  });
  return workflows.map((w) => ({ id: w.id, name: w.name, path: w.path, state: w.state }));
}

/**
 * Find the remote workflow whose path matches `workflowPath` (repo-relative) or
 * whose basename matches. Throws {@link GitHubError} when not found.
 */
export async function resolveWorkflow(
  client: GitHubClient,
  repo: RepoRef,
  workflowPath: string,
): Promise<RemoteWorkflow> {
  const all = await listWorkflows(client, repo);
  const exact = all.find((w) => w.path === workflowPath);
  if (exact) return exact;
  const base = basename(workflowPath);
  const byBase = all.find((w) => basename(w.path) === base);
  if (byBase) return byBase;
  throw new GitHubError(
    `Workflow "${workflowPath}" was not found in ${repo.owner}/${repo.repo}. ` +
      `Known workflows: ${all.map((w) => w.path).join(', ') || '(none)'}`,
    'not-found',
  );
}
