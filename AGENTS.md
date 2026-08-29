# climier — Agent Notes

You are working on **climier**, a task DAG CLI for coordinating work across agents, sessions, or humans. Each repo gets stable metadata in `.climier.json`; the live JSON state for that project lives under `~/.climier/projects/<project-id>/tasks.json` (or `$CLIMIER_HOME/projects/<project-id>/tasks.json`).

This file tells you how the code is organized, the rules you must follow, and the non-obvious decisions baked into the design. Read it before touching anything.

## What this repo is

- A Node CLI. No runtime dependencies, stdlib only.
- ESM modules (`"type": "module"` in `package.json`).
- Tests run with `node --test` (stdlib).
- Entry point: `bin/climier.mjs`. Library code: `src/`. Tests: `test/`.
- The CLI resolves a project root (CWD by default, `--project <dir>` to override), reads `<project>/.climier.json`, and then operates on the matching live state file under `~/.climier/projects/<project-id>/tasks.json`.

## Architecture

### Source layout

```
bin/climier.mjs             # CLI entry: argv parsing, dispatch, printer wiring
src/
  paths.mjs                 # resolveProject({ project }), CLIMIER_HOME helpers, repo metadata paths
  state.mjs                 # emptyState, readState, writeState, updateState
                            # live state file is ~/.climier/projects/<project-id>/tasks.json
                            # repo keeps only .climier.json
  lock.mjs                  # withLock(projectDir, fn) — file lock for atomicity
  log.mjs                   # append log entries (delegates to updateState)

  commands/                 # One file per command. Each exports default async fn({ positional, flags, statePath, projectDir })
                            # Commands use withLock for any mutating op
test/
  helpers.mjs               # createTempProject, rmTempProject, runCli, importFresh
  *.test.mjs                # Tests, one per module/feature
```

### The state shape

The repository uses a single state schema:

```js
{
  version: 2,
  initiatives: { "auth-migration": { desc, created_at } },
  nodes: { "T-auth-1": { id, kind, subkind, title, status, ... } },
  edges: [{ from, to, type }],
  log: []
}
```

`status: "ready"` and `"blocked"` are **derived** from the DAG. They are NOT persisted. Persisted statuses on tasks are `open` (default), `in_progress`, `done`, `canceled`. Gates additionally use `resolved` / `superseded`. Knowledge uses `active` / `deprecated`.

The CLI surface is a single set of commands. `init` always creates the schema above.

`take <id>` requires an explicit task id. `--as orchestrator` may atomically replace another agent's claim; the `take` log entry records that agent as `previous_owner`.

Canonical `BLOCKS` direction is `{ from: blocker, to: blocked, type: "BLOCKS" }`; blockers are incoming edges to the blocked node.

### The two non-obvious invariants

1. **Atomicity: every mutating command goes through `withLock` → `updateState` (atomic tmp+rename).** Two agents in parallel can't corrupt the file. The `withLock` lock file lives next to the active state file (`~/.climier/projects/<project-id>/.lock`), is created with `fs.openSync(..., 'wx')` (fails on EEXIST), and is re-acquired in a spin loop with a 10s default timeout. Stale lock files (process died) are NOT auto-cleared — that is documented as the known ceiling of the file-lock strategy.
2. **Logging is part of the mutation.** Every command that changes state calls `updateState` (under `withLock`) and then `append` to the log. Both happen inside the same `withLock` block. Do not split them across locks.

### Derived state and the DAG

Derivation lives in `src/commands/status.mjs` (read-only views) and the per-command helpers that compute `derived_status`, `can_claim`, and `blocking[]`. Pure functions with no I/O let unit tests pass literal state objects.

`status` surfaces `{ summary: { ready, in_progress, blocked, backlog, placeholders, stale, open_decisions, done, archived } }`. Backlog tasks are kept out of the ready/blocked pools until `--backlog false` is set on the node (or they were created without `--backlog true`).

Cycles in the DAG must not crash. The derivation keeps cycle members blocked. Unknown dep ids also keep tasks blocked (defensive).

## Commands

