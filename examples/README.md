# Examples

[`inefficient-ci.yml`](inefficient-ci.yml) is an intentionally sub-optimal
workflow. Analyze it with:

```bash
cachemap analyze --offline examples/inefficient-ci.yml
```

The [`reports/`](reports/) directory contains the output CacheMap produces for
it (regenerate with the commands below):

| File | Command |
| --- | --- |
| [`reports/report.txt`](reports/report.txt) | `cachemap analyze --offline` |
| [`reports/report.md`](reports/report.md) | `cachemap report --format markdown` |
| [`reports/report.json`](reports/report.json) | `cachemap report --format json` |
| [`reports/report.sarif`](reports/report.sarif) | `cachemap report --format sarif` |
| [`reports/graph.mmd`](reports/graph.mmd) | `cachemap graph --format mermaid` |
| [`reports/graph.dot`](reports/graph.dot) | `cachemap graph --format dot` |

These reports were generated with the file placed at
`.github/workflows/ci.yml` in a repository, which is why the reported path is
`.github/workflows/ci.yml`.
