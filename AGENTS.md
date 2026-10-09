# climier — Agent Notes

You are working on **climier**, a task DAG CLI for coordinating work across agents, sessions, or humans. Each repo gets stable metadata in `.climier.json`; the live JSON state for that project lives under `~/.climier/projects/<project-id>/tasks.json` (or `$CLIMIER_HOME/projects/<project-id>/tasks.json`).

This file tells you how the code is organized, the rules you must follow, and the non-obvious decisions baked into the design. Read it before touching anything.

## What this repo is

- A Node CLI. No runtime dependencies, stdlib only.
- ESM modules (`"type": "module"` in `package.json`).
- Tests run with `node --test` (stdlib).
- Entry point: `bin/climier.ts`. Library code: `src/`. Tests: `test/`.
- The CLI resolves a project root (CWD by default, `--project <dir>` to override), reads `<project>/.climier.json`, and then operates on the matching live state file under `~/.climier/projects/<project-id>/tasks.json`.

## Architecture

The source tree makes the module boundaries explicit. Adapters translate
external input; application operations compose registered domain operations;
providers own domain semantics; the kernel owns the mutation transaction; and
storage owns persistence. The canonical dependency direction is:

```text
adapters (cli/, plugins/, server/) -> application/operations -> providers -> kernel -> storage
```

Adapters also consume `providers/` and the pure `read-model/` projections
directly, and every mutation enters through the `kernel/mutate.ts` facade
(`plugins/` and `server/` included). Both shapes are approved: ADR-013 §5 lets
the plugin host consume kernel, providers and read-model, ADR-032 keeps server
transfers on the kernel port, and the enforcement table in
`test/architecture/import-boundaries.test.ts` declares those five edges as
normative allowed roots. `read-model/` is a pure transversal module. `kernel/`,
`providers/`, and `read-model/` must not import adapters (`cli/`, `plugins/`, or
`server`). `providers/` and `read-model/` must not import `storage/`. The kernel
must not know about application or adapters.

### Source layout

```
bin/climier.ts                       # Thin executable wrapper around cli/dispatch.mjs
docs/                                 # Standalone public documentation site and canonical references
  package.json, bun.lock              # Site-only dependencies and reproducible lockfile
  content/docs/                       # Public site pages grouped by getting-started, concepts, guides, and reference
  reference.md, PLUGINS.md, remote-server.md # Canonical published Markdown paths
  scripts/                            # Canonical sync and public-surface checks
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
  storage/                             # Project metadata, canonical state, ledger, locks, snapshots, and logs
    paths.mjs, state.mjs                # Project resolution and schema-1 state guards/read helpers
    lock.mjs, log.mjs                   # Locking and log primitives
    ledger/                              # Revision fence, migration, recovery, and atomic commits
  server/                              # Authenticated remote HTTP runtime and typed API projections
  plugins/                             # Plugin host, discovery, policy, and compatibility adapters
  cli/
    actor.mjs                          # CLI actor resolution from flags/environment
    dispatch.mjs                       # argv parsing, command/plugin routing, output/error handling
    commands/                           # One CLI adapter per command; parses flags and maps envelopes
  contracts/                           # Error contracts and compatibility-only public facades
 test/
  helpers.ts                          # createTempProject, rmTempProject, runCli/runCliSpawn, importFresh
  *.test.ts                             # Tests, one per module/feature
```

Boundary rules:

- `docs/` is a public documentation subproject. Keep the three canonical Markdown files at their existing paths, and put new site content under `docs/content/docs/`. The root package remains CLI-only; site dependencies stay in `docs/`.
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
  atomic state-plus-log commit. `kernel/mutate.ts` remains the stable facade.
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

The repository uses one canonical schema-1 state plus its revision fence and
ledger:

```js
{
  version: 1,
  fence_generation: 1,
  revision: 0,
  initiatives: { "auth-migration": { desc, created_at } },
  nodes: { "T-auth-1": { id, kind, subkind, title, status, ... } },
  edges: [{ from, to, type }],
  log: []
}
```

