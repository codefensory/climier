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

The source tree makes the module boundaries explicit. Adapters translate
external input; application operations compose registered domain operations;
providers own domain semantics; the kernel owns the mutation transaction; and
storage owns persistence. The canonical dependency direction is:

```text
CLI / Plugins -> application/operations -> providers -> kernel -> storage
```

`read-model/` is a pure transversal module. `kernel/`, `providers/`, and
`read-model/` must not import adapters (`cli/` or `plugins`). `providers/` and
`read-model/` must not import `storage/`. The kernel must not know about
application or adapters.

### Source layout

```
bin/climier.mjs                       # Thin executable wrapper around cli/dispatch.mjs
src/
  application/operations/              # Registry, built-in catalog, and shared operation composition
    index.mjs                          # Public Application Operations boundary
    execute.mjs                        # Lookup, request construction, policy selection, one kernel call
    registry.mjs                       # Immutable process-local operation/provider index
    builtins.mjs                       # Canonical task/gate/knowledge/core operation catalog
  kernel/                              # Transaction, graph, mutation frontier, and state operations
    mutate.mjs                         # Stable mutate facade; owns lock/re-entrancy boundary
    transaction.mjs                    # In-memory draft transaction
    graph.mjs, edges.mjs               # DAG traversal and edge semantics
    state-operations.mjs               # Typed project/plugin state operations
    mutation/                          # Validation, preconditions, diffs, revisions, log entry, apply
  providers/                           # Pure task, gate, knowledge, and core domain operations
    task/, gate/, knowledge/, core/     # prepare/apply providers and read semantics
    plugin-data/                       # Typed plugin-scoped state providers
  read-model/                          # Pure status, blocking, knowledge, and informing projections
  storage/                             # Project metadata, state, lock, snapshots, and log primitives
    paths.mjs, state.mjs                # Project resolution and v3 state migration/read/write
    lock.mjs, log.mjs                   # Locking and log primitives
  plugins/                             # Plugin host, discovery, policy, and compatibility adapters
  cli/
    actor.mjs                          # CLI actor resolution from flags/environment
    dispatch.mjs                       # argv parsing, command/plugin routing, output/error handling
    commands/                           # One CLI adapter per command; parses flags and maps envelopes
  contracts/                           # Error contracts and compatibility-only public facades
 test/
  helpers.mjs                          # createTempProject, rmTempProject, runCli, importFresh
  *.test.mjs                            # Tests, one per module/feature
```

Boundary rules:

- `cli/commands/` owns argv validation, actor resolution, adapter-specific
  defaults, and the public JSON envelope. It does not own state, locks, logs,
  revisions, or domain rules.
- `application/operations/` owns the immutable registry and built-in operation
  catalog. `executeOperation({ projectDir, actor, operation, input, source })`
  performs one lookup, builds one request, and delegates once to the mutation
  frontier. It does not persist state or implement lifecycle semantics.
- `providers/` expose typed `{ prepare, apply }` operations. They validate and
  apply domain behavior against a transaction draft but do not import adapters,
  storage, locks, logs, or the registry.
- `kernel/mutation/` owns the single locked mutation pipeline: fresh snapshot,
  preconditions/policy, provider plan, draft validation, diff/revisions, and
  atomic state-plus-log commit. `kernel/mutate.mjs` remains the stable facade.
- `read-model/` composes graph and provider semantics into read-only views; it
  has no argv, filesystem, mutation, or logging concerns.
- `plugins/` is the host/adapter boundary. Plugin core actions consume the
  Application Operations catalog and cannot replace actor, registry, locking,
  or persistence through input.
- `storage/` is the only persistence layer. Mutations reach it through the
  kernel; callers must not edit the live state file directly.

When adding behavior, keep normalization in the adapter, reusable semantics in
providers, orchestration in Application Operations, and transaction/persistence
in the kernel. Do not recreate a second registry, lock path, or mutation
frontier in a command or plugin.

### The state shape

The repository uses a single state schema:

```js
{
  version: 3,
  initiatives: { "auth-migration": { desc, created_at } },
  nodes: { "T-auth-1": { id, kind, subkind, title, status, ... } },
  edges: [{ from, to, type }],
  log: []
}
```