| Command | File | Mutates? | Needs `--as`? |
|---|---|---|---|
| `init [--force]` | `commands/init.mjs` | yes (creates/overwrites state) | no |
| `status [--initiative X] [--kind task\|gate\|knowledge] [--status X] [--domain X] [--claimed-by X] [--stale-ms N] [--limit N] [--all]` | `commands/status.mjs` | no | no |
| `context <id>` | `commands/context.mjs` | no | no |
| `search "<query>" [--all]` | `commands/search.mjs` | no | no |
| `history <id> [--limit N]` | `commands/history.mjs` | no | no |
| `show <id>` | `commands/show.mjs` | no | no |
| `initiatives [--all]` | `commands/initiatives.mjs` | no | no |
| `log [--limit N] [--action X] [--agent X] [--task X] [--decision X]` | `commands/log.mjs` | no | no |
| `take <id>` | `commands/take.mjs` | yes | yes |
| `release <id>` | `commands/release.mjs` | yes | yes |
| `resolve <id> --note "<text>"` (task) / `--choice "<x>" --rationale "<y>"` (gate) | `commands/resolve.mjs` | yes | yes |
| `reopen <id> --reason "<text>"` | `commands/reopen.mjs` | yes | yes (orchestrator/recovery, or original done_by for self-correction) |
| `cancel <id> --reason "<text>"` | `commands/cancel.mjs` | yes | yes (claim owner, or orchestrator/recovery) |
| `update <id> [--title X] [--body "..."] [--definition "..."] [--acceptance "..."] [--domain Y] [--tags ...] [--backlog true\|false] [--if-revision N]` | `commands/update.mjs` | yes | required (any value; no ownership check) |
| `add-note <id> "<text>"` | `commands/add-note.mjs` | yes | required (any value) |
| `add-initiative <name> [--desc "..."]` | `commands/add-initiative.mjs` | yes | required |
| `add-task [id] --initiative X --title "..." --body "..." --acceptance "..." --blocked-by A,B [--backlog true]` | `commands/add-task.mjs` | yes | required |
| `add-gate [id] --initiative X --title "..." --body "..." --purpose decision\|approval\|external-dependency\|research [--supersedes OLD]` | `commands/add-gate.mjs` | yes | required |
| `add-knowledge [id] --initiative X --title "..." --body "..." [--scope-domains X] [--scope-initiatives X] [--scope-tags X] [--scope-node-ids X] [--supersedes OLD]` | `commands/add-knowledge.mjs` | yes | required |
| `deprecate-knowledge <id> --reason "<text>"` | `commands/deprecate-knowledge.mjs` | yes | required |
| `add-node <id> --kind resolvable\|knowledge --title "..." [--subkind task\|gate] [--blocked-by A,B] [--derived-from A,B] [--refs a,b] [--meta '{...}']` | `commands/add-node.mjs` | yes | required |
| `add-edge <from> <to> --type BLOCKS\|SUPERSEDES\|DERIVED_FROM` | `commands/add-edge.mjs` | yes | required |
| `snapshots` | `commands/snapshots.mjs` | no (read-only) | no |
| `restore <id> --as orchestrator\|recovery` | `commands/restore.mjs` | yes (locked; validates target v2/shape; pre-snapshot) | yes (orchestrator\|recovery only) |
| `ui [--port N] [--open=true\|false]` | `commands/ui.mjs` (starts `ui/server/server.mjs`) | no (read-only) | no |

## Hard rules for contributing

1. **No new runtime dependencies for the CLI.** Stdlib only. The `ui/` directory is an exception by design: it is a self-contained subproject (own `package.json`, `node_modules`, `dist/`) for the local web UI (Express server + Solid/Tailwind frontend). `climier ui` imports `ui/server/server.mjs`, which resolves its deps from `ui/node_modules`; the CLI package itself gains no runtime deps. If you think you need a package in `bin/`/`src/`, you almost certainly don't.
2. **TDD strict.** Write the failing test first, then make it pass. The test suite is the spec. Exception: the `ui/` subproject does not require TDD nor changes to `test/`; it does require verification proportional to the blast radius, explicit (named command, observed output, or manual check), and documented in the commit body, the PR description, or a `climier add-note`. The TDD rule still applies to everything outside `ui/`.
3. **No silent failures.** Every error path either throws with a clear message or has a tested behavior. If you find yourself "handling" an error by logging and continuing, write a test that documents the behavior, or change the code to fail loud.
4. **Schema validation on write.** `writeState` rejects states missing `nodes`/`edges`/`initiatives`/`log`. Don't relax this without a test that says why.
5. **Versioning.** The state has `version: 2`. Additive optional fields that an older compatible CLI can safely preserve and ignore do not require a version bump. Bump the version and add a migration in `readState` when a change removes or reinterprets existing data, makes a field required for correct behavior, changes core semantics, or otherwise means an older CLI cannot safely read and write the state. Document the compatibility decision and never silently accept unknown future versions.
6. **Multi-agent safety.** Any new mutation must go through `withLock`. Any new "log" must be inside the same `withLock` block as the state change it describes. If you split them, a concurrent op can interleave and the log will lie.
7. **The orchestrator/recovery escape hatch.** `release` and `reopen` honor `--as orchestrator` (or `--as recovery`) and can act on any agent's claim / `done` record. This is a feature, not a bug. Don't remove it. `resolve` and `cancel` follow the same pattern for the claim/done owner.
8. **No boolean flags before the command.** The CLI parser treats `--force init` as `--force=init`. New boolean flags must be used as `--flag=true` or after the command. Document any new boolean flag with this caveat.
9. **English only in code, but the CLI output tolerates any UTF-8.** Titles, bodies, notes, and any free-text field can be in any language. Don't filter or escape based on locale.

