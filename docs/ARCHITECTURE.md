# Architecture

CacheMap is organized into independent stages. Parsing, graph construction,
analysis, timing, and reporting do not depend on each other's internals, which
keeps each testable in isolation and makes the offline path fully deterministic.

```
workflow YAML ──▶ parser ──▶ model ──▶ graph builder ──▶ graph
                                            │
 GitHub API (optional) ──▶ history ──▶ timing map
                                            │
                                            ▼
                                     analysis rules ──▶ findings
                                            │
                                            ▼
                              reports: text / json / md / sarif / graph
```

## Modules

```
src/
  cli.ts               Command registration (commander) and handlers
  cli/shared.ts        Config loading, format validation, exit codes
  engine.ts            High-level orchestration used by CLI and Action
  config.ts            .cachemap.yml loading + Zod validation + JSON schema
  version.ts           Tool name/version
  types.ts             Shared domain types

  git/
    repo.ts            Repository detection, remote slug, shallow-clone check
    discovery.ts       Workflow file discovery (with traversal protection)

  parser/
    workflow.ts        Safe YAML → WorkflowModel (with source locations)
    expressions.ts     Conservative ${{ }} handling (matrix, hashFiles, …)
    matrices.ts        Matrix expansion (include/exclude semantics)
    features.ts        Step interpretation: caches, artifacts, checkouts, installs

  graph/
    model.ts           Graph node/edge types + adjacency helpers
    builder.ts         WorkflowModel → WorkflowGraph
    estimate.ts        Static duration heuristic (used only without history)
    criticalPath.ts    Cycle detection + longest-weighted-path

  analysis/
    framework.ts       AnalysisInput bundle + finding/savings constructors
    runner.ts          Runs every rule, filters, sorts, marks the graph
    repeatedWork.ts    Repeated installs + duplicated commands
    caches.ts          Cache-key quality, unrestored/duplicated caches
    cacheHistory.ts    Measured cache-list analysis
    matrices.ts        Matrix inefficiencies
    parallelism.ts     Serialization + fan-in
    artifacts.ts       Artifact flow
    triggers.ts        `on:` inefficiencies
    checkout.ts        Checkout depth/submodules/LFS/credentials
    services.ts        Service-container overhead
    permissions.ts     Token permissions & safety (security findings)
    steps.ts           Step ordering

  github/
    client.ts          Octokit wrapper: retries, rate limits, token redaction
    workflows.ts       Resolve a workflow file → id
    runs.ts            Fetch per-job run timings
    caches.ts          Fetch the Actions cache list
    artifacts.ts       Fetch artifact metadata
    history.ts         Aggregate samples → measured per-job timings

  reports/
    model.ts           ReportBundle + formatting helpers
    text.ts            Terminal report
    markdown.ts        Markdown report / job summary
    json.ts            Stable, versioned JSON report
    sarif.ts           SARIF 2.1.0
    graph.ts           Mermaid / DOT / JSON graph

  action/
    main.ts            GitHub Action entrypoint (bundled to action/index.js)
```

## Data flow

1. **Detect** the git repository and (best-effort) the `owner/repo` slug.
2. **Discover** workflow files under `.github/workflows/`, refusing paths that
   escape the repository root.
3. **Parse** each workflow into a `WorkflowModel`, capturing source locations
   for annotations. YAML is parsed data-only (no code execution) with alias
   expansion capped to prevent "billion laughs" attacks.
4. **Expand** matrices into concrete `JobVariant`s. Dynamic matrices yield a
   single variant flagged `dynamic`.
5. **Build** a directed graph of jobs, `needs` edges, and artifact-flow edges,
   attaching caches, artifacts, and services to nodes.
6. **Time** each job: measured timing from history when available, otherwise a
   documented static heuristic clearly labelled `estimated`.
7. **Critical path**: detect cycles, then compute the longest weighted path.
8. **Analyze**: every rule receives the same immutable `AnalysisInput` and
   returns findings with deterministic ids (`<rule>-<seq>`).
9. **Report** in the requested format. The JSON schema is versioned.

## Determinism

Given the same workflow files and configuration, offline analysis is fully
deterministic: finding ids, ordering, and JSON output are stable across runs.
The only non-deterministic field is `generatedAt`, which callers can override
(the reporters accept a pre-built `ReportBundle`).

## Safety invariants

- Never execute repository code or workflow steps.
- Never modify workflow files.
- Never print tokens; redact them from all errors and logs.
- Never follow workflow paths outside the repository root.
- Bound API pagination and retries; back off and surface clear errors on rate
  limits.

## Confidence model

Every timing/savings claim carries one of three categories:

- **measured** — derived from historical run/cache data (`runsAnalyzed > 0`).
- **inferred** — a conservative range from a documented static heuristic.
- **unknown** — a real finding whose time impact cannot be supported by
  evidence (reported with the qualitative issue, no fabricated number).

There are no arbitrary percentage-confidence scores anywhere in the output.
