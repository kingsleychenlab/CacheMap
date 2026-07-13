# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-12

### Added

- Initial release.
- CLI commands: `analyze`, `report`, `graph`, `explain`, `history`, `doctor`,
  `init`, `schema`.
- Safe GitHub Actions workflow parsing with source locations.
- Matrix expansion with `include`/`exclude` semantics.
- Workflow execution graph, cycle detection, and critical-path analysis.
- Static analysis rules across repeated work, caches, matrices, parallelism,
  artifacts, triggers, checkout, steps, services, and permissions.
- Optional GitHub historical run/cache integration producing *measured* timing.
- Reports: text, JSON (versioned schema), Markdown, SARIF 2.1.0, and graph
  (Mermaid / DOT / JSON).
- GitHub Action with annotations, job summary, report artifacts, base-branch
  comparison, and threshold-gated failure.
- Configuration via `.cachemap.yml` with strict Zod validation.

[Unreleased]: https://github.com/kingsleychenlab/cachemap/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kingsleychenlab/cachemap/releases/tag/v0.1.0
