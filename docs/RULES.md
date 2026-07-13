# Rule reference

Each finding carries a stable `rule` id and a deterministic finding id
(`<rule>-<n>`). Use `cachemap explain <finding-id>` for the full evidence and
recommendation. Performance findings may include a savings estimate with a
confidence category (`measured`, `inferred`, `unknown`); security findings are
reported separately and never carry a time-savings number.

Severities below are defaults; the actual severity of a finding can vary with
its evidence (for example, an install repeated across 3+ jobs is `high`, across
2 jobs is `medium`).

## Repeated work

### repeated-dependency-install
**Default: high/medium · performance.** The same dependency-install command
(`npm ci`, `pnpm install`, `yarn install`, `pip install`, `poetry install`,
`cargo fetch`, `bundle install`, `go mod download`) runs in multiple jobs
without a shared preparation job or a cache reused across jobs. Savings are
inferred from the number of redundant installs.

### repeated-command
**Default: low · performance.** An identical multi-line `run` script is
duplicated across three or more jobs. Often a candidate for a composite action.

## Caches

### cache-key-quality
**Default: medium/low · performance.** Cache-key problems: overly broad
`hashFiles` globs (`**/*`), fully static keys, keys that do not hash a lockfile,
missing OS dimension, or overly broad `restore-keys`. CacheMap suggests an
improved key but never claims a cache "will work" — impact depends on cache size
and hit rate (`unknown` without history).

### cache-build-output
**Default: low · performance.** An `actions/cache` path looks like build output
(`target/`, `dist/`, `.next/`) rather than reusable dependencies, which often
serves stale results.

### cache-saved-not-restored
**Default: low · performance.** A save-only cache (`actions/cache/save`) whose
key is never restored by any `actions/cache` or `actions/cache/restore` step.

### cache-duplicated
**Default: low · performance.** The same explicit cache key is configured
independently in three or more jobs — a maintainability/drift concern.

### cache-frequently-invalidated
**Default: medium · performance · measured.** From the Actions cache list: a key
family with many distinct entries, indicating the key changes too often and most
runs miss the cache. Requires a token.

### cache-large-history
**Default: low · performance · measured.** A cache entry that is unusually large
(≥ 500 MB), whose restore/save time may offset its benefit. Requires a token.

## Matrices

### matrix-duplicate-combination
**Default: medium · performance.** The matrix expands to identical combinations
that run the same work more than once.

### matrix-single-value-dimension
**Default: low · performance.** A matrix dimension with a single value adds no
execution variation.

### matrix-large
**Default: medium · performance.** A matrix expands to a large number of
combinations (≥ 20); the right subset is a coverage decision, not automatic.

### matrix-fail-fast-disabled
**Default: low · performance.** `fail-fast: false` runs every combination to
completion even after one fails, increasing compute on failing runs.

## Parallelism

### unnecessary-serialization
**Default: medium · performance.** A job declares `needs:` on a single parent
but downloads no artifact from it, so the dependency may exist only to order
execution. CacheMap will not recommend parallelizing across a real artifact
dependency.

### fan-in-bottleneck
**Default: medium · performance.** A job on the critical path that three or more
jobs depend on — everything downstream waits for it.

## Artifacts

### artifact-unused
**Default: medium · performance.** An artifact is uploaded but no job downloads
it (and there is no wildcard download).

### artifact-broad-path
**Default: low · performance.** An upload path is very broad (`.`, `**`), likely
capturing far more than consumers need.

### artifact-dependencies
**Default: medium · performance.** A dependency directory (`node_modules`,
`vendor/bundle`, `.venv`) is uploaded as an artifact; a cache is usually better.

### artifact-excessive-retention
**Default: low · performance.** A short-lived artifact keeps a long retention
period (> 14 days), increasing storage usage.

### artifact-duplicate-name
**Default: medium · performance.** A matrix job uploads a constant artifact name
across variants; since upload-artifact v4 this collides or overwrites.

## Checkout

### checkout-full-history
**Default: low · performance.** `fetch-depth: 0` when no step appears to use git
history, tags, or merge-base information.

### checkout-repeated
**Default: low · performance.** `actions/checkout` runs multiple times in one
job.

### checkout-submodules
**Default: low · performance.** Submodules fetched in a job that may not need
them.

### checkout-lfs
**Default: low · performance.** Git LFS objects fetched in a job that may not
need them.

### checkout-persist-credentials
**Default: low · security.** `actions/checkout` persists the token by default in
a job that does not push back to the repository, widening token exposure.

## Triggers

### trigger-missing-path-filter
**Default: low · performance.** A push/PR workflow with no `paths`/`paths-ignore`
filter runs even on documentation-only changes.

### trigger-duplicate-push-pr
**Default: medium · performance.** Both `push` and `pull_request` fire for
branches with an open PR, running the whole workflow twice per commit.

### trigger-frequent-schedule
**Default: low · performance.** A cron schedule runs many times per hour.

### trigger-missing-concurrency
**Default: medium · performance.** A PR workflow without a `concurrency` group
that sets `cancel-in-progress: true`; superseded runs keep executing.

## Steps

### expensive-before-validation
**Default: low · performance.** An expensive step (build/test/install) runs
before a cheap validation step (lint/format/typecheck) that could fail fast.

### repeated-setup-action
**Default: low · performance.** The same `actions/setup-*` runs multiple times
in one job.

## Services

### service-unused
**Default: low · performance.** A recognised service container (Postgres, MySQL,
Redis, Mongo, …) is started but no step references its host, port, or env.

### service-missing-healthcheck
**Default: low · performance.** A service container defines no health check, so
steps may start before it is ready (flaky failures and retries).

### service-per-matrix
**Default: low · performance.** Service containers start for every matrix
combination of a job when only some combinations need them.

## Permissions & safety (security findings)

These are reported separately from performance findings and never carry a
time-savings value.

### permissions-blanket-write
**Default: high · security.** Top-level `permissions: write-all` grants the token
write access to every scope.

### permissions-top-level-broad
**Default: medium · security.** Top-level scoped write permissions apply to every
job, including read-only ones.

### permissions-excessive-write
**Default: medium · security.** A job requests write permissions but no step
appears to push, release, or otherwise write to GitHub.

### pull-request-target-checkout
**Default: critical · security.** A `pull_request_target` workflow (which has
secrets and a write token) checks out the PR head ref, risking execution of
untrusted code with secrets.
