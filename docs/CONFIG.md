# Configuration reference

CacheMap reads `.cachemap.yml` (or `.cachemap.yaml`) from the repository root,
or from a path passed with `--config`. Run `cachemap init` to create a starter
file, and `cachemap schema` to print the JSON schema. **Unknown keys are
rejected** (validated with Zod) so typos surface as errors.

## Full example

```yaml
version: 1

# Optional. When set, only these workflows are analyzed. Otherwise CacheMap
# discovers everything under .github/workflows/.
workflows:
  - .github/workflows/ci.yml

history:
  # Number of recent runs to analyze when a token is available.
  runs: 30

ignore:
  # Rule ids to suppress entirely (see docs/RULES.md).
  rules:
    - checkout-full-history
  # Job ids to exclude from analysis.
  jobs:
    - release

thresholds:
  # Suppress LOW-severity performance findings whose estimated saving is below
  # this many seconds. Medium+ findings, security findings, and findings with
  # unknown impact are always kept.
  minimum-estimated-savings-seconds: 20
  # Severity at which `--fail-on` (and the Action) fails the check.
  fail-on: high

# Cost rates are YOUR estimates, used only for compute-cost context. They are
# NOT authoritative GitHub billing rates and have no built-in defaults you
# should treat as accurate — override them for your plan.
cost:
  linux-per-minute: 0.008
  macos-per-minute: 0.08
  windows-per-minute: 0.016
```

## Keys

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `version` | `1` | — (required) | Config schema version. |
| `workflows` | `string[]` | discover all | Restrict analysis to these files. |
| `history.runs` | `integer > 0` | `30` | Historical runs to analyze. |
| `ignore.rules` | `string[]` | `[]` | Rule ids to suppress. |
| `ignore.jobs` | `string[]` | `[]` | Job ids to exclude. |
| `thresholds.minimum-estimated-savings-seconds` | `integer ≥ 0` | `20` | Low-severity noise floor. |
| `thresholds.fail-on` | `low\|medium\|high\|critical` | `high` | Threshold for exit code 1. |
| `cost.linux-per-minute` | `number ≥ 0` | `0.008` | Linux runner cost estimate. |
| `cost.macos-per-minute` | `number ≥ 0` | `0.08` | macOS runner cost estimate. |
| `cost.windows-per-minute` | `number ≥ 0` | `0.016` | Windows runner cost estimate. |

## Precedence

For choosing which workflows to analyze:

1. An explicit CLI argument or `--workflow` flag.
2. `workflows:` in the config file.
3. Otherwise, every workflow under `.github/workflows/`.

CLI flags (`--fail-on`, `--runs`) override the corresponding config values for a
single invocation.