## How to add a new command

1. **Test first.** Add `test/<name>.test.mjs`. Test happy path, ownership/permission errors, state-missing errors, and at least one edge case (empty state, missing deps, etc).
2. **Implement in `src/commands/<name>.mjs`.** Export default async function. Wrap mutating ops in `withLock`. Use `updateState` for atomic writes; use `append` to log.
3. **Wire it in `bin/climier.mjs`.** Add it to the unknown-command help text. (There is no `printers` map — the CLI is JSON-only. See "Output contract" below.)
4. **Add a row to the Quick reference tables** in this `AGENTS.md` and the README in this repo.
5. **Add it to the integration tests** if it interacts with other commands (`cli-dispatch.test.mjs` covers end-to-end via the bin).
6. **Run the full suite.** `npm test`. Don't commit if anything is red.

## How to add a new field to the state

1. **Update `emptyState()` in `src/state.mjs`** if the field is required for new states.
2. **Update `writeState` validation** if the field is required for all writes (most fields are optional, so this is rare).
3. **Add tests for the new field's behavior.** If it's a derived field, test it via `derive` or `statusOf`. If it's persisted, test via the command that sets it.

5. **Document in this file's "State shape" section** if the field is a primary concept; otherwise, leave it for code reading.

## How to extend the DAG model

- **New task status** (beyond `open`/`in_progress`/`done`/`canceled`): add to the persisted set AND update the derivation logic to handle it. Don't treat unknown statuses as `ready` without thinking — pass-through is the current policy for forward compat. If you want stricter behavior, add a test that locks down the policy.
- **New gate kind** (e.g. a sub-class of `gate`): the current model uses `subkind` and `purpose` to discriminate. Adding a new subkind means changes in `state.mjs`, the command that creates the subkind, and the affected read commands (`status`, `context`). Document it.
- **Cross-initiative dependencies**: already supported via `--blocked-by` ids. The `--initiative` filter is for views only, not for resolution.

## Conventions in the code

- **Async everywhere.** All commands are `async` and use `await` for I/O.
- **No `try`/`catch` around `await` for control flow.** Let errors propagate. The CLI entry catches and formats them.
- **Error messages start with the command name.** `"take: node T1 is not ready"` not `"Node T1 is not ready"`. This makes logs grep-able.
- **Positional args for things, flags for options.** `climier take T1 --as alice` not `--id T1 --agent alice`.
- **CSV in flag values.** `--tags "ts,sql"` not `--tag ts --tag sql`. Trim and filter empty strings.
- **Pure functions live next to their read command.** No I/O, no side effects. Test them with literal state objects, no temp dirs.
- **Imperative wrappers in `state.mjs` and `lock.mjs`.** These touch the filesystem. They are tested via `helpers.mjs` (temp dirs).
- **Commands return data, not console.log.** `bin/climier.mjs` is the only place that prints (except for errors).

## Testing

- `npm test` runs the CLI/core suite and skips `ui-*` tests.
- `npm run test:ui` runs the UI test suite in isolation.
- For changes limited to `/ui`, do not run the full Climier CLI suite by default. Run `npm run test:ui` and, when the change affects the frontend build, `(cd ui && npm run build)`.
- UI and CLI tests are separate by design, but `ui/server/` consumes CLI state and read-only helpers. If a change crosses that boundary or changes a shared CLI contract, run the relevant targeted CLI tests too; use `npm test` when the blast radius warrants it.
- `npm run test:concurrent` runs the multi-agent race tests in isolation.
- Each test uses a temp dir (see `helpers.mjs`) so tests don't interfere.
- `importFresh()` re-imports modules fresh between tests (defeats the module cache); use it when you need clean state.
- For CLI end-to-end tests, use `runCli(args, { cwd })` which spawns the real `bin/climier.mjs`.
- For unit tests of derivation logic, import the command file (or its helpers) and pass literal state objects — no filesystem needed.

### Test file naming

- `test/<module>.test.mjs` for unit tests of a module.
- `test/<feature>.test.mjs` for behavior tests that cross modules.
- `test/deep-holes-N.test.mjs` for regression tests on bugs found in audit rounds.

When you fix a bug, write a test that reproduces it BEFORE the fix. The test goes in `bugs.test.mjs` (real bugs) or `coverage-gaps.test.mjs` (missing tests for known behaviors) or a new `deep-holes-N.test.mjs` (deeper audit rounds).

## Non-obvious things that bit us

