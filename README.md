# CacheMap

Analyze GitHub Actions workflows to explain why CI is slow and recommend concrete optimizations. Static analysis works offline with no credentials; a GitHub token optionally adds measured timing and cache history. CacheMap never modifies your workflow files or runs your code.

## Install

```bash
# Global install
npm install -g cachemap

# Or run without installing
npx cachemap analyze
```

Requires Node.js 20 or 22 (Linux, macOS, Windows).

## How to use

```bash
# Analyze every workflow under .github/workflows/ (offline, no token)
cachemap analyze

# Analyze one workflow
cachemap analyze .github/workflows/ci.yml

# Add measured timing + cache history from the GitHub API
export GITHUB_TOKEN=ghp_...
cachemap analyze --repo owner/repo --runs 30

# Explain a single finding
cachemap explain repeated-dependency-install-1

# Write machine-readable reports
cachemap report --format json  --output cachemap.json
cachemap report --format sarif --output cachemap.sarif

# Visualize the execution graph
cachemap graph --format mermaid
```

## Usage

### Commands

| Command | Description |
| --- | --- |
| `cachemap analyze [workflow]` | Analyze workflow(s) and print a report (default: text). |
| `cachemap report [workflow]` | Generate a report for sharing/CI (default: Markdown). |
| `cachemap graph [workflow]` | Render the execution graph (`--format mermaid\|dot\|json`). |
| `cachemap explain <finding-id>` | Show full detail and evidence for one finding. |
| `cachemap history` | Fetch and summarize historical run/cache data (needs a token). |
| `cachemap doctor` | Check the environment, git repo, token, and config. |
| `cachemap init` | Create a `.cachemap.yml` configuration file. |
| `cachemap schema` | Print the config JSON schema (`--report` for the report schema). |

### Options

```
--repo <owner/repo>      Repository for historical data
--workflow <name|path>   Restrict analysis to one workflow
--ref <git-ref>          Branch/ref filter for historical runs
--runs <number>          Number of historical runs to analyze
--format <fmt>           text | json | markdown | sarif  (graph: mermaid | dot | json)
--output <path>          Write to a file instead of stdout
--fail-on <severity>     Exit 1 when a finding reaches this severity (low|medium|high|critical)
--token <token>          GitHub token (or set GITHUB_TOKEN / GH_TOKEN)
--offline                Never contact GitHub; static analysis only
--no-color               Disable coloured output
--verbose                Verbose progress output
--config <path>          Path to a .cachemap.yml file
```

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No finding reached the configured `--fail-on` threshold. |
| `1` | A finding reached the threshold. |
| `2` | Invalid input, configuration, or analysis failure. |

### Example output

```
CACHEMAP REPORT

Workflow: CI
  Estimated duration: 4m 45s (estimated)
  Critical path: setup → lint → build
  Potential savings: 24s

HIGH  node dependencies installed in 4 jobs
  id: repeated-dependency-install-1  rule: repeated-dependency-install
  Evidence:
    - lint
    - setup
    - test
    - build
  Estimated avoidable time: 24s–2m (estimated)
  Recommendation:
    Create one dependency-preparation job (or reuse a dependency cache keyed
    by lockfile, OS, architecture, and runtime version).

MEDIUM  Cache key in job `build` is likely to behave poorly
  Current key:   ${{ runner.os }}-${{ hashFiles('**/*') }}
  Suggested key: ${{ runner.os }}-npm-${{ hashFiles('**/package-lock.json') }}

LOW  Artifact `coverage-results` is uploaded but never downloaded.
```

Timing is labelled `measured` (from history), `estimated` (a documented heuristic), or `unknown` (impact not supported by evidence). CacheMap never invents exact savings.

### Configuration

CacheMap reads `.cachemap.yml` from the repository root (`cachemap init` creates one):

```yaml
version: 1
history:
  runs: 30
ignore:
  rules: [checkout-full-history]
  jobs: [release]
thresholds:
  minimum-estimated-savings-seconds: 20
  fail-on: high
```

### GitHub Action

```yaml
- uses: kingsleychenlab/cachemap@v1
  with:
    fail-on: high
    github-token: ${{ secrets.GITHUB_TOKEN }}
```
