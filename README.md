# climier

JSON-first task DAG CLI for coordinating work across agents, sessions, or humans.

`climier` keeps one shared source of truth for what is **ready**, **claimed**, **blocked**, **decided**, **backlog**, **done**, or **archived**. It works just as well for one person across multiple AI sessions as it does for a full orchestrator-and-workers setup.

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
- **decisions** are DAG nodes too, so open choices can block work
- **gotchas** attach reusable domain knowledge to tasks or domains
- **claims** are atomic, so two claimants cannot take the same task
- every mutation lands in an append-only audit log

## What climier is

At heart, `climier` is a small state machine around a project DAG:

- create tasks, decisions, gotchas, and initiatives
- derive what is ready or blocked from dependencies
- claim work safely
- record decisions that unblock dependents
- keep backlog separate from claimable work
- recover from stale or wrong state with `release`, `reopen`, and `archive`

It is a CLI, JSON-first, stdlib-only, and meant to be scriptable.

## Good use cases

### 1. One agent, many sessions

You are working solo, but not from one continuous thread. Maybe you bounce between terminal sessions, AI chats, and worktrees. `climier` keeps the active task, blockers, and next-ready work outside the conversation that created it.

### 2. One human + one or more AI agents

Use `climier` as the contract between you and coding agents. You decide what enters the DAG, agents claim tasks, add notes, finish work, or block with reasons.

### 3. Orchestrator + workers

This is the classic multi-agent case: one coordinator delegates from `ready`, workers `claim -> next -> work -> done`, and the coordinator closes decisions or performs recovery.

### 4. Migrations and long-running refactors

When work unfolds in phases, with decision gates and domain gotchas, a DAG beats a flat checklist. `climier` keeps the dependency shape visible and the audit trail intact.

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

A minimal solo flow:

```bash
# 1. Initialize the project in the current directory
climier init

# 2. Register an initiative
climier add-initiative migration --desc "Move the API to the new stack"

# 3. Add a first task
climier add-task F0.T1 \
  --initiative migration \
  --title "Create API skeleton" \
  --definition "Create the new service with a /health endpoint" \
  --acceptance "Service starts locally and GET /health returns 200"

# 4. See what is ready
climier ready

# 5. Pre-flight + claim from this session
climier pre-claim F0.T1
climier claim F0.T1 --as session-api
climier next F0.T1

# 6. Finish the work
climier done F0.T1 "Scaffolded service and added /health" --as session-api
```

Built-in seed:

```bash
climier init --seed migration
```

That creates an example migration DAG with tasks, decisions, and gotchas.

## Core concepts

- **Task** — a unit of work. Persisted statuses: `in_progress`, `done`, `archived`. Derived statuses: `ready`, `blocked`, `backlog`.
- **Decision** — a DAG node with `status: open | decided`. Tasks depending on an open decision stay blocked.
- **Gotcha** — reusable domain knowledge attached to a domain or a specific task id.
- **Backlog task** — a real task intentionally kept out of the ready pool until promoted.
- **Initiative** — a tag grouping work streams such as `migration`, `auth`, or `research`.

Important invariant: `ready` and `blocked` are derived from dependencies. They are not written into the state file.

## Common workflow patterns

### Solo / multi-session flow

```bash
climier status
climier ready
climier pre-claim F1.T2
climier claim F1.T2 --as chatgpt-session-3
climier next F1.T2
# do the work
climier done F1.T2 "Implemented endpoint and added smoke test" --as chatgpt-session-3
```

### Human + AI flow

```bash
climier add-task F1.T3 \
  --initiative migration \
  --title "Move auth middleware" \
  --depends-on F1.T2,D1

climier pre-claim F1.T3
climier claim F1.T3 --as claude-auth
climier add-note F1.T3 "Need confirmation about token shape" --as claude-auth
climier block F1.T3 "Waiting on auth decision" --as claude-auth
climier decide D1 "Keep JWT shape stable" --because "Avoids client breakage"
climier release F1.T3 --as recovery
```

### Orchestrator + workers flow

This is a **use case**, not the definition of the tool.

```bash
climier status
climier ready
climier decisions
climier claim F1.T2 --as worker-api
climier done F1.T2 "Implemented endpoint and verified staging smoke test" --as worker-api
climier decide D4 "Keep Supabase JWT for now" --because "Fastest migration path; revisit later"
climier release F2.T3 --as orchestrator
climier reopen F1.T2 "Acceptance missed the timeout case" --as orchestrator
```

## How state is stored

New projects use two locations:

- `<project>/.climier.json` — stable project metadata kept in the repo
- `~/.climier/projects/<project-id>/tasks.json` — live mutable state

You can override `~/.climier` with `$CLIMIER_HOME`.

Legacy mode is still supported:

- `<project>/.agents/tasks/tasks.json`

If no `.climier.json` exists, `climier` falls back to the legacy repo-local file.

Why the split? New mode lets multiple worktrees, sessions, or agents share one lock and one live state file without committing operational noise to git.

## Output contract: JSON-only

Every command prints a single JSON value to stdout.