Every writer also maintains `revision-ledger.json` beside the state. The ledger,
lock, state, and log are committed atomically. Projects written before this
cut must go through `climier migrate --all --dry-run` and `climier migrate
--all` with every writer stopped; the import and rollback order is in
`docs/remote-server.md`. `init --force` is a deliberate reset only, never a
migration path.

`status: "ready"` and `"blocked"` are **derived** from the DAG. They are NOT persisted. Persisted statuses on tasks are `open` (default), `in_progress`, `submitted`, `done`, `canceled`. `submitted` is waiting for validation and never satisfies `BLOCKS`; only `done` and `archived` do. `done` means implementation accepted. Gates additionally use `resolved` / `superseded`. Knowledge uses `active` / `deprecated`.

The CLI surface is a single set of commands. `init` always creates the schema above.

The runner records the implementation claim and submission metadata atomically. Its internal lifecycle moves accepted work to `done` and returns rejected work to `open`; Pi agents invoke it only through the `climier_flow` extension tool, never by running Flow shell commands or reproducing lifecycle transitions manually.

Canonical `BLOCKS` direction is `{ from: blocker, to: blocked, type: "BLOCKS" }`; blockers are incoming edges to the blocked node.

### The two non-obvious invariants

1. **Atomicity: every mutating operation enters through `kernel/mutate.ts` and its `withLock` → atomic state write pipeline.** Two agents in parallel can't corrupt the file. The `withLock` lock file lives next to the active state file (`~/.climier/projects/<project-id>/.lock`), is created with `fs.openSync(..., 'wx')` (fails on EEXIST), and is re-acquired in a spin loop with a 10s default timeout. Stale lock files (process died) are NOT auto-cleared — that is documented as the known ceiling of the file-lock strategy.
2. **Logging is part of the mutation.** The kernel mutation coordinator builds the log entry and commits the state plus log atomically in one locked write. Do not split state and log persistence across locks or reimplement either concern in an adapter/provider.

### Derived state and the DAG

Read derivation lives in `src/read-model/index.ts`, which composes graph
traversal with task, gate, and knowledge provider semantics. The pure provider
helpers in `src/providers/` compute lifecycle/readiness rules; the CLI
`status` and `context` adapters only load a snapshot and shape their output.
Pure functions with no I/O let unit tests pass literal snapshots.

`status` surfaces `{ summary: { ready, in_progress, submitted, blocked, backlog, placeholders, stale, open_decisions, done, archived } }`. Backlog tasks are kept out of the ready/blocked pools until `--backlog false` is set on the node (or they were created without `--backlog true`).

Cycles in the DAG must not crash. The derivation keeps cycle members blocked. Unknown dep ids also keep tasks blocked (defensive).

## Commands