`status: "ready"` and `"blocked"` are **derived** from the DAG. They are NOT persisted. Persisted statuses on tasks are `open` (default), `in_progress`, `submitted`, `done`, `canceled`. `submitted` is waiting for validation and never satisfies `BLOCKS`; only `done` and `archived` do. `done` means implementation accepted. Gates additionally use `resolved` / `superseded`. Knowledge uses `active` / `deprecated`.

The CLI surface is a single set of commands. `init` always creates the schema above.

`take <id>` requires an explicit task id and records the active claim. A takeover records the previous claimant in the log. `submit` releases the implementation claim and records submission metadata; `accept` moves a submitted task to accepted `done`, while `reject` reopens it.

Canonical `BLOCKS` direction is `{ from: blocker, to: blocked, type: "BLOCKS" }`; blockers are incoming edges to the blocked node.

### The two non-obvious invariants

1. **Atomicity: every mutating operation enters through `kernel/mutate.mjs` and its `withLock` → atomic state write pipeline.** Two agents in parallel can't corrupt the file. The `withLock` lock file lives next to the active state file (`~/.climier/projects/<project-id>/.lock`), is created with `fs.openSync(..., 'wx')` (fails on EEXIST), and is re-acquired in a spin loop with a 10s default timeout. Stale lock files (process died) are NOT auto-cleared — that is documented as the known ceiling of the file-lock strategy.
2. **Logging is part of the mutation.** The kernel mutation coordinator builds the log entry and commits the state plus log atomically in one locked write. Do not split state and log persistence across locks or reimplement either concern in an adapter/provider.

### Derived state and the DAG

Read derivation lives in `src/read-model/index.mjs`, which composes graph
traversal with task, gate, and knowledge provider semantics. The pure provider
helpers in `src/providers/` compute lifecycle/readiness rules; the CLI
`status` and `context` adapters only load a snapshot and shape their output.
Pure functions with no I/O let unit tests pass literal snapshots.

`status` surfaces `{ summary: { ready, in_progress, submitted, blocked, backlog, placeholders, stale, open_decisions, done, archived } }`. Backlog tasks are kept out of the ready/blocked pools until `--backlog false` is set on the node (or they were created without `--backlog true`).

Cycles in the DAG must not crash. The derivation keeps cycle members blocked. Unknown dep ids also keep tasks blocked (defensive).

## Commands

