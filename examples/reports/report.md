# CacheMap report

_Generated 2026-07-13T00:21:13.980Z · static analysis_

| | Count |
| --- | --- |
| Performance findings | 11 |
| Security findings | 4 |
| Critical / High | 0 / 1 |
| Medium / Low | 6 / 8 |

## CI

`.github/workflows/ci.yml`

| Metric | Value |
| --- | --- |
| Estimated duration | 4m 45s (estimated) |
| Critical path | setup → lint → build |
| Potential savings | 24s |
| Findings | 15 |

### Performance findings

#### 🟠 **HIGH** node dependencies installed in 4 jobs

`repeated-dependency-install-1` · rule `repeated-dependency-install`

The dependency-install command "node:npm" runs in 4 separate jobs. Without a shared dependency-preparation job or a cache reused across jobs, each job pays the full installation cost.

**Evidence:**
- lint
- setup
- test
- build

**Estimated avoidable time:** 24s–2m (estimated)

<sub>Static estimate: 3 redundant install(s) × 8-40s per install (some jobs already cache dependencies). No historical timing available.</sub>

<sub>Location: `.github/workflows/ci.yml:15`</sub>

**Recommendation:**

```
Create one dependency-preparation job (or reuse a dependency cache keyed by lockfile, OS, architecture, and runtime version) and have downstream jobs restore from it instead of installing from scratch.
```

#### 🟡 **MEDIUM** Push and pull_request triggers may double-run the workflow

`trigger-duplicate-push-pr-1` · rule `trigger-duplicate-push-pr`

The workflow runs on both `push` and `pull_request`. For branches with an open pull request, both events fire, running the entire workflow twice for the same commit.

**Evidence:**
- push — all branches
- pull_request — all branches

**Estimated avoidable time:** 0s–4m 45s (estimated)

<sub>Upper bound is one full duplicate run (~285s estimated) avoided per PR commit. Inferred.</sub>

**Recommendation:**

```
Restrict `push` to protected branches (e.g. `branches: [main]`) and rely on `pull_request` for feature branches, or add a concurrency group that cancels superseded runs.
```

#### 🟡 **MEDIUM** No concurrency cancellation for superseded pull-request runs

`trigger-missing-concurrency-1` · rule `trigger-missing-concurrency`

This pull-request workflow has no `concurrency` group with `cancel-in-progress: true`, so pushing new commits to a PR leaves outdated runs executing to completion alongside the new one.

**Evidence:**
- concurrency — not configured

**Estimated avoidable time:** 0s–4m 45s (estimated)

<sub>Upper bound is one full superseded run (~285s estimated) avoided per rapid push. Inferred.</sub>

**Recommendation:**

```
Add:
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
so a new push cancels the in-progress run for the same ref.
```

#### 🟡 **MEDIUM** Job `lint` may be serialized behind `setup` unnecessarily

`unnecessary-serialization-1` · rule `unnecessary-serialization`

Job `lint` declares `needs: setup` but does not download any artifact from it, so the dependency may exist only to order execution. If `lint` does not actually consume `setup`'s results, the two could run in parallel.

**Evidence:**
- lint — needs: setup
- setup — no artifact consumed by dependent

**Estimated avoidable time:** 0s–1m 7s (estimated)

<sub>Upper bound is the full duration of `setup` (~67s estimated) if the two ran in parallel. Only valid if the dependency is truly ordering-only. Inferred.</sub>

<sub>Location: `.github/workflows/ci.yml:10`</sub>

**Recommendation:**

```
Confirm whether `lint` requires `setup` to have completed. If not, remove the `needs` entry so both jobs start immediately. Do not remove it if `setup` produces state `lint` relies on.
```

#### 🟡 **MEDIUM** Artifact `coverage-results` is uploaded but never downloaded

`artifact-unused-1` · rule `artifact-unused`

Job `test` uploads artifact `coverage-results`, but no job downloads it. Uploading an artifact that is never consumed wastes upload time and storage.

**Evidence:**
- job test — uploads: coverage-results

**Estimated avoidable time:** 0s–15s (estimated)

<sub>Upper bound is the artifact upload time avoided; actual size is unknown without history. Inferred.</sub>

<sub>Location: `.github/workflows/ci.yml:40`</sub>

**Recommendation:**

```
Remove the upload if the artifact is not needed downstream, or if it is only used for debugging, gate it behind a condition and a short retention period.
```

#### 🟡 **MEDIUM** Matrix job `test` uploads a constant artifact name `coverage-results`

`artifact-duplicate-name-1` · rule `artifact-duplicate-name`

Job `test` runs 3 matrix combinations but uploads artifact `coverage-results` with a fixed name. Since upload-artifact v4, duplicate names within a run fail or overwrite; either way the per-variant results collide.

**Evidence:**
- job test — 3 variants upload `coverage-results`

**Time impact:** unknown — This is a correctness/collision issue, not a direct time saving.

<sub>Location: `.github/workflows/ci.yml:26`</sub>

**Recommendation:**

```
Include a matrix value in the artifact name (e.g. `name: coverage-results-${{ matrix.os }}-${{ matrix.version }}`) so each variant produces a distinct artifact.
```

#### 🟡 **MEDIUM** Cache key in job `build` is likely to behave poorly

`cache-key-quality-1` · rule `cache-key-quality`