| Command | File | Mutates? | Needs `--as`? |
|---|---|---|---|
| `init [--force]` | `cli/commands/init.ts` | yes (creates/overwrites state) | no |
| `status [--initiative X] [--kind task\|gate\|knowledge] [--status X] [--domain X] [--claimed-by X] [--stale-ms N] [--limit N] [--all]` | `cli/commands/status.ts` | no | no |
| `context <id>` | `cli/commands/context.ts` | no | no |
| `search "<query>" [--all]` | `cli/commands/search.ts` | no | no |
| `history <id> [--limit N]` | `cli/commands/history.ts` | no | no |
| `show <id>` | `cli/commands/show.ts` | no | no |
| `initiatives [--all]` | `cli/commands/initiatives.ts` | no | no |
| `log [--limit N] [--action X] [--agent X] [--node X]` | `cli/commands/log.ts` | no | no |
| `take <id>` | `cli/commands/take.ts` | yes | yes |
| `submit <id> --note "..."` | `cli/commands/submit.ts` | yes | yes |
| `accept <id>` | `cli/commands/accept.ts` | yes | yes |
| `reject <id> --reason "..."` | `cli/commands/reject.ts` | yes | yes |
| `release <id>` | `cli/commands/release.ts` | yes | yes |
| `resolve <id> --choice "<x>" --rationale "<y>"` (gate only) | `cli/commands/resolve.ts` | yes | yes |
| `reopen <id> --reason "<text>"` | `cli/commands/reopen.ts` | yes | yes |
| `cancel <id> --reason "<text>"` | `cli/commands/cancel.ts` | yes | yes |
| `update <id> [--title X] [--body "..."] [--definition "..."] [--acceptance "..."] [--domain Y] [--tags ...] [--backlog true\|false] [--if-revision N]` | `cli/commands/update.ts` | yes | required (any value) |
| `add-note <id> "<text>"` | `cli/commands/add-note.ts` | yes | required (any value) |
| `add-initiative <name> [--desc "..."]` | `cli/commands/add-initiative.ts` | yes | required |
| `add-task [id] --initiative X --title "..." --body "..." --acceptance "..." --blocked-by A,B` | `cli/commands/add-task.ts` | yes | required |
| `add-gate [id] --initiative X --title "..." --body "..." --purpose decision\|approval\|external-dependency\|research [--supersedes OLD]` | `cli/commands/add-gate.ts` | yes | required |
| `add-knowledge [id] --initiative X --title "..." --body "..." [--scope-domains X] [--scope-initiatives X] [--scope-tags X] [--scope-node-ids X] [--supersedes OLD]` | `cli/commands/add-knowledge.ts` | yes | required |
| `deprecate-knowledge <id> --reason "<text>"` | `cli/commands/deprecate-knowledge.ts` | yes | required |
| `add-node <id> --kind resolvable\|knowledge --title "..." [--subkind task\|gate] [--blocked-by A,B] [--derived-from A,B] [--refs a,b] [--meta '{...}']` | `cli/commands/add-node.ts` | yes | required |
| `add-edge <from> <to> --type BLOCKS\|SUPERSEDES\|DERIVED_FROM` | `cli/commands/add-edge.ts` | yes | required |
| `remove-edge <from> <to> --type BLOCKS\|SUPERSEDES\|DERIVED_FROM` | `cli/commands/remove-edge.ts` | yes | required |
| `snapshots` | `cli/commands/snapshots.ts` | no (read-only) | no |
| `state` | `cli/commands/state.ts` | no (read-only) | no |
| `restore <id> --as <agent>` | `cli/commands/restore.ts` | yes (locked; canonical schema-1 snapshot; pre-snapshot) | required |
| `batch --file <json> --as <agent>` / `batch --stdin --as <agent>` | `cli/commands/batch.ts` | yes | required |
| `link <origin> [--replace=true]` | `cli/commands/link.ts` | yes | required |
| `login [--server <origin>]` / `logout [--server <origin>]` | `cli/commands/login.ts`, `cli/commands/logout.ts` | yes | required |
| `migrate [--project <dir>] [--all] [--dry-run]` | `cli/commands/migrate.ts` | yes unless dry-run | required for import |
| `ui [--port N] [--open=true\|false]` (experimental) | `cli/commands/ui.mjs` (starts `ui/server/server.mjs`) | no (read-only) | no |

## Hard rules for contributing

