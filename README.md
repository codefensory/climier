# climier

JSON-first task DAG CLI for coordinating work across agents, sessions, or humans.

`climier` keeps one shared source of truth for what is **ready**, **blocked**, **in_progress**, **submitted**, **backlog**, **done**, **canceled**, **resolved**, or **deprecated**. It works just as well for one person across multiple AI sessions as it does for a full orchestrator-and-workers setup.

If your work has dependencies, decision gates, recovery needs, or parallel actors touching the same repo, `climier` gives that state a home.

## Why it exists

Ad-hoc coordination breaks fast:

- a task looks ready but is still blocked by a hidden dependency
- the active task lives in chat, not in the system of record
- a research choice never makes it back into the project state
- one stale claim blocks downstream work
- parallel sessions step on each other
- TODOs, notes, and status drift apart

`climier` fixes that by storing the workflow state itself:

- **tasks** form a DAG
- **gates** are DAG nodes too, so open choices (decisions, approvals, external deps, research) can block work
- **knowledge** holds reusable facts scoped to domains, initiatives, tags, or specific nodes
- **take** is atomic: two agents racing for the same task cannot both win
- every mutation lands in an append-only audit log

## What climier is

At heart, `climier` is a small state machine around a project DAG:

- create tasks, gates, knowledge, and initiatives
- derive what is ready or blocked from dependencies
- take one task at a time, atomically
- submit task implementations and accept them after validation, so only accepted work unblocks dependents
- keep backlog separate from claimable work
- recover from stale or wrong state with `release`, `reopen`, and `cancel`

It is a CLI, JSON-first, stdlib-only, and meant to be scriptable.

## Good use cases

### 1. One agent, many sessions

You are working solo, but not from one continuous thread. Maybe you bounce between terminal sessions, AI chats, and worktrees. `climier` keeps the active task, blockers, and next-ready work outside the conversation that created it.

### 2. One human + one or more AI agents

Use `climier` as the contract between you and coding agents. Workers take tasks, add evidence and submit them; validators accept or reject them; agents escalate when stuck.

### 3. Orchestrator + workers

This is the classic multi-agent case: one coordinator delegates from `ready`, workers `take -> work -> submit`, and independent validators `accept` or `reject` before dependents proceed.

### 4. Migrations and long-running refactors

When work unfolds in phases, with decision gates and scoped knowledge, a DAG beats a flat checklist. `climier` keeps the dependency shape visible and the audit trail intact.

### 5. Shared project state across worktrees or machines

Because repo metadata is separate from live mutable state, multiple worktrees or sessions can point at the same project state without committing operational noise to git.

## Install

Requires Node 20+.

```bash
npm install -g climier
climier --version
```

Or run without a global install:

```bash
npx climier --help
```

From this repo during development:

```bash
node bin/climier.mjs --help
```

## Quickstart

A minimal flow:

```bash
# 1. Initialize the project in the current directory
climier init

# 2. Register an initiative
climier add-initiative migration --desc "Move the API to the new stack" --as orchestrator

# 3. Add a first task (requires --body, --acceptance and --blocked-by)
climier add-task T-mvp-1 \
  --initiative migration \
  --title "Create API skeleton" \
  --body "Create the new service with a /health endpoint" \
  --acceptance "Service starts locally and GET /health returns 200" \
  --blocked-by "" \
  --as orchestrator

# 4. See what is ready
climier status

# 5. Pre-flight + take from this session
climier context T-mvp-1
climier take T-mvp-1 --as session-api

# 6. Submit implementation evidence; a validator accepts it after review
climier submit T-mvp-1 --note "Scaffolded service and added /health" --as session-api
climier accept T-mvp-1 --as validator-api
```

> Full reference: `docs/reference.md`.

## Core concepts

