# Changelog

All notable changes to this project are documented here. The format follows
Keep a Changelog.

## [1.2.0] - 2026-10-10

### Features

- **ui:** embed UI assets in binary ([dfeaca7](https://github.com/codefensory/climier/commit/dfeaca7fe42b0930a3a8ebd67e845fa0f80ab9ae))
- **ui:** order ready before in progress in task status groups ([ef61b3f](https://github.com/codefensory/climier/commit/ef61b3f1e847b0a49f371f2511c14c8d42a5bf3f))

### Refactoring

- **storage:** retire v1 migration path ([4bb1f9e](https://github.com/codefensory/climier/commit/4bb1f9ee71dd7aa217927b721fefe0aa8ad3df9b))

The standalone binary now embeds the web UI bundle: `climier ui` and a
self-hosted server serve it without the source checkout or a separate UI build,
and `uiRoot` is optional for adopting a custom build. npm and source-link
installs keep serving the packaged or locally built `ui/dist`.

The one-time `migrate` command is retired. The on-disk state stays schema **1**,
so projects already on a canonical schema-1 state need no migration and keep
working unchanged. A project still on a pre-release or legacy state form can no
longer be imported by the CLI: preserve its files and restore a verified backup
or contact the maintainer, and remember `init --force` is a destructive reset
that never converts state.

## [1.1.0] - 2026-10-10

### Features

- **cli:** name projects with a display name and rename command ([a81c494](https://github.com/codefensory/climier/commit/a81c4945c39e22a6fd670df563fd48ff6b4b483a))

The project display name is now first-class. `climier rename "<name>"` and
`link --name "<name>"` label a project in the CLI, the server catalog, and the
web UI without changing its opaque `project_id`; the name lives in the
checkout's `.climier.json` and in `~/.climier/projects/<id>/project.json`, and a
project provisioned before names existed adopts one on first contact through
`POST /v1/projects/:id/rename` and the `x-climier-project-name` header. No
state migration is required: the canonical schema stays 1 and older binaries
ignore the extra field.

## [1.0.1] - 2026-10-09

### Bug Fixes

- **server:** stop emitting systemd hardening from server init ([279d8b7](https://github.com/codefensory/climier/commit/279d8b722faf98f22cade5f86d23527df2b4ab8d))
- **server:** install shutdown handlers before reporting health ([eb27f52](https://github.com/codefensory/climier/commit/eb27f52f549cd5661a96dbc2764d80a89800d1a3))
- **server:** adopt the operator password in an existing server env ([69aaab5](https://github.com/codefensory/climier/commit/69aaab5a1ab86f250dc17107e129d0d56e1df80c))

The generated systemd unit now only supervises the process: `NoNewPrivileges`,
`PrivateTmp`, `ProtectSystem`, `ProtectHome`, and `ReadWritePaths` are gone, so a
root under `/home` works and hardening belongs in an operator drop-in. Units
already installed are not modified; regenerate and reinstall the artifact only
to adopt the new contract. `server init` also adopts an existing operator-chosen
`CLIMIER_SERVER_PASSWORD` verbatim, and the server installs its shutdown
handlers before reporting health.

## [1.0.0] - 2026-09-28

This is the first clean Climier release. It is the first version intended for
production use; no earlier npm release established a compatibility contract.
The on-disk project state is schema **1**. The one-time cutover imported and
verified the existing project park before writers resumed, with a complete
backup retained for each project. The import tool was temporary and is not
part of the current CLI. Do not point an older binary at an imported project:
it may classify the state as prehistorical and suggest `init --force`, which
can erase the project. The ordered cutover and rollback record is in
[`docs/remote-server.md`](docs/remote-server.md).

### Completed v1 cutover

The v1 release window installed the schema-1 binary, stopped every writer
sharing the state home (control plane, UI, runner executions, and remote
servers), inspected and imported all projects, then verified each project with
a read and mutation before writers resumed. The retired one-time import command
is deliberately omitted from the current command reference; it is not a
recovery mechanism for newly discovered older data.

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
  --force` with the command first; `init --force` is a destructive reset, not
  a conversion or recovery mechanism. Preserve old or incomplete state files
  and restore a verified canonical backup or contact the maintainer.
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
- **Breaking:** removed `CLIMIER_ALLOW_INSECURE_REMOTE_HTTP` and
  `CLIMIER_SERVER_ALLOW_TAILSCALE_HTTP`. Remote HTTP is no longer gated by an
  environment variable, and listener binding is the operator's responsibility;
  `login`, `link`, and remote `init` emit a structured transport warning that
  can be suppressed with `--no-warnings`.
- Remote checkout metadata now stores only backend type and URL; manual
  `push`/`pull` transfers remain explicit and fail closed without fallback.
- Cut the first supported remote wire as Remote v1 (`/v1` with protocol header
  `1`), with two-client E2E coverage and a packed-artifact smoke.