1. **No new runtime dependencies for the CLI.** Stdlib only. The `ui/` directory is an exception by design: it is a self-contained subproject (own `package.json`, `node_modules`, `dist/`) for the local web UI (Express server + Solid/Tailwind frontend). `climier ui` imports `ui/server/server.mjs`, which resolves its deps from `ui/node_modules`; the CLI package itself gains no runtime deps. The `docs/` directory is a second self-contained exception: its own `package.json`, lockfile, dependencies, and build output belong to the public documentation site and must not add runtime dependencies to the root package. If you think you need a package in `bin/`/`src/`, you almost certainly don't.
2. **TDD strict.** Write the failing test first, then make it pass. The test suite is the spec. Exception: the `ui/` subproject does not require TDD nor changes to `test/`; it does require verification proportional to the blast radius, explicit (named command, observed output, or manual check), and documented in the commit body, the PR description, or a `climier add-note`. The TDD rule still applies to everything outside `ui/`.
3. **No silent failures.** Every error path either throws with a clear message or has a tested behavior. If you find yourself "handling" an error by logging and continuing, write a test that documents the behavior, or change the code to fail loud.
4. **Schema validation on write.** `writeState` rejects states missing `nodes`/`edges`/`initiatives`/`log`. Don't relax this without a test that says why.
5. **Versioning.** The canonical state schema is 1 and the reader rejects older
   or unknown forms. Migration is an explicit, one-time import command, not an
   implicit read/write conversion. Any future schema change needs an explicit
   migration and tests; never silently accept an unknown form or use
   `init --force` as a conversion shortcut.
6. **Multi-agent safety.** Any new state mutation must enter through the kernel mutation frontier (or an explicitly documented setup/recovery path) and be serialized by `withLock`. Any new "log" must be committed with the state change it describes. If you split them, a concurrent op can interleave and the log will lie.
7. **Task lifecycle.** `climierflow` owns implementation, review, submission, and acceptance transitions. `resolve` is reserved for gates; `release`, `reopen`, and `cancel` remain administrative lifecycle operations.
8. **No boolean flags before the command.** The CLI parser treats `--force init` as `--force=init`. New boolean flags must be used as `--flag=true` or after the command. Document any new boolean flag with this caveat.
9. **English only in code, but the CLI output tolerates any UTF-8.** Titles, bodies, notes, and any free-text field can be in any language. Don't filter or escape based on locale.
10. **Commits follow the contract.** Conventional Commits plus the DAG node id in the subject; `.githooks/commit-msg` rejects anything else. See the `## Commits` section below.

## Commits

Every commit in this repository follows Conventional Commits and names the DAG node
it implements. `.githooks/commit-msg` (logic in `scripts/check-commit-msg.ts`) rejects
a commit that breaks this.

```
<type>(<scope>)!?: <subject> [<node-id>]
```

- `<type>`: mandatory, lowercase, one of `feat fix docs style refactor perf test build ci chore revert`.
- `<scope>`: optional and free-form, no parentheses inside; `feat(cli): ...`.
- `!`: optional, marks a breaking change, and goes before the colon; `feat(state)!: ...`.
- `<subject>`: mandatory, separated from the type by `: `.
- `[<node-id>]`: mandatory, at the end of the **first line**, separated by a space. It must
  resolve in this project's DAG (`climier show <id>`); `T-re-commit-msg-hook` and
  `G-adr062-commit-contract` are valid, an invented id is not.
- Only the first line is validated. Details go in the body after a blank line.

Exempt from both the format and the node id: `Merge ...` (the runner's integrator
commits), `Revert "..."`, `fixup!`/`squash!`/`amend!`, and release commits
(`release: vX.Y.Z`, `chore(release): ...`).

Escapes:

- `git commit --no-verify` skips the hook entirely.
- `CLIMIER_COMMIT_NO_TASK=1` keeps the format checks and skips only the DAG lookup, for
  commits that legitimately have no node (tooling, offline).

Installation is explicit, never on `prepare`: `bun run setup:hooks` sets
`git config core.hooksPath .githooks`. Without that config the hook is inert, so
`--no-verify` remains a real escape. The contract is enforced **locally only**: CI does
not validate commit messages.

Errors are `INVALID_FORMAT` (bad format, or a missing node id), `NODE_NOT_FOUND` (the id
is not in the DAG) and `DAG_UNREACHABLE` (the id could not be checked: offline, missing
credentials, timeout). Override the binary used for the lookup with `CLIMIER_BIN`.