- **Task** — a unit of work (`subkind: "task"`). Persisted statuses: `open`, `in_progress`, `submitted`, `done`, `canceled`. `submitted` waits for validation; `done` means accepted. Derived statuses: `ready`, `blocked`, `backlog`.
- **Gate** — a resolvable node (`subkind: "gate"`, purpose `decision|approval|external-dependency|research`) that can block tasks via a `BLOCKS` edge until it is resolved.
- **Knowledge** — a durable fact attached to a domain, initiative, tag, or specific node id (`kind: "knowledge"`).
- **Backlog task** — a real task intentionally kept out of the ready pool until it is edited back into the DAG via `update --backlog false`.
- **Initiative** — a tag grouping work streams such as `migration`, `auth`, or `research`.

Important invariants: `ready` and `blocked` are derived from dependencies and are not written into the state file. Only task blockers in `done` or `archived` are satisfied; `submitted` never unblocks work.

## Common workflow patterns

### Solo / multi-session flow

```bash
climier status
climier context T-auth-7
climier take T-auth-7 --as chatgpt-session-3
# do the work
climier submit T-auth-7 --note "Implemented endpoint and added smoke test" --as chatgpt-session-3
# independent validator review
climier accept T-auth-7 --as validator-auth
```

### Human + AI flow

```bash
climier add-task T-auth-8 \
  --initiative migration \
  --title "Move auth middleware" \
  --body "Move middleware from service A to service B." \
  --acceptance "Same contract; staging smoke green." \
  --blocked-by T-auth-7,G-auth-1

climier context T-auth-8
climier take T-auth-8 --as claude-auth
climier add-note T-auth-8 "Need confirmation about token shape" --as claude-auth
climier release T-auth-8 --as claude-auth
climier resolve G-auth-1 --choice "Keep JWT shape stable" --rationale "Avoids client breakage" --as orchestrator
```

### Orchestrator + workers flow

This is a **use case**, not the definition of the tool.

```bash
climier status
climier context T-auth-7
climier take T-auth-7 --as worker-api
# ...worker ships...
climier submit T-auth-7 --note "Implemented endpoint and verified staging smoke" --as worker-api
# validator merges/reviews, then accepts or rejects the same task
climier accept T-auth-7 --as validator-api
climier resolve G-auth-2 --choice "Keep Supabase JWT for now" --rationale "Fastest migration path; revisit later" --as orchestrator
climier release T-auth-9 --as orchestrator
climier reopen T-auth-7 --reason "Acceptance missed the timeout case" --as orchestrator
```

## How state is stored

New projects use two locations:

- `<project>/.climier.json` — stable project metadata kept in the repo
- `~/.climier/projects/<project-id>/tasks.json` — live mutable state

You can override `~/.climier` with `$CLIMIER_HOME`.

Why the split? It lets multiple worktrees, sessions, or agents share one lock and one live state file without committing operational noise to git.

## Output contract: JSON-only

Every command prints a single JSON value to stdout.

| Outcome | stdout | exit |
|---|---|---|
| Success | object or array with the command result | 0 |
| Domain, storage, or internal failure | `{ "ok": false, "error": { "code": "...", "message": "...", "details": {} } }` | 1 |
| Unknown command or no command | `{ "ok": false, "error": "<message>" }` | 2 |
| `--help` / `help` | plain text help | 0 |
| `--version` / `version` | plain text version | 0 |

Errors are written to stdout, never stderr. Error codes are the stable API;
callers must branch on `error.code`, not on message text. Domain conflicts keep
their domain code (`ID_CONFLICT`, `CYCLE_DETECTED`, `STATE_REVISION_CONFLICT`,
`BATCH_OPERATION_FAILED`, and so on). Storage failures are normalized to
`STORAGE_ERROR` with the original cause in `details.cause`; opaque failures use
`CLI_INTERNAL_ERROR`. Command routing keeps exit 2 for compatibility. There is
no `--json` flag. JSON is the default.

## Command reference

`init` creates a `version: 3` state with `{ initiatives, nodes, edges, log }`. Compatible v2 states are normalized to v3 on read/write. The creation flow uses `add-task`, `add-gate`, and `add-knowledge`; `add-node` and `add-edge` are low-level escape hatches.