| Command | File | Mutates? | Needs `--as`? |
|---|---|---|---|
| `init [--force]` | `cli/commands/init.mjs` | yes (creates/overwrites state) | no |
| `status [--initiative X] [--kind task\|gate\|knowledge] [--status X] [--domain X] [--claimed-by X] [--stale-ms N] [--limit N] [--all]` | `cli/commands/status.mjs` | no | no |
| `context <id>` | `cli/commands/context.mjs` | no | no |
| `search "<query>" [--all]` | `cli/commands/search.mjs` | no | no |
| `history <id> [--limit N]` | `cli/commands/history.mjs` | no | no |
| `show <id>` | `cli/commands/show.mjs` | no | no |
| `initiatives [--all]` | `cli/commands/initiatives.mjs` | no | no |
| `log [--limit N] [--action X] [--agent X] [--task X] [--decision X]` | `cli/commands/log.mjs` | no | no |
| `take <id>` | `cli/commands/take.mjs` | yes | yes |
| `submit <id> --note "..."` | `cli/commands/submit.mjs` | yes | yes |
| `accept <id>` | `cli/commands/accept.mjs` | yes | yes |
| `reject <id> --reason "..."` | `cli/commands/reject.mjs` | yes | yes |
| `release <id>` | `cli/commands/release.mjs` | yes | yes |
| `resolve <id> --choice "<x>" --rationale "<y>"` (gate only) | `cli/commands/resolve.mjs` | yes | yes |
| `reopen <id> --reason "<text>"` | `cli/commands/reopen.mjs` | yes | yes |
| `cancel <id> --reason "<text>"` | `cli/commands/cancel.mjs` | yes | yes |
| `update <id> [--title X] [--body "..."] [--definition "..."] [--acceptance "..."] [--domain Y] [--tags ...] [--backlog true\|false] [--if-revision N]` | `cli/commands/update.mjs` | yes | required (any value) |
| `add-note <id> "<text>"` | `cli/commands/add-note.mjs` | yes | required (any value) |
| `add-initiative <name> [--desc "..."]` | `cli/commands/add-initiative.mjs` | yes | required |
| `add-task [id] --initiative X --title "..." --body "..." --acceptance "..." --blocked-by A,B [--backlog true]` | `cli/commands/add-task.mjs` | yes | required |
| `add-gate [id] --initiative X --title "..." --body "..." --purpose decision\|approval\|external-dependency\|research [--supersedes OLD]` | `cli/commands/add-gate.mjs` | yes | required |
| `add-knowledge [id] --initiative X --title "..." --body "..." [--scope-domains X] [--scope-initiatives X] [--scope-tags X] [--scope-node-ids X] [--supersedes OLD]` | `cli/commands/add-knowledge.mjs` | yes | required |
| `deprecate-knowledge <id> --reason "<text>"` | `cli/commands/deprecate-knowledge.mjs` | yes | required |
| `add-node <id> --kind resolvable\|knowledge --title "..." [--subkind task\|gate] [--blocked-by A,B] [--derived-from A,B] [--refs a,b] [--meta '{...}']` | `cli/commands/add-node.mjs` | yes | required |
| `add-edge <from> <to> --type BLOCKS\|SUPERSEDES\|DERIVED_FROM` | `cli/commands/add-edge.mjs` | yes | required |
| `snapshots` | `cli/commands/snapshots.mjs` | no (read-only) | no |
| `restore <id> --as orchestrator\|recovery` | `cli/commands/restore.mjs` | yes (locked; accepts v2/v3 snapshots, normalizes v2 to v3; pre-snapshot) | yes (orchestrator\|recovery only) |
| `ui [--port N] [--open=true\|false]` | `cli/commands/ui.mjs` (starts `ui/server/server.mjs`) | no (read-only) | no |

## Hard rules for contributing

1. **No new runtime dependencies for the CLI.** Stdlib only. The `ui/` directory is an exception by design: it is a self-contained subproject (own `package.json`, `node_modules`, `dist/`) for the local web UI (Express server + Solid/Tailwind frontend). `climier ui` imports `ui/server/server.mjs`, which resolves its deps from `ui/node_modules`; the CLI package itself gains no runtime deps. If you think you need a package in `bin/`/`src/`, you almost certainly don't.
2. **TDD strict.** Write the failing test first, then make it pass. The test suite is the spec. Exception: the `ui/` subproject does not require TDD nor changes to `test/`; it does require verification proportional to the blast radius, explicit (named command, observed output, or manual check), and documented in the commit body, the PR description, or a `climier add-note`. The TDD rule still applies to everything outside `ui/`.
3. **No silent failures.** Every error path either throws with a clear message or has a tested behavior. If you find yourself "handling" an error by logging and continuing, write a test that documents the behavior, or change the code to fail loud.
4. **Schema validation on write.** `writeState` rejects states missing `nodes`/`edges`/`initiatives`/`log`. Don't relax this without a test that says why.
5. **Versioning.** The state has `version: 3`; `readState` migrates compatible v2 snapshots to v3. Additive optional fields that an older compatible CLI can safely preserve and ignore do not require a version bump. Bump the version and add a migration in `readState` when a change removes or reinterprets existing data, makes a field required for correct behavior, changes core semantics, or otherwise means an older CLI cannot safely read and write the state. Document the compatibility decision and never silently accept unknown future versions.
6. **Multi-agent safety.** Any new state mutation must enter through the kernel mutation frontier (or an explicitly documented setup/recovery path) and be serialized by `withLock`. Any new "log" must be committed with the state change it describes. If you split them, a concurrent op can interleave and the log will lie.
7. **Task validation lifecycle.** `submit` hands an implementation to validation; `accept` records the validated task as `done`, and `reject` returns it to `open` with a reason. `resolve` is reserved for gates; `release`, `reopen`, and `cancel` remain administrative lifecycle operations.
8. **No boolean flags before the command.** The CLI parser treats `--force init` as `--force=init`. New boolean flags must be used as `--flag=true` or after the command. Document any new boolean flag with this caveat.
9. **English only in code, but the CLI output tolerates any UTF-8.** Titles, bodies, notes, and any free-text field can be in any language. Don't filter or escape based on locale.