```
feat(cli): add climier upgrade --check [T-re-upgrade-command]
fix(install): abort on a mismatched sha256 without writing [T-re-installer]
feat(state)!: stop reading the pre-migration state [G-adr062-commit-contract]
```

The runner (`climier-flow`) runs its Worker and validatorCommit agents inside a worktree
of this repository and loads this file (`noContextFiles: false`), so those agents create
their task commit with the same format.

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
   provider to `src/application/operations/builtins.ts` (and the matching
   public operation list when applicable). The immutable registry is process
   configuration, not project state; do not create a second registry.
4. **Preserve the mutation frontier.** Hosts call
   `executeOperation({ projectDir, actor, operation, input, source })`, which
   looks up the provider and delegates once to `kernel/mutate.ts`. The kernel
   owns locking, policy timing, revisions, diffs, validation, and the atomic
   state-plus-log write.
5. **Run the proportional provider, registry, and integration tests**, then
   `npm test` when the shared operation or kernel contract is affected.

### Adding a CLI command

1. **Test first.** Add `test/<name>.test.ts` or the appropriate integration
   test. Cover the public happy path, validation/permission errors, missing
   state, and one edge case.
2. **Implement `src/cli/commands/<name>.mjs`.** Export the async command
   adapter and its `knownFlags`. Parse positional arguments and flags, resolve
   the actor with `src/cli/actor.ts`, normalize only CLI-specific input, and
   invoke the canonical Application Operation or read-model projection.
3. **Keep the adapter thin.** It may preserve a legacy CLI envelope or error
   classification, but must not acquire locks, write state/logs, assign
   revisions, or duplicate provider semantics. Mutations must enter through
   the kernel mutation frontier.
4. **Wire it through `src/cli/dispatch.ts`** and update the help text exposed
   by the dispatch adapter. `bin/climier.ts` remains a thin executable
   wrapper; there is no separate printer map because the CLI is JSON-only.
5. **Document the command** in the Quick reference table above and README when
   the public surface changes. Add integration coverage when it crosses
   dispatch, operations, plugins, or storage.
6. **Run `npm test`** (plus concurrent/UI checks when the changed boundary
   requires them). Do not commit with a red required suite.

## How to add a new field to the state

1. **Update `emptyState()` in `src/storage/state.ts`** if the field is required for new states.
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
- **Imperative wrappers in `storage/state.ts` and `storage/lock.ts`.** These touch the filesystem. They are tested via `helpers.ts` (temp dirs).
- **Adapters return data, not console.log.** `bin/climier.ts` is the only place that prints (except for errors).
- **Comments declare constraints, not narration.** Remove line-by-line narration, provenance, task/ADR justification, commented-out code, decorative banners, and documentation mirrors. Keep only restrictions the code cannot express.

## Testing

- `npm test` runs the whole suite; there is no separate UI suite to skip.
- For changes limited to `/ui`, the subproject's own checks are enough: `(cd ui && npm run build)` and any manual check you document. The root suite still applies to everything outside `/ui`.
- `ui/server/` consumes CLI state and read-only helpers. If a change crosses that boundary or changes a shared CLI contract, run the relevant targeted CLI tests too; use `npm test` when the blast radius warrants it. The UI is experimental and carries no root test suite.
- `npm run test:concurrent` runs the multi-agent race tests in isolation.
- Each test uses a temp dir (see `helpers.ts`) so tests don't interfere.
- `importFresh()` re-imports modules fresh between tests (defeats the module cache); use it when you need clean state.
- For CLI end-to-end tests, use `runCli(args, { cwd, env })`. It runs the real
  dispatch pipeline **in-process** (capturing stdout/exit, applying and
  restoring `cwd`/`env`), which keeps the suite fast; the returned shape is
  `{ stdout, stderr, code }`. Use `runCliSpawn` when the test needs real
  process isolation: parallel writers (`Promise.all` over CLI calls), stdin
  consumers (`batch --stdin`), or anything that observes process identity.