Projects coming from a v1 (`version: 1`) state fail with `STATE_V1_UNSUPPORTED` on first read; the error's `details.migration_steps` walks through backing up, exporting, and recreating the project. The hint suggests `climier init --force` after backup.

Full reference: `docs/reference.md`.

Canonical `BLOCKS` direction is `{ from: blocker, to: blocked, type: "BLOCKS" }`; blockers are incoming edges to the blocked node.

### Read-only

| Command | Purpose |
|---|---|
| `status [--initiative X] [--kind task\|gate\|knowledge] [--status X] [--domain X] [--claimed-by X] [--stale-ms N] [--limit N] [--all]` | Full project view: summary, alerts, in-progress work, ready tasks, backlog, blocked tasks, open gates, knowledge counts, stale claims. `in_progress` is global by default (every in_progress task is listed and counted regardless of caller); use `--claimed-by <agent>` to narrow to one agent's claims. `--as` is an identity tag for `context` and is intentionally not a filter for `status`. |
| `context <id>` | Agent-first view of a node: spec, blockers, informing edges, scoped knowledge, allowed actions. |
| `search "<query>" [--all]` | Case-insensitive substring search over active knowledge; `--all` includes deprecated knowledge. |
| `history <id> [--limit N]` | Log entries that reference a node. |
| `show <id>` | Raw node JSON. |
| `initiatives` | List registered initiatives plus unregistered initiative values still present in nodes. |
| `log [--limit N] [--action X] [--agent X] [--task X] [--decision X]` | Audit log. |
| `snapshots` | List recoverable snapshots captured under `<state-dir>/snapshots/`, newest first. Each entry carries `id`, `created_at`, `reason` (`force-init`, `corrupt-recovery`, `pre-restore`), `bytes`, and `sha256`. Only complete pairs (raw + metadata) appear; orphans are excluded. |
| `ui [--port N] [--open=true\|false]` | Start the local read-only web UI (board, node context, activity) and open it in the browser. Requires the `ui/` subproject deps (`npm install` in `ui/` once); the UI assets are built on demand. The server reads the live state with the CLI's own derivation functions; the browser never touches `tasks.json`. |

### Mutating

| Command | Purpose |
|---|---|
| `init [--force]` | Create `.climier.json` and the project's live state. |
| `take <id> --as <agent>` | Idempotently claim the explicit ready task; the id is required. |
| `submit <id> --note "..." --as <agent>` | Submit an `in_progress` task for validation; clears its implementation claim and never unblocks dependents. |
| `accept <id> --as <agent>` | Accept a `submitted` task as `done`; this transition can unblock dependents. |
| `reject <id> --reason "..." --as <agent>` | Return a `submitted` task to `open` with an audit reason. |
| `release <id> --as <agent>` | Free an `in_progress` implementation claim. Policy may constrain who can perform the transition. |
| `resolve <id> --choice "<text>" --rationale "<text>" --as <agent>` | Resolve an open gate. `resolve` is not a task lifecycle command; workers submit tasks and validators accept or reject them. |
| `reopen <id> --reason "<text>" --as <agent>` | Roll a `done` task back to `open` for correction, subject to policy. |
| `restore <snapshot-id> --as orchestrator\|recovery` | Replace the live state with a validated v2/v3 snapshot, normalizing v2 to v3, under the same lock and with a `pre-restore` snapshot. Authority is restricted to `orchestrator` or `recovery`. Invalid, v1, future-version or incomplete snapshots fail without mutating state. |
| `cancel <id> --reason "<text>" --as <agent>` | Terminate a task without resolving from `open`, `in_progress` or `submitted`. |
| `deprecate-knowledge <id> --reason "<text>" --as <agent>` | Soft-delete a knowledge node (`status="deprecated"`). |
| `update <id> ... --as <agent>` | Edit node fields such as title, body, definition, acceptance, domain, backlog, tags, or refs. |
| `add-note <id> "<text>" --as <agent>` | Append a note thread entry to any node. |

