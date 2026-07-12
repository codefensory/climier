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
  state.mjs                 # emptyState, readState, writeState, updateState, addNode
                            # live state file is ~/.climier/projects/<project-id>/tasks.json
                            # repo keeps only .climier.json
  lock.mjs                  # withLock(projectDir, fn) — file lock for atomicity
  dag.mjs                   # PURE functions: derive, blockedByDecision, staleClaims, statusOf
  log.mjs                   # append log entries (delegates to updateState)
  gotchas.mjs               # forTask(state, task) — resolve gotchas by domain or task id

  commands/                 # One file per command. Each exports default async fn({ positional, flags, statePath, projectDir })
                            # Commands use withLock for any mutating op
test/
  helpers.mjs               # createTempProject, rmTempProject, runCli, importFresh
  *.test.mjs                # Tests, one per module/feature
```

### The state shape (v1)

```js
{
  version: 1,
  tasks: {                // keyed by task id
    "F0.T1": { id, title, initiative, status, depends_on, skills, effort, domain, ... }
  },
  decisions: {            // keyed by decision id
    "D1": { id, title, initiative, status: "open" | "decided", choice, rationale, ... }
  },
  gotchas: {              // keyed by gotcha id
    "G1": { id, title, applies_to: ["domain:db" | "task-id"], mitigation, status }
  },
  initiatives: {          // keyed by initiative name
    "migration": { desc }
  },
  log: [                  // append-only audit trail
    { ts, agent, action, task?, decision?, gotcha?, note? }
  ]
}
```

`status: "ready"` and `"blocked"` are **derived** from the DAG. They are NOT persisted. Persisted statuses are only `in_progress`, `done`, `archived`. A task with no `status` field is derived as `ready` (if no deps) or `blocked`.

### The two non-obvious invariants

1. **Atomicity: every mutating command goes through `withLock` → `updateState` (atomic tmp+rename).** Two agents in parallel can't corrupt the file. The `withLock` lock file lives next to the active state file (`~/.climier/projects/<project-id>/.lock`), is created with `fs.openSync(..., 'wx')` (fails on EEXIST), and is re-acquired in a spin loop with a 10s default timeout. Stale lock files (process died) are NOT auto-cleared — that's documented as the known ceiling for v1.
2. **Logging is part of the mutation.** Every command that changes state calls `updateState` (under `withLock`) and then `append` to the log. Both happen inside the same `withLock` block. Do not split them across locks.

### Derived state and the DAG

`src/dag.mjs` is **pure**: given a state, it computes ready/blocked/open/backlog. No I/O. Tests rely on this purity — you can unit-test DAG logic without a filesystem.

`derive(state)` returns `{ ready: string[], blocked: string[], openDecisions: string[], backlog: string[] }`. Tasks with `depends_on: [task_ids, decision_ids]` are ready only when ALL deps are satisfied (a task is satisfied if its `status` is `done` or `archived`; a decision is satisfied if its `status` is `decided`). Backlog tasks are kept out of the ready/blocked pools until promoted.

Cycles in the DAG must not crash. `derive` keeps cycle members blocked. Unknown dep ids also keep tasks blocked (defensive).

## Commands

| Command | File | Mutates? | Needs `--as`? |
|---|---|---|---|
| `init [--force]` | `commands/init.mjs` | yes (creates/overwrites state) | no |
| `status [--initiative X] [--staleMs N]` | `commands/status.mjs` | no | no |
| `ready [--initiative X]` | `commands/ready.mjs` | no | no |
| `claim <id>` | `commands/claim.mjs` | yes | yes |
| `next <id>` | `commands/next.mjs` | no | no |
| `pre-claim <id> [--staleMs N]` | `commands/pre-claim.mjs` | no | no |
| `done <id> "note"` | `commands/done.mjs` | yes | yes |
| `release <id>` | `commands/release.mjs` | yes | yes |
| `reopen <id> "reason"` | `commands/reopen.mjs` | yes | yes (orchestrator or original done_by) |
| `archive <id> "reason"` | `commands/archive.mjs` | yes | yes (in_progress: claimer or orchestrator/recovery; ready/blocked: any agent) |
| `block <id> "reason"` | `commands/block.mjs` | yes | yes (must be the claimer) |
| `decide <D> "<choice>" --because "..."` | `commands/decide.mjs` | yes | optional (defaults to `orchestrator`) |
| `update <id> [--title X] [--body "..."] [--skills a,b] [--depends-on A,B] ...` | `commands/update.mjs` | yes | required (any value; no ownership check) |
| `add-note <id> "text"` | `commands/add-note.mjs` | yes | required (any value) |
| `close-gotcha <id>` | `commands/close-gotcha.mjs` | yes | required |
| `reopen-gotcha <id>` | `commands/reopen-gotcha.mjs` | yes | required |
| `tasks [--initiative X] [--status Y]` | `commands/tasks.mjs` | no | no |
| `graph [--initiative X]` | `commands/graph.mjs` | no | no |
| `next-id <phase>` | `commands/next-id.mjs` | no | no |
| `gotchas [--initiative X] [--domain Y]` | `commands/gotchas.mjs` | no | no |
| `decisions [--initiative X]` | `commands/decisions.mjs` | no | no |
| `initiatives` | `commands/initiatives.mjs` | no | no |
| `log [--limit N] [--action X] [--agent X] [--task X] [--decision X]` | `commands/log.mjs` | no | no |
| `show <id>` | `commands/show.mjs` | no | no |
| `add-task <id> --initiative X --title "..." [--depends-on A,B] ...` | `commands/add-task.mjs` | yes | no |
| `promote <id>` | `commands/promote.mjs` | yes | yes |

`add-task` also accepts `--phase <prefix>` instead of the positional id; the CLI auto-allocates the next free id for that phase (e.g. `--phase F1` on a state with `F1.T1`, `F1.T2` creates `F1.T3`). Policy: next sequential, not fill-the-gap. See `commands/next-id.mjs` for the same logic exposed as a read-only command.

`add-task --phase` and `next-id` also accept `--suffix <S>` to append a tag at the end of the generated id (e.g. `--phase F1 --suffix R` → `F1.T1R`, then `F1.T2R`, etc.). The default-family (`F1.T1`, `F1.T2`, ...) and the R family are independent sequences. `.OPEN` placeholders are still skipped. `--suffix` requires `--phase`; the suffix must be a non-empty string without a dot and not equal to `OPEN`.
| `add-initiative <name> [--desc "..."]` | `commands/add-initiative.mjs` | yes | no |
| `add-decision <id> --title "..." [--initiative X] [--applies-to F1,T2,...]` | `commands/add-decision.mjs` | yes | no |
| `add-gotcha <id> --title "..." --applies-to domain:x[,T1,...] [--initiative X] [--mitigation "..."]` | `commands/add-gotcha.mjs` | yes | no |

## Hard rules for contributing

1. **No new runtime dependencies.** Stdlib only. If you think you need a package, you almost certainly don't.
2. **TDD strict.** Write the failing test first, then make it pass. The test suite is the spec.
3. **No silent failures.** Every error path either throws with a clear message or has a tested behavior. If you find yourself "handling" an error by logging and continuing, write a test that documents the behavior, or change the code to fail loud.
4. **Schema validation on write.** `writeState` rejects states missing `tasks`/`decisions`/`gotchas`/`initiatives`/`log`. Don't relax this without a test that says why.
5. **Versioning.** The state has `version: 1`. If you change the shape, bump it and add a migration in `readState` (or document the break). Don't silently accept unknown future versions.
6. **Multi-agent safety.** Any new mutation must go through `withLock`. Any new "log" must be inside the same `withLock` block as the state change it describes. If you split them, a concurrent op can interleave and the log will lie.
7. **The orchestrator/recovery escape hatch.** `release --as orchestrator` (or `--as recovery`) can free any agent's claim. This is a feature, not a bug. Don't remove it. But `block` does NOT have this escape hatch — only the claimer can block. Don't add one.
8. **No boolean flags before the command.** The CLI parser treats `--force init` as `--force=init`. New boolean flags must be used as `--flag=true` or after the command. Document any new boolean flag with this caveat.
9. **English only in code, but the CLI output tolerates any UTF-8.** Task titles, notes, and gotcha text can be in any language. Don't filter or escape based on locale.

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

- **New task status** (beyond `done`/`archived`/`in_progress`): add to the persisted set AND update `derive` to handle it. Don't treat unknown statuses as "ready" without thinking — `derive` currently passes through unknown statuses (treating them as candidates) for forward compat. If you want stricter behavior, add a test that locks down the policy.
- **New decision-like node** (e.g. "milestone"): the current model is one collection per node type. Adding a new collection means changes in `state.mjs`, `dag.mjs`, and the affected command outputs. Document it.
- **Cross-initiative dependencies**: already supported via `depends_on` ids. The `--initiative` filter is for views only, not for resolution.

## Conventions in the code

- **Async everywhere.** All commands are `async` and use `await` for I/O.
- **No `try`/`catch` around `await` for control flow.** Let errors propagate. The CLI entry catches and formats them.
- **Error messages start with the command name.** `"claim: task T1 is not ready"` not `"Task T1 is not ready"`. This makes logs grep-able.
- **Positional args for things, flags for options.** `climier claim T1 --as alice` not `--id T1 --agent alice`.
- **CSV in flag values.** `--skills "ts,sql"` not `--skill ts --skill sql`. Trim and filter empty strings.
- **Pure functions in `dag.mjs`, `gotchas.mjs`.** No I/O, no side effects. Test them with literal state objects, no temp dirs.
- **Imperative wrappers in `state.mjs` and `lock.mjs`.** These touch the filesystem. They are tested via `helpers.mjs` (temp dirs).
- **Commands return data, not console.log.** `bin/climier.mjs` is the only place that prints (except for errors).

## Testing

- `npm test` runs all `test/*.test.mjs` files.
- `npm run test:concurrent` runs the multi-agent race tests in isolation.
- Each test uses a temp dir (see `helpers.mjs`) so tests don't interfere.
- `importFresh()` re-imports modules fresh between tests (defeats the module cache); use it when you need clean state.
- For CLI end-to-end tests, use `runCli(args, { cwd })` which spawns the real `bin/climier.mjs`.
- For unit tests of `dag.mjs` or `gotchas.mjs`, use `importFresh("../src/dag.mjs")` and pass literal state objects — no filesystem needed.

### Test file naming

- `test/<module>.test.mjs` for unit tests of a module.
- `test/<feature>.test.mjs` for behavior tests that cross modules.
- `test/deep-holes-N.test.mjs` for regression tests on bugs found in audit rounds.

When you fix a bug, write a test that reproduces it BEFORE the fix. The test goes in `bugs.test.mjs` (real bugs) or `coverage-gaps.test.mjs` (missing tests for known behaviors) or a new `deep-holes-N.test.mjs` (deeper audit rounds).

## Non-obvious things that bit us

- **`release` and `block` are not symmetric.** `release` has an escape hatch (`--as orchestrator`); `block` does not. By design. `reopen` follows the same pattern as `release`: orchestrator (or recovery) can reopen any `done` task; the original `done_by` can self-reopen.
- **`tasks --status DONE` (uppercase) works.** Case-insensitive. `tasks --status ""` lists everything (empty string is falsy → no filter).
- **`status --staleMs 0` marks all in_progress as stale.** `staleMs: 0` is valid and means "everything in_progress is stale".
- **`init --force` auto-recovers a corrupt state file** even without `--force`, but `--force` is still needed to overwrite a *valid* state.
- **`add-task --depends-on NONEXISTENT` fails** with a clear error. The validator only runs when the state file exists (so empty projects can still bootstrap).
- **The state file is owned by the script.** `writeState` validates the schema. Don't write to the file from outside the CLI — even tests should go through `updateState`/`writeState` (or write valid schemas).
- **`derive` returns `blocked: []` and `ready: []` for an empty state, never throws.** New code that uses `derive` should preserve this.

## Working with the project

```bash
# Run all tests
npm test

# Run a single test file
node --test test/dag.test.mjs

# Run a single test by name
node --test --test-name-pattern="claim.*same agent" test/claim.test.mjs

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
| Validation / runtime error | `{ "ok": false, "error": "<message>" }` | empty | 1 |
| Unknown command / no command | `{ "ok": false, "error": "<message>" }` | empty | 2 |
| `--help` / `-h` / `help` | plain text help (the only text output) | empty | 0 |

The convention for command return shapes is principled:
- **Read commands** (`status`, `ready`, `tasks`, `graph`, `gotchas`, `decisions`, `log`, `next`, `show`, `pre-claim`) return raw data — the object/array the consumer cares about.
  - `status` and `pre-claim` are deliberately richer than the other reads: the agent is the primary consumer, so the output is shaped to remove ambiguity. `status` adds `summary.text` (one-line plain English), `summary.{ready,in_progress,blocked,backlog,placeholders,stale,open_decisions,done,archived}` (totals), and `alerts[]` (kinds: `decision-gate`, `stale-claim`). `blocked` and `open_decisions` are arrays of objects, not bare IDs. `ready` carries `skills/effort/domain/phase/gotcha_count`. `pre-claim` adds `depends_on_detail[]` (kind/status/title/claimed_by per dep). Placeholders (`.OPEN` suffix or `task.placeholder: true`) are marked in `blocked` with `placeholder: true` and counted separately in `summary.placeholders` so the agent doesn't conflate them with real blocked work.
- **Write commands** (`claim`, `done`, `release`, `reopen`, `block`, `decide`, `add-*`) return `{ entity }` envelopes (`{ task }`, `{ decision }`, `{ gotcha }`, `{ initiative }`).
- `init` returns `{ ok, seeded, file }` (different shape because it is not creating an entity, it is setting up a state).
- `show` returns `{ type, node }` because it can return any of three node types.

When you add a new command, pick whichever shape fits the data. **Do not** add a new envelope unless the data demands it. Do not add text-mode output.

## What to do if you don't know where to start

1. Run `npm test`. If anything is red, fix it first (a new agent should never commit on top of red).
2. Read `src/dag.mjs` — it's 50 lines and explains the core model.
3. Read one command end-to-end (`commands/claim.mjs` is the most representative).
4. Look at `test/concurrent-claims.test.mjs` — it shows the multi-agent guarantee in action.
5. Then tackle your task. TDD: write the test, watch it fail, implement, watch it pass.