- Plugin install tests resolve local fixture directories through
  `test/fixtures/npm-shim` (`CLIMIER_NPM_CMD`), a strict test-only npm
  stand-in. Real npm costs two extra node processes per install; npm failure
  paths inject their own command, and an operator-set `CLIMIER_NPM_CMD`
  always wins.
- `npm test` partitions the suite into in-process shards
  (`test/run-core-tests.ts` + `test/core-test-plan.ts`) balanced by
  `test/test-durations.json`, a generated per-file timing table. Regenerate
  it with `node test/generate-test-durations.ts` after large test changes;
  files missing from the table fall back to a size estimate, so a stale
  table only degrades balance. Node < 22.8 (the CI matrix includes 20) runs
  one process-isolated runner; `CLIMIER_TEST_ISOLATION=process` forces that
  path and `CLIMIER_TEST_WORKERS=N` overrides the shard count.
- For unit tests of derivation logic, import the command file (or its helpers) and pass literal state objects — no filesystem needed.

### Test file naming

- `test/<module>.test.ts` for unit tests of a module.
- `test/<feature>.test.ts` for behavior tests that cross modules.
- `test/deep-holes-N.test.ts` for regression tests on bugs found in audit rounds.

When you fix a bug, write a test that reproduces it BEFORE the fix. The test goes in `bugs.test.ts` (real bugs) or `coverage-gaps.test.ts` (missing tests for known behaviors) or a new `deep-holes-N.test.ts` (deeper audit rounds).

## Non-obvious things that bit us

- **Task corrections use the runner lifecycle.** `climierflow` returns implementation and review evidence and owns the task transition; `reopen` is the administrative rollback from `done` to `open`, while `resolve` is reserved for gates.
- **`status --status DONE` (uppercase) works in `tasks` style filters.** Case-insensitive.
- **`status --staleMs 0` marks all in_progress as stale.** `staleMs: 0` is valid and means "everything in_progress is stale".
- **`status` is global by default for in_progress.** `tasks.in_progress` and `summary.in_progress` include every in_progress task in scope, regardless of caller. `--claimed-by <agent>` is the only way to narrow claims; `--as` is an identity tag for `context` and is intentionally not a filter for `status`. Stale-claim alerts follow the same rule.
- **`init --force` is destructive reset behavior**, not migration. It must never be used to convert a pre-cut project; import with `migrate` after stopping every writer.
- **`add-task --blocked-by NONEXISTENT` fails** with a clear error. State validation only runs when the state file exists (so empty projects can still bootstrap).
- **The state file is owned by the script.** `writeState` validates the schema. Don't write to the file from outside the CLI — even tests should go through `updateState`/`writeState` (or write valid schemas).
- **`status` returns an empty `tasks` / `gates` shape for an empty state, never throws.** New code that consumes `status` should preserve this.

## Working with the project