## How to add a command or operation

First decide which boundary owns the change. A reusable domain action is an
Application Operation; a user-facing verb is a CLI adapter over that operation.
Do not put domain rules or persistence in the CLI layer.

### Adding a reusable operation

1. **Test first.** Add focused tests for valid input, domain errors, idempotency,
   and relevant edge cases. Use literal snapshots for pure provider tests.
2. **Implement the provider.** Add a pure `{ prepare, apply }` provider under
   the appropriate `src/providers/<domain>/` namespace. `prepare` validates
   against the fresh snapshot; `apply` changes only the kernel transaction
   draft. Providers must not import `cli/`, `plugins/`, `storage/`, locks, or
   logging.
3. **Register the operation.** Add its canonical `<domain>.<verb>` id and
   provider to `src/application/operations/builtins.mjs` (and the matching
   public operation list when applicable). The immutable registry is process
   configuration, not project state; do not create a second registry.
4. **Preserve the mutation frontier.** Hosts call
   `executeOperation({ projectDir, actor, operation, input, source })`, which
   looks up the provider and delegates once to `kernel/mutate.mjs`. The kernel
   owns locking, policy timing, revisions, diffs, validation, and the atomic
   state-plus-log write.
5. **Run the proportional provider, registry, and integration tests**, then
   `npm test` when the shared operation or kernel contract is affected.

### Adding a CLI command

1. **Test first.** Add `test/<name>.test.mjs` or the appropriate integration
   test. Cover the public happy path, validation/permission errors, missing
   state, and one edge case.
2. **Implement `src/cli/commands/<name>.mjs`.** Export the async command
   adapter and its `knownFlags`. Parse positional arguments and flags, resolve
   the actor with `src/cli/actor.mjs`, normalize only CLI-specific input, and
   invoke the canonical Application Operation or read-model projection.
3. **Keep the adapter thin.** It may preserve a legacy CLI envelope or error
   classification, but must not acquire locks, write state/logs, assign
   revisions, or duplicate provider semantics. Mutations must enter through
   the kernel mutation frontier.
4. **Wire it through `src/cli/dispatch.mjs`** and update the help text exposed
   by the dispatch adapter. `bin/climier.mjs` remains a thin executable
   wrapper; there is no separate printer map because the CLI is JSON-only.
5. **Document the command** in the Quick reference table above and README when
   the public surface changes. Add integration coverage when it crosses
   dispatch, operations, plugins, or storage.
6. **Run `npm test`** (plus concurrent/UI checks when the changed boundary
   requires them). Do not commit with a red required suite.

## How to add a new field to the state

1. **Update `emptyState()` in `src/storage/state.mjs`** if the field is required for new states.
2. **Update `writeState` validation** if the field is required for all writes (most fields are optional, so this is rare).
3. **Add tests for the new field's behavior.** If it's a derived field, test it via `derive` or `statusOf`. If it's persisted, test via the command that sets it.

5. **Document in this file's "State shape" section** if the field is a primary concept; otherwise, leave it for code reading.

## How to extend the DAG model

- **New task status** (beyond `open`/`in_progress`/`done`/`canceled`): add to the persisted set AND update the derivation logic to handle it. Don't treat unknown statuses as `ready` without thinking — pass-through is the current policy for forward compat. If you want stricter behavior, add a test that locks down the policy.
- **New gate kind** (e.g. a sub-class of `gate`): the current model uses `subkind` and `purpose` to discriminate. Adding a new subkind means changes in `src/providers/gate/`, the CLI adapter that creates the subkind, and the affected read-model projections (`status`, `context`). Document it.
- **Cross-initiative dependencies**: already supported via `--blocked-by` ids. The `--initiative` filter is for views only, not for resolution.

## Conventions in the code