| Outcome | stdout | exit |
|---|---|---|
| Success | object or array with the command result | 0 |
| Error | `{ "ok": false, "error": "<message>" }` | 1 or 2 |
| `--help` / `help` | plain text help | 0 |
| `--version` / `version` | plain text version | 0 |

There is no `--json` flag. JSON is the default.

## Command reference

### Read-only

| Command | Purpose |
|---|---|
| `status [--initiative X] [--staleMs N]` | Full project view: summary, alerts, in-progress work, ready tasks, backlog, blocked tasks, open decisions, stale claims, gotchas. |
| `ready [--initiative X]` | Claimable-now tasks. Useful for any actor that wants the next safe unit of work. |
| `pre-claim <id> [--staleMs N]` | Read-only pre-flight: spec, gotchas, dependency detail, derived status, GO/NO-GO verdict. |
| `next <id>` | Task definition, acceptance criteria, and matching gotchas. |
| `tasks [--initiative X] [--status Y]` | List tasks with optional filters. |
| `graph [--initiative X]` | DAG view. |
| `gotchas [--initiative X] [--domain Y]` | List gotchas. |
| `decisions [--initiative X]` | List decisions and their blocking impact. |
| `initiatives` | List registered initiatives plus unregistered initiative values still present in nodes. |
| `log [--limit N] [--action X] [--agent X] [--task X] [--decision X]` | Audit log. |
| `show <id>` | Raw task, decision, or gotcha JSON. |
| `next-id <phase> [--suffix R]` | Preview the next sequential task id for a phase. |

### Mutating

| Command | Purpose |
|---|---|
| `claim <id> --as <agent>` | Atomically reserve a ready task. |
| `done <id> "note" --as <agent>` | Mark a claimed task complete. |
| `release <id> --as <agent>` | Free a claim without completing. `orchestrator` and `recovery` can release any claim. |
| `block <id> "reason" --as <agent>` | Mark the current claimed task blocked. Only the claim owner can do this. |
| `reopen <id> "reason" --as <agent>` | Roll a `done` task back to `in_progress`. `orchestrator` / `recovery` can reopen any done task; the original `done_by` can self-reopen. |
| `archive <id> "reason" --as <agent>` | Mark a task terminal without completing it. |
| `promote <id> --as <agent>` | Pull a backlog task into the normal DAG flow. |
| `decide <D> "choice" [--because "..."] [--as <agent>]` | Close an open decision and unblock dependents. Defaults to `orchestrator` if `--as` is omitted. |
| `update <id> ... --as <agent>` | Edit task fields such as title, body, definition, acceptance, skills, effort, domain, dependencies, backlog, or priority. |
| `add-note <id> "text" --as <agent>` | Append a note thread entry to a task. |
| `close-gotcha <id> --as <agent>` | Hide a resolved gotcha from normal views. |
| `reopen-gotcha <id> --as <agent>` | Re-open a resolved gotcha. |

### Add to the DAG

| Command | Purpose |
|---|---|
| `add-initiative <name> [--desc "..."]` | Register an initiative. |
| `add-task <id> --initiative X --title "..." [...]` | Add a task explicitly. |
| `add-task --phase F1 --initiative X --title "..." [--suffix R] [...]` | Auto-allocate the next sequential task id inside a phase. |
| `add-task ... [--backlog true] [--priority high\|medium\|low]` | Optionally create a task in backlog or assign a priority. |
| `add-decision <id> --title "..." [--initiative X] [--applies-to F1,T2,...] [--description "..."]` | Add a decision node. |
| `add-gotcha <id> --title "..." --applies-to domain:x[,T1,...] [--mitigation "..."]` | Add a gotcha. |

## Operational guarantees

### Claims are atomic

Mutating commands run under a file lock. Two sessions or agents racing to claim the same task cannot both win.

### Logging is part of the mutation

The state change and the audit-log entry happen under the same lock. That keeps the log truthful under concurrent use.

### Cycles and unknown dependencies do not crash the DAG

A cycle or an unknown dependency keeps a task blocked. The CLI stays defensive.

## Troubleshooting

### `claim: task X is not ready`

The task is blocked, already claimed, in backlog, or gated by a decision. Run:

```bash
climier pre-claim <id>
climier status
```

### A stale claim is blocking progress

```bash
climier release <id> --as orchestrator
```

### A task was marked done but should not have been

```bash
climier reopen <id> "reason" --as orchestrator
```

### A task should exist, but not yet be claimable

Create it in backlog, then promote it later:

```bash
climier add-task F3.T4 --initiative migration --title "Cut over traffic" --backlog true
climier promote F3.T4 --as orchestrator
```

### `update` fails on `in_progress` or `done`

That is by design. The spec is frozen while a task is actively owned or after it becomes the audit-of-record. Use `add-note`, `release`, or `reopen` instead.

### Stale lock file

`climier` does **not** auto-clear stale lock files in v1. That is deliberate: age-based lock stealing can let two writers enter at once if a legitimate operation runs long.

If a process died and left `.lock` behind, inspect the active state directory and remove the stale file manually before retrying.

In new mode the lock lives next to the live state file:

```bash
$CLIMIER_HOME/projects/<project-id>/.lock
# default CLIMIER_HOME is ~/.climier
```

In legacy mode it lives here:

```bash
<project>/.agents/tasks/.lock
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
