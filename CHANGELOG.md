# Changelog

All notable changes to this project are documented here. The format follows
Keep a Changelog.

## [Unreleased]

- **Breaking:** removed `CLIMIER_ALLOW_INSECURE_REMOTE_HTTP` and
  `CLIMIER_SERVER_ALLOW_TAILSCALE_HTTP`. Remote HTTP is no longer gated by an
  environment variable, and listener binding is the operator's responsibility;
  `login`, `link`, and remote `init` emit a structured transport warning that
  can be suppressed with `--no-warnings`.
- Cut the first supported remote wire as Remote v1 (`/v1` with protocol header
  `1`), with two-client E2E coverage and a packed-artifact smoke.
- Remote checkout metadata now stores only backend type and URL; manual
  `push`/`pull` transfers remain explicit and fail closed without fallback.

## [1.0.0] - 2026-09-28

This is the first clean Climier release. It is the first version intended for
production use; no earlier npm release established a compatibility contract.
The on-disk project state is schema **1**. The new binary does not read or
write older state forms, so existing projects must be imported before any
writer uses this release. Follow [`docs/remote-server.md`](docs/remote-server.md)
for the ordered, backed-up import and rollback procedure. Do not point an older
binary at an imported project: it may classify the state as prehistorical and
suggest `init --force`, which can erase the project.

### Migration before first use

1. Link or install this v1 binary and verify it can read the project metadata.
2. Stop every writer sharing the state home: the control plane, the UI, all
   runner executions, and any remote server instance.
3. Run `climier migrate --all --dry-run` and review every project report.
4. Run `climier migrate --all`; the importer writes a complete per-project
   backup before changing state.
5. Verify every project with `climier --project <checkout> status` and one
   authorized read or mutation before reopening writers.

### Removed compatibility surface

The release removes historical aliases and silently ignored inputs. Replace
these call sites as follows:

- `take --initiative`, `take --domain`, and `take --tag` are removed. Pass the
  task id to `take`; use `status` or `context` to discover and filter work.
- `install --as` and `uninstall --as` are removed. Plugin installation has no
  agent identity; invoke those commands without the flag (where the plugin
  host provides them).
- `resolve` no longer resets a resolved gate or injects a default resolution
  mode. Resolve an open gate once; use `reopen` when an accepted decision must
  be corrected, then resolve it again with explicit `--choice` and
  `--rationale`.
- The untyped `update` legacy patch is removed. Use only fields allowed for the
  node kind; `update` reports invalid fields instead of writing them silently.
- `add-note` no longer has an unchecked compatibility path. Supply the current
  revision with `--if-revision` when concurrent edits are possible.
- `history` and `log` no longer match the historical `task`, `decision`, or
  `gotcha` fields. Query by the canonical node id with `history <id>` or
  `log --node <id>`.
- The historical `--force init` ordering is removed. Write `climier init
  --force` with the command first, and use `migrate` rather than force-init to
  import an existing project.
- Unknown commands and flags now return the structured JSON usage envelope with
  `error.code` and `error.details`; callers must branch on the code, not parse
  message text. Module aliases (`parseArgs`, `dispatch`, and `main`) are gone;
  use the single CLI entry point.

### Added

- A schema-1 state with a revision ledger, atomic state-plus-log commits, and
  explicit migration and recovery tooling.
- A local HTTP server (`climier-server`) with authenticated project-scoped
  reads and mutations, plus the remote client backend.
- GitHub Actions checks for the test suite, package contents, and retired CLI
  surfaces, with a Node 20/24 matrix.
- The MIT `LICENSE` file and an npm package containing the runtime and the
  published reference manual.

### Changed

- The package is limited to runtime files and release documentation; the UI
  source remains an experimental local subproject and is not shipped in the
  tarball.
- Stale locks are never cleared automatically. Operators must verify that the
  owner is stopped before removing a lock, as documented in the runbook.
- README, reference, agent notes, and the cheatsheet now describe the schema-1
  state, remote server, ledger, and current command surface.