- **Async everywhere.** All commands are `async` and use `await` for I/O.
- **No `try`/`catch` around `await` for control flow.** Let errors propagate. The CLI entry catches and formats them.
- **Error messages start with the command name.** `"take: node T1 is not ready"` not `"Node T1 is not ready"`. This makes logs grep-able.
- **Positional args for things, flags for options.** `climier take T1 --as alice` not `--id T1 --agent alice`.
- **CSV in flag values.** `--tags "ts,sql"` not `--tag ts --tag sql`. Trim and filter empty strings.
- **Pure projections live in `read-model/` and pure domain semantics live in `providers/`.** No I/O or side effects. Test them with literal snapshots, no temp dirs.
- **Imperative wrappers in `storage/state.mjs` and `storage/lock.mjs`.** These touch the filesystem. They are tested via `helpers.mjs` (temp dirs).
- **Adapters return data, not console.log.** `bin/climier.mjs` is the only place that prints (except for errors).

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

- **Task corrections use the validation lifecycle.** Workers submit implementation evidence; validators accept or reject it. `reopen` is the administrative rollback from `done` to `open`, while `resolve` is reserved for gates.
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

# Local code smoke (not DAG coordination)
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
  - `status` and `context` are deliberately richer than the other reads: the agent is the primary consumer, so the output is shaped to remove ambiguity. `status` adds `summary.{ready,in_progress,submitted,blocked,backlog,open_gates,active_knowledge}` (totals) and `alerts[]` (kinds: `stale-claim`). `context` adds `derived_status`, `revision`, `claim`, `blocking[]`, `knowledge[]` (scoped), `informing[]`, `alerts[]`, and `allowed_actions[]`.
- **Write commands** (`take`, `submit`, `accept`, `reject`, `resolve` for gates, `release`, `reopen`, `cancel`, `update`, `add-note`, `add-*`, `deprecate-knowledge`) return `{ entity }` envelopes (`{ node }`, `{ task }`, `{ initiative }`, etc.).
- `init` returns `{ ok, seeded, file }` (different shape because it is not creating an entity, it is setting up a state).
- `show` returns `{ type, node }` because it can return any of three node types.

When you add a new command, pick whichever shape fits the data. **Do not** add a new envelope unless the data demands it. Do not add text-mode output.

## What to do if you don't know where to start

1. Run `npm test`. If anything is red, fix it first (a new agent should never commit on top of red).
2. Read `src/storage/state.mjs` — it explains the storage shape and version handling.
3. Read one command end-to-end (`src/cli/commands/take.mjs` is the most representative).
4. Look at `test/v2-take.test.mjs` (and `test/concurrent-takes.test.mjs` if present) — they show the multi-agent guarantee in action.
5. Then tackle your task. TDD: write the test, watch it fail, implement, watch it pass.

## Climier control plane

All DAG coordination must use the globally linked stable Climier control binary:

```bash
command -v climier
# expected target: .../climier-control/bin/climier.mjs
climier status
climier context <task-id>
climier add-note <id> "..." --as <agent>
```

Never use `node bin/climier.mjs` for coordination (`status`, `context`, `take`,
`update`, `add-note`, `resolve` for gates, `release`, or any other DAG
operation). The
local worktree CLI may be invoked only to verify the code being developed, for
example with a temporary project smoke; it is not the control plane. The stable
binary and the refactor worktree must use the same `CLIMIER_HOME` and project
metadata.

Each shell-tool invocation is independent: a `cd` from one invocation does not
carry into the next. Workers and validators must prefix every worktree command
with `cd <worktree> &&` (or use absolute paths) and verify `pwd` plus the branch
in that same invocation. Never run worktree tests from the main checkout.
Tests must be bounded and targeted. Use the repository core test runner or an
explicit file list with a timeout; do not use `--test-skip-pattern` as a way to
exclude files.

## Task sizing and agent budget

Keep each task to one primary outcome, one owner and a verifiable acceptance.
If a task is likely to exceed 100 agent turns, split it before delegation;
prefer smaller sequential slices for central contracts, persistence and
integration. Split by real boundaries such as contract/foundation,
implementation and integration, with exclusive paths and explicit dependencies.
Do not wait for an agent to hit the limit: if the scope expands during work,
narrow it or leave a concrete handoff for a follow-up task rather than adding
unrelated changes.

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