```bash
# Run all tests
npm test

# Run a single test file
node --test test/status-history.test.ts

# Run a single test by name
node --test --test-name-pattern="take.*same agent" test/take.test.ts

# Watch mode
npm run test:watch

# Local code smoke (not DAG coordination)
node bin/climier.ts --project /tmp/testproj init
node bin/climier.ts --project /tmp/testproj status
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
2. Read `src/storage/state.ts` — it explains the storage shape and version handling.
3. Read one command end-to-end (`src/cli/commands/take.ts` is the most representative).
4. Look at `test/take.test.ts` (and `test/concurrent-takes.test.ts` if present) — they show the multi-agent guarantee in action.
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

Never use `node bin/climier.ts` for coordination (`status`, `context`, `take`,
`update`, `add-note`, `resolve` for gates, `release`, or any other DAG
operation). The
local worktree CLI may be invoked only to verify the code being developed, for
example with a temporary project smoke; it is not the control plane. The stable
binary and the refactor worktree must use the same `CLIMIER_HOME` and project
metadata.

Each shell-tool invocation is independent: a `cd` from one invocation does not
carry into the next. Every runner worktree command must prefix the path with
`cd <worktree> &&` (or use absolute paths) and verify `pwd` plus the branch in
that same invocation. Never run worktree tests from the main checkout.
Tests must be bounded and targeted. Use the repository core test runner or an
explicit file list with a timeout; do not use `--test-skip-pattern` as a way to
exclude files.

## Unified execution protocol

Climier remains the control plane for creating, reading, and curating tasks, gates, knowledge, initiatives, and dependencies. In Pi, all Flow operations go through the `climier_flow` extension tool; do not invoke the Flow executable from shell or manually perform its internal stages.

Before a run, inspect the graph and task contract with `climier status` and `climier context <task-id>`. Then call the `climier_flow` tool with one of these argument objects:

```json
{ "action": "run", "task_id": "<task-id>" }
{ "action": "resume", "task_id": "<task-id>", "summary": "<optional checkpoint context>" }
{ "action": "restart", "task_id": "<task-id>", "body": "<replacement body>", "acceptance": "<replacement acceptance>" }
{ "action": "cancel", "task_id": "<task-id>" }
{ "action": "status", "task_id": "<task-id>" }
{ "action": "list" }
```

`run`, `resume`, and `restart` launch in the background; their tool result confirms launch, while the Pi widget tracks active progress. `restart` requires `body` and `acceptance` and asks for confirmation before discarding the owned workspace. `cancel` stops the running runner and kills its active node/FX harness. `run` defaults to Pi's current directory; pass optional `repo` only when targeting another checkout. `status` reads the saved execution report; `list` lists saved runs globally and is not a substitute for DAG readiness (`climier status`). The runner owns claim, worktree, implementation, review, lifecycle, commit, merge, and cleanup.

Do not fall back to a shell command for Flow. A completed and merged task must not be restarted; create a new correction task instead. DAG curation remains separate and uses `climier` commands. Before building a graph, register its initiative once with `climier add-initiative <name> --as <agent>`; `add-task`/`add-gate`/`add-knowledge` fail with `INITIATIVE_NOT_FOUND` otherwise, and `add-initiative` is not idempotent (`ID_CONFLICT`).

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

- Global portable skills (installed under `~/.agents/skills/`):
  - `climier` — DAG CLI usage; sourced from this repository (`skills/climier/`).
  - `climier-flow` — task execution through the `climier_flow` tool; sourced from the climier-flow repository (`skills/climier-flow/`).
  - `initiative-execution` — opt-in initiative coordination; sourced from the climier-flow repository.
- `.agents/skills/spec-pipeline/` — opt-in RFC → review → ADR → tasks pipeline; stays project-local because it writes `.decisions/` and `.adrs/`.
- `.pi/agents/rfc-reviewer.md` — RFC/ADR review prompt used by the spec pipeline.
- `.pi/APPEND_SYSTEM.md` — project routing and policy cues appended to Pi's built-in system prompt.
- `CLIMIER-CHEATSHEET.md` — quick Climier and Pi Flow tool reference.

These files define how this project uses Climier. The project-specific source of truth remains the code, tests and `docs/`; the live Climier state remains outside the repository and is accessed only through the CLI.

### Choosing a workflow

Ordinary small or local work may use the direct path: inspect the relevant files, make the minimal change, and run proportional checks. The controlled workflow is optional; recommend or select it for meaningful risk, cross-module coordination, public contracts, state or concurrency changes, or an explicit user request. Use the planning and initiative skills only when their opt-in triggers apply.

A task already registered for runner execution must use the Pi `climier_flow` tool with `action: "run"`. Do not replace that path with direct implementation, shell invocation of Flow, or manual lifecycle commands; the runner owns the task's claim, worktree, implementation, review, lifecycle, commit, merge, and cleanup stages.