Cache key analysis found 2 issue(s): the key hashes an overly broad glob (**/*), so unrelated file changes (docs, source) invalidate the cache on nearly every commit; the key hashes files that do not look like a lockfile, so it may not track the actual dependency set.

**Evidence:**
- job build — key: ${{ runner.os }}-${{ hashFiles('**/*') }}

**Time impact:** unknown — Impact depends on cache size and hit rate, which require historical data (run `cachemap history`).

<sub>Location: `.github/workflows/ci.yml:53`</sub>

**Recommendation:**

```
Consider a key such as:
${{ runner.os }}-npm-${{ hashFiles('**/package-lock.json') }}
Adjust the lockfile glob to your project. A poor key either serves stale caches or misses on nearly every run.
```

#### 🔵 **LOW** Job `test` fetches full git history unnecessarily

`checkout-full-history-1` · rule `checkout-full-history`

`actions/checkout` uses `fetch-depth: 0` (full history) in job `test`, but no step in the job appears to use git history, tags, or merge-base information. Full history is slow to fetch on large repositories.

**Evidence:**
- job test — fetch-depth: 0

**Estimated avoidable time:** 0s–30s (estimated)

<sub>Upper bound is the extra fetch time on a large repository; small repos see little difference. Inferred.</sub>

<sub>Location: `.github/workflows/ci.yml:32`</sub>

**Recommendation:**

```
Remove `fetch-depth: 0` (the default shallow checkout is faster) unless a step needs full history, tags, or merge-base — in which case keep it.
```

#### 🔵 **LOW** Cheap validation runs after an expensive step in job `lint`

`expensive-before-validation-1` · rule `expensive-before-validation`

In job `lint`, an expensive step (step 2) runs before a cheap validation step (step 3). If the cheap check often fails, running it first would fail the job sooner and save the expensive work.

**Evidence:**
- job lint — expensive: step 2
- job lint — validation: step 3

**Estimated avoidable time:** 0s–30s (estimated)

<sub>Savings only apply on runs where the cheap check fails; magnitude depends on failure rate. Inferred.</sub>

<sub>Location: `.github/workflows/ci.yml:16`</sub>

**Recommendation:**

```
Run fast checks (lint, format, typecheck) before expensive build/test steps so failures surface early.
```

#### 🔵 **LOW** `fail-fast: false` in job `test`

`matrix-fail-fast-disabled-1` · rule `matrix-fail-fast-disabled`

Job `test` disables fail-fast, so every matrix combination runs to completion even after one fails. This is useful for gathering full test results but increases compute usage on failing runs.

**Evidence:**
- job test — strategy.fail-fast: false

**Time impact:** unknown — Only matters on failing runs; time impact depends on failure frequency (needs history).

<sub>Location: `.github/workflows/ci.yml:26`</sub>

**Recommendation:**

```
Keep `fail-fast: false` only if you rely on seeing every combination fail; otherwise remove it to cancel siblings once one fails.
```

#### 🔵 **LOW** Workflow runs on all changes with no path filter

`trigger-missing-path-filter-1` · rule `trigger-missing-path-filter`

This workflow triggers on push/pull_request without `paths` or `paths-ignore` filters, so it runs even for documentation-only or unrelated changes.

**Evidence:**
- on — push, pull_request

**Time impact:** unknown — Savings depend on how many irrelevant changes trigger the workflow; needs history.

**Recommendation:**

```
Add `paths`/`paths-ignore` filters (or `paths-ignore: [ "**.md", "docs/**" ]`) so the workflow only runs when relevant files change. Keep required status checks in mind — filtered-out runs report as skipped.
```

### Security findings

#### 🔵 **LOW** Job `lint` persists checkout credentials

`checkout-persist-credentials-1` · rule `checkout-persist-credentials`

`actions/checkout` persists the GitHub token in the local git config by default. Job `lint` does not appear to push back to the repository, so persisting credentials widens the token's exposure to later steps unnecessarily.

**Evidence:**
- job lint — persist-credentials not set (defaults to true)

<sub>Location: `.github/workflows/ci.yml:13`</sub>

**Recommendation:**

```
Set `persist-credentials: false` on `actions/checkout` in jobs that do not push to the repository.
```

#### 🔵 **LOW** Job `setup` persists checkout credentials

`checkout-persist-credentials-2` · rule `checkout-persist-credentials`

`actions/checkout` persists the GitHub token in the local git config by default. Job `setup` does not appear to push back to the repository, so persisting credentials widens the token's exposure to later steps unnecessarily.

**Evidence:**
- job setup — persist-credentials not set (defaults to true)

<sub>Location: `.github/workflows/ci.yml:21`</sub>

**Recommendation:**

```
Set `persist-credentials: false` on `actions/checkout` in jobs that do not push to the repository.
```

#### 🔵 **LOW** Job `test` persists checkout credentials

`checkout-persist-credentials-3` · rule `checkout-persist-credentials`

`actions/checkout` persists the GitHub token in the local git config by default. Job `test` does not appear to push back to the repository, so persisting credentials widens the token's exposure to later steps unnecessarily.

**Evidence:**
- job test — persist-credentials not set (defaults to true)

<sub>Location: `.github/workflows/ci.yml:32`</sub>

**Recommendation:**

```
Set `persist-credentials: false` on `actions/checkout` in jobs that do not push to the repository.
```

#### 🔵 **LOW** Job `build` persists checkout credentials

`checkout-persist-credentials-4` · rule `checkout-persist-credentials`

`actions/checkout` persists the GitHub token in the local git config by default. Job `build` does not appear to push back to the repository, so persisting credentials widens the token's exposure to later steps unnecessarily.

**Evidence:**
- job build — persist-credentials not set (defaults to true)

<sub>Location: `.github/workflows/ci.yml:49`</sub>

**Recommendation:**

```
Set `persist-credentials: false` on `actions/checkout` in jobs that do not push to the repository.
```

---

<sub>Timing categories: **measured** (from historical runs), **estimated** (heuristic, no history), **unknown** (not supported by evidence). CacheMap never modifies workflow files.</sub>
