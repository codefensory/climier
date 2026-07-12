# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

## [Unreleased]

### Changed
- Reframed the documentation around what `climier` is: a task DAG CLI for coordinating work across agents, sessions, or humans, with orchestrator/workers documented as one use case among several.
- Removed the built-in migration seed from the runtime CLI; tests now use a test-only example fixture instead.
- Removed legacy repo-local `.agents/tasks/tasks.json` support; state now always lives under `~/.climier/projects/<project-id>/tasks.json`.

## [1.0.0] - 2026-07-11

### Added
- Added GitHub Actions CI to run the test suite and package checks on push and pull request.
- Added the MIT `LICENSE` file.
- Added `--version` and `version` to print the installed CLI version.

### Changed
- Limited published npm package contents to runtime files and release docs only.
- Documented a simple manual release flow and operational recovery notes in the README.
- Restored the v1 lock behavior: stale `.lock` files are not auto-cleared and require manual recovery.
- Aligned README and `AGENTS.md` with the shipped command set and DAG/backlog behavior.

### Fixed
- Excluded `test/`, `AGENTS.md`, and `.agents/` from the npm package tarball.
- Included `CHANGELOG.md` in the npm package alongside `README.md` and `LICENSE`.

## [0.0.2] - 2026-07-11

### Added
- Initial public CLI release of `climier`.
- JSON-only command output contract.
- Task DAG workflow with tasks, decisions, gotchas, initiatives, and audit log.
- Global per-project state storage via `.climier.json` metadata and `~/.climier/projects/<project-id>/tasks.json`.
- Atomic file locking and concurrent mutation safety.
- Migration seed and comprehensive stdlib test coverage.