For `take`, claims are serialized under the project lock; takeover behavior is subject to policy.

### Add to the DAG

| Command | Purpose |
|---|---|
| `add-initiative <name> [--desc "..."]` | Register an initiative. |
| `add-task [id] --initiative X --title "..." --body "..." --acceptance "..." --blocked-by A,B [--backlog true] --as <agent>` | Append a task. The id is auto-allocated as `T-xxxxxxxx` when omitted. |
| `add-gate [id] --initiative X --title "..." --body "..." --purpose decision\|approval\|external-dependency\|research [--supersedes OLD] --as <agent>` | Append a gate. `--supersedes` atomically replaces an existing gate and rewires downstream `BLOCKS` edges. |
| `add-knowledge [id] --initiative X --title "..." --body "..." --scope-domains X [--scope-initiatives X] [--scope-tags X] [--scope-node-ids X] [--supersedes OLD] --as <agent>` | Append scoped knowledge; any `--scope-*` flag satisfies the scope requirement. `--supersedes` atomically replaces existing knowledge. |
| `add-node <id> --kind resolvable\|knowledge --title "..." [--subkind task\|gate] [--blocked-by A,B] [--derived-from A,B] [--refs a,b] [--meta '{...}']` | Low-level node creation (prefer `add-task` / `add-gate` / `add-knowledge`). |
| `add-edge <from> <to> --type BLOCKS\|SUPERSEDES\|DERIVED_FROM` | Low-level edge creation. |

## Operational guarantees

### Claims are atomic

Mutating commands run under a file lock. Two sessions or agents racing to claim the same task cannot both win.

### Logging is part of the mutation

The state change and the audit-log entry happen under the same lock. That keeps the log truthful under concurrent use.

### Cycles and unknown dependencies do not crash the DAG

A cycle or an unknown dependency keeps a task blocked. The CLI stays defensive.

## Troubleshooting

### `take: node X is not ready` (`NOT_READY`)

The task is blocked, already claimed, in backlog, or gated by an open gate. Run:

```bash
climier context <id>
climier status
```

### A stale claim is blocking progress

```bash
climier release <id> --as orchestrator
```

### A task was marked done but should not have been

```bash
climier reopen <id> --reason "..." --as orchestrator
```

### A task should exist, but not yet be claimable

Create it in backlog, then take it later when it is no longer blocked:

```bash
climier add-task T-cutover-1 --initiative migration --title "Cut over traffic" --body "..." --acceptance "..." --blocked-by "" --backlog true --as orchestrator
# later, when blockers are clear:
climier take T-cutover-1 --as orchestrator
```

### `update` fails on `in_progress`, `submitted`, or `done`

That is by design. The spec is frozen while a task is actively owned, awaiting validation, or after it becomes the audit-of-record. Use `add-note`, `release`, or `reopen` instead.

### Stale lock file

`climier` does **not** auto-clear stale lock files. That is deliberate: age-based lock stealing can let two writers enter at once if a legitimate operation runs long.

If a process died and left `.lock` behind, inspect the active state directory and remove the stale file manually before retrying.

The lock lives next to the live state file:

```bash
$CLIMIER_HOME/projects/<project-id>/.lock
# default CLIMIER_HOME is ~/.climier
```

### Boolean flag caveat

Put boolean flags after the command, or pass them as `--flag=true`. Example:

```bash
climier init --force
# or
climier --project . init --force=true
```

## Release flow

Keep it manual until releasing becomes frequent:

1. update `CHANGELOG.md` under `## [Unreleased]`
2. bump `package.json` version
3. run the checks
4. move `Unreleased` notes into a dated release section
5. tag the release
6. publish when ready

Example:

```bash
npm test
npm run pack:check
npm version 1.0.0
npm pack --dry-run
# git tag vX.Y.Z if you did not use npm version
# npm publish
```

## License

MIT
