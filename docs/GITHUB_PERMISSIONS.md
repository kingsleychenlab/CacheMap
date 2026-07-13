# GitHub API permissions

CacheMap's **static analysis needs no credentials at all**. A token is only used
to add *measured* data: historical run timing and the Actions cache list.

## What the token is used for

| Data | Endpoint | Purpose |
| --- | --- | --- |
| Workflows | `GET /repos/{owner}/{repo}/actions/workflows` | Resolve a workflow file to its id. |
| Runs | `GET /repos/{owner}/{repo}/actions/workflows/{id}/runs` | Recent completed runs. |
| Jobs | `GET /repos/{owner}/{repo}/actions/runs/{id}/jobs` | Per-job start/finish times. |
| Caches | `GET /repos/{owner}/{repo}/actions/caches` | Cache keys, sizes, timestamps. |
| Artifacts | `GET /repos/{owner}/{repo}/actions/artifacts` | Artifact names and sizes. |
| Repo | `GET /repos/{owner}/{repo}` | Connectivity check (`doctor`). |

All calls are **read-only**.

## Required scopes

- **Fine-grained personal access token** (recommended): grant the repository
  **Actions: Read-only** and **Metadata: Read-only** permissions.
- **Classic PAT**: the `repo` scope covers private repositories; public
  repositories work with `public_repo` (or no scope for public read).
- **In a workflow** (`GITHUB_TOKEN`): `permissions: actions: read` is sufficient
  for history. The default job token works for the same repository.

```yaml
permissions:
  contents: read
  actions: read   # only needed for historical analysis
```

## Providing the token

CacheMap reads the token from, in order:

1. `--token <token>`
2. `GITHUB_TOKEN`
3. `GH_TOKEN`

If none is present (or `--offline` is set), CacheMap runs static analysis only
and clearly marks all timing as estimated.

## Safety

- The token is **never printed** and is **redacted** from any error or log
  output (replaced with `***REDACTED***`).
- API pagination and retries are bounded; rate-limit responses back off and then
  produce a clear, actionable error rather than hanging.
- Cache metadata that is unavailable (insufficient permissions, or none created
  yet) is handled gracefully — the run continues with a warning.
- CacheMap does not cache API responses to disk unless you explicitly opt in
  (no local response cache is written by default).