- **`release` and `reopen` honor the orchestrator/recovery escape hatch.** `release --as orchestrator` (or `--as recovery`) can free any agent's claim; `reopen --as orchestrator` can roll back any `done` task. The original `done_by` can self-reopen. By design.
- **`status --status DONE` (uppercase) works in `tasks` style filters.** Case-insensitive.
- **`status --staleMs 0` marks all in_progress as stale.** `staleMs: 0` is valid and means "everything in_progress is stale".
- **`status` is global by default for in_progress.** `tasks.in_progress` and `summary.in_progress` include every in_progress task in scope, regardless of caller. `--claimed-by <agent>` is the only way to narrow claims; `--as` is an identity tag for `context` and is intentionally not a filter for `status`. Stale-claim alerts follow the same rule.
- **`init --force` auto-recovers a corrupt state file** even without `--force`, but `--force` is still needed to overwrite a *valid* state.
- **`add-task --blocked-by NONEXISTENT` fails** with a clear error. The validator only runs when the state file exists (so empty projects can still bootstrap).
- **The state file is owned by the script.** `writeState` validates the schema. Don't write to the file from outside the CLI — even tests should go through `updateState`/`writeState` (or write valid schemas).
- **`status` returns an empty `tasks` / `gates` shape for an empty state, never throws.** New code that consumes `status` should preserve this.

## Working with the project

```bash
# Run all tests
npm test

# Run a single test file
node --test test/status.test.mjs

# Run a single test by name
node --test --test-name-pattern="take.*same agent" test/v2-take.test.mjs

# Watch mode
npm run test:watch

# CLI smoke
node bin/climier.mjs --project /tmp/testproj init
node bin/climier.mjs --project /tmp/testproj status
```

## Output contract

The CLI is **JSON-only**. There is no `--json` flag (it's the default), no text mode, no `printers` map. Every command prints a single JSON value to stdout. Errors are JSON to stdout too, with non-zero exit. Humans pipe through `jq`.

| Outcome | stdout | stderr | exit |
|---|---|---|---|
| Success | `{ "task": {...} }`, `[...]`, `{...}` (whatever the command produces) | empty | 0 |
| Validation / runtime error | `{ "ok": false, "error": { code, message, details } }` | empty | 1 |
| Unknown command / no command | `{ "ok": false, "error": "<message>" }` | empty | 2 |
| `--help` / `-h` / `help` | plain text help (the only text output) | empty | 0 |

The convention for command return shapes is principled:
- **Read commands** (`status`, `context`, `history`, `show`, `search`, `initiatives`, `log`) return raw data — the object/array the consumer cares about.
  - `status` and `context` are deliberately richer than the other reads: the agent is the primary consumer, so the output is shaped to remove ambiguity. `status` adds `summary.{ready,in_progress,blocked,backlog,open_gates,active_knowledge}` (totals) and `alerts[]` (kinds: `stale-claim`). `context` adds `derived_status`, `revision`, `claim`, `blocking[]`, `knowledge[]` (scoped), `informing[]`, `alerts[]`, and `allowed_actions[]`.
- **Write commands** (`take`, `resolve`, `release`, `reopen`, `cancel`, `update`, `add-note`, `add-*`, `deprecate-knowledge`) return `{ entity }` envelopes (`{ node }`, `{ task }`, `{ initiative }`, etc.).
- `init` returns `{ ok, seeded, file }` (different shape because it is not creating an entity, it is setting up a state).
- `show` returns `{ type, node }` because it can return any of three node types.

When you add a new command, pick whichever shape fits the data. **Do not** add a new envelope unless the data demands it. Do not add text-mode output.

## What to do if you don't know where to start

1. Run `npm test`. If anything is red, fix it first (a new agent should never commit on top of red).
2. Read `src/state.mjs` — it explains the storage shape and version handling.
3. Read one command end-to-end (`commands/take.mjs` is the most representative).
4. Look at `test/v2-take.test.mjs` (and `test/concurrent-takes.test.mjs` if present) — they show the multi-agent guarantee in action.
5. Then tackle your task. TDD: write the test, watch it fail, implement, watch it pass.

## Local AI workflow

This repository carries the portable agent workflow used by the Climier-based projects:

- `.pi/SYSTEM.md` — operating policy for the principal agent;
- `.pi/agents/climier-worker.md` — worker prompt;
- `.pi/agents/climier-validator.md` — independent validator prompt;
- `.pi/agents/rfc-reviewer.md` — RFC/ADR review prompt;
- `.agents/skills/climier/` — protocol and examples;
- `.agents/skills/climier-worker/` — worktree, context and finish helpers;
- `.agents/skills/climier-validator/` — validation and merge contract;
- `.agents/skills/spec-pipeline/` — RFC → review → ADR → tasks pipeline;
- `CLIMIER-CHEATSHEET.md` — quick command reference.

These files define how this project uses Climier. The project-specific source of truth remains the code, tests and `docs/`; the live Climier state remains outside the repository and is accessed only through the CLI.
