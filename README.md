# climier

JSON-first task DAG CLI for coordinating work across agents, sessions, or humans.

`climier` keeps one shared source of truth for what is **ready**, **blocked**, **in_progress**, **submitted**, **backlog**, **done**, **canceled**, **resolved**, or **deprecated**. It works for one person across multiple AI sessions and for coordinated multi-agent projects.

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
- **task lifecycle** is tracked through claims, submissions, acceptance, and audit history
- every mutation lands in an append-only audit log

## What climier is

At heart, `climier` is a small state machine around a project DAG:

- create tasks, gates, knowledge, and initiatives
- derive what is ready or blocked from dependencies
- track task ownership and lifecycle with `take`, `submit`, `accept`, and `reject`
- keep backlog separate from ready work
- correct or administer DAG state with explicit lifecycle commands

It is a CLI, JSON-first, stdlib-only, and meant to be scriptable.

## Good use cases

### 1. One agent, many sessions

You are working solo, but not from one continuous thread. Maybe you bounce between terminal sessions, AI chats, and worktrees. `climier` keeps the active task, blockers, and next-ready work outside the conversation that created it.

### 2. One human + one or more AI agents

Use `climier` to keep the shared work graph, task contracts, ownership, and review state visible across people and sessions.

### 3. Coordinated multi-agent projects

Several tasks can be represented in the DAG with real dependencies. Operators inspect `status` and `context`, resolve gates with Climier, and update task lifecycle state as work progresses.

### 4. Migrations and long-running refactors

When work unfolds in phases, with decision gates and scoped knowledge, a DAG beats a flat checklist. `climier` keeps the dependency shape visible and the audit trail intact.

### 5. Shared project state across worktrees or machines

Because repo metadata is separate from live mutable state, multiple worktrees or sessions can point at the same project state without committing operational noise to git.

## Install

Requires Node 20+, or Bun 1.3+ as an alternative runtime.

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
node bin/climier.ts --help
```

Bun remains available as an alternative by invoking it explicitly:

```bash
bun bin/climier.ts --help
```

## Agent skill

A portable [agent skill](https://skills.sh) for operating the climier DAG lives
in [`skills/climier/`](./skills/climier/). Install it for your coding agent with:

```bash
npx skills add codefensory/climier
```

In Pi, install it from a git source with `pi install git:<repo-url>` or link it
into `~/.agents/skills/`. Task execution is a separate skill
(`climier-flow`, sourced from the climier-flow repository), and the project-local
`spec-pipeline` skill (RFC → review → ADR) is intentionally not distributed: it
writes `.decisions/` and `.adrs/` and belongs to the repository that adopts it.

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

# 4. See what is ready and inspect the task contract
climier status
climier context T-mvp-1

# 5. Claim the task, then record its handoff for review when implementation is ready
climier take T-mvp-1 --as implementer
climier submit T-mvp-1 --note "Implementation complete; checks pass" --as implementer
# A reviewer records the outcome:
climier accept T-mvp-1 --as reviewer
```

> Full reference: `docs/reference.md`.

## Web UI

`ui/` is the standalone SolidJS + Vite + Tailwind frontend. Its dependencies stay in the UI subproject; the root CLI remains stdlib-only. The server serves the built SPA from `ui/dist`, and `climier ui` starts a local read-only loopback server without Express. The same bundle serves both: the local adapter answers the same `/v1` read contract (catalog, login, snapshot with `ETag`, nodes, activity, SSE) for every project in the local storage root, and the client falls back to the login gate only when the origin requires a bearer.

Build the reproducible UI bundle with Bun:

```bash
cd ui
bun install --frozen-lockfile
bun run typecheck
bun run build
```

The build writes `ui/dist/index.html` and hashed assets. `ui/dist` is included in the published package; generated `ui/node_modules`, `ui/dist`, Storybook output, and local harness output are ignored by git.

See [`docs/climier-ui.md`](docs/climier-ui.md) for the UI model, local server, and hosted API contract.

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
climier take T-auth-7 --as implementer
climier add-note T-auth-7 "Implementation in progress" --as implementer
climier submit T-auth-7 --note "Implementation complete; checks pass" --as implementer
```

### Human + AI flow

Curate the graph and record task lifecycle changes with Climier:

```bash
climier add-task T-auth-8 \
  --initiative migration \
  --title "Move auth middleware" \
  --body "Move middleware from service A to service B." \
  --acceptance "Same contract; staging smoke green." \
  --blocked-by T-auth-7,G-auth-1 --as orchestrator

climier context T-auth-8
climier add-note T-auth-8 "Need confirmation about token shape" --as claude-auth
climier resolve G-auth-1 --choice "Keep JWT shape stable" \
  --rationale "Avoids client breakage" --as orchestrator
climier take T-auth-8 --as claude-auth
climier submit T-auth-8 --note "Middleware moved; staging smoke passed" --as claude-auth
climier accept T-auth-8 --as reviewer
```

### Coordinated DAG flow

Several people or sessions can inspect the same DAG, claim ready tasks, and
record submissions and review outcomes. Use `reopen`, `release`, or `cancel`
for explicit administrative changes to the DAG.

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

`init` creates a canonical schema-1 state with `{ initiatives, nodes, edges, log }` plus the revision-ledger fields. Import existing projects first with `climier migrate --all --dry-run` and then `climier migrate --all`, while every writer is stopped; see [`docs/remote-server.md`](docs/remote-server.md) for the storage backup and recovery procedure. `init --force` is only a deliberate reset of a project, never an import mechanism. The creation flow uses `add-task`, `add-gate`, and `add-knowledge`; `add-node` and `add-edge` are low-level escape hatches.

Full reference: `docs/reference.md`.

### Remote v1

A remote checkout uses `backend: { type: "remote", url }` and the Remote v1 HTTP contract (`/v1` with `X-Climier-Protocol-Version: 1`). Run `climier link <origin>`, `climier login`, then `climier init` to provision its server-side project. Login reads the password from a TTY and stores the bearer in the local credential profile by origin. Linking does not upload an existing local DAG; use the explicit experimental `push`/`pull` commands for complete manual transfers. The server requires `CLIMIER_SERVER_PASSWORD`; the operator chooses the listener address, transport, and any TLS or private-network exposure. HTTP origins are accepted, but `login`, `link`, and remote `init` warn when credentials travel without transport encryption; pass `--no-warnings` to suppress those non-blocking warnings. HTTPS remains recommended, and normal requests never fall back to local state. See [`docs/remote-server.md`](docs/remote-server.md) for transfer workflows, rotation, backups, stale-lock recovery, and auth-file recovery.

### Manual offline transfers

`link` only selects a remote backend and preserves the checkout's `project_id`; it does not copy or merge state. `init` provisions an absent remote project but does not publish a local DAG. To publish existing local work, link and log in, provision the remote with `init`, then push:

```sh
climier link https://climier.example.test
climier login
climier init
climier push --as alice
```

To work offline, pull before selecting the local backend. Remove only the `backend` object from `.climier.json` (keep its `project_id`) to select local state; restore remote selection with `link` before transferring again:

```sh
climier login
climier pull --as alice
# Remove `backend` from .climier.json; keep project_id.
# Work with the local DAG while offline.
climier link https://climier.example.test
climier login
climier push --as alice
```

The transfer baseline is local machine state under `$CLIMIER_HOME/remote-transfer-baselines/` (default `~/.climier`), not repository metadata; changing or committing `.climier.json` selects a backend but does not move that baseline. Without a confirmed baseline, push accepts only a pristine initialized remote. Transfers require a valid Remote v1 login and never fall back to local state. There is no automatic sync, merge, retry, journal, or conflict resolution. A conflict requires an explicit choice of local or remote state.

`push --force` and `pull --force` are **EXPERIMENTAL / UNSAFE**: each replaces the complete destination DAG, including claims, `in_progress`, plugin data, and the destination log. The winner keeps its source log plus a new transfer event naming the replaced revision; the discarded destination log is not retained or recoverable from that event. Back up both sides before force. A timeout can be ambiguous: the server may have applied a transfer although the local baseline was not updated, so inspect or pull before deciding what to do next.

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
| `log [--limit N] [--action X] [--agent X] [--node X]` | Audit log. |
| `snapshots` | List recoverable snapshots captured under `<state-dir>/snapshots/`, newest first. Each entry carries `id`, `created_at`, `reason` (`force-init`, `corrupt-recovery`, `pre-restore`), `bytes`, and `sha256`. Only complete pairs (raw + metadata) appear; orphans are excluded. |
| `urls [--initiative X] [--id NODE] [--port N] [--origin URL]` | Print deep links to the web UI; local links are marked `local_only` and work while `climier ui` runs on this machine. |
| `ui [--port N] [--open=true\|false]` | Start the local read-only web UI (board, node context, activity) and open it in the browser. **Experimental**: it is a local subproject with separate dependencies and is excluded from the published tarball. If it is not installed, the command returns an actionable error. |

### Task lifecycle

Use the lifecycle commands to record ownership and review state:

1. `take <id> --as <agent>` claims a ready task.
2. `submit <id> --note "..." --as <agent>` records the handoff for review.
3. `accept <id> --as <agent>` marks submitted work done; `reject <id> --reason "..." --as <agent>` returns it to open.

Claims are serialized under the project lock. `release`, `reopen`, and
`cancel` are available for explicit administration.

### Mutating

| Command | Purpose |
|---|---|
| `init [--force]` | Create `.climier.json` and the project's live state. |
| `take <id> --as <agent>` | Claim a ready task. |
| `submit <id> --note "..." --as <agent>` | Submit owned work for review with an audit note. |
| `accept <id> --as <agent>` | Accept submitted work and transition it to `done`. |
| `reject <id> --reason "..." --as <agent>` | Return submitted work to `open` with a reason. |
| `release <id> --as <agent>` | Explicit administrative claim release. |
| `resolve <id> --choice "<text>" --rationale "<text>" --as <agent>` | Resolve an open gate. |
| `reopen <id> --reason "<text>" --as <agent>` | Roll a `done` task back to `open` for correction, subject to policy. |
| `restore <snapshot-id> --as <agent>` | Replace the live state with a validated schema-1 snapshot under the recovery path and a pre-restore snapshot. A policy plugin may restrict the actor; invalid or incomplete snapshots fail without mutating state. |
| `cancel <id> --reason "<text>" --as <agent>` | Terminate a task without resolving from `open`, `in_progress` or `submitted`. |
| `batch --file <json> --as <agent>` / `batch --stdin --as <agent>` | Execute several operations atomically. |
| `link <origin> [--replace=true]` | Select a Remote v1 origin while preserving the checkout project ID; does not copy a DAG. |
| `login [--server <origin>]` / `logout [--server <origin>]` | Authenticate through a TTY and manage the local bearer profile; the token is never printed. |
| `push --as <agent>` / `pull --as <agent>` | **EXPERIMENTAL / UNSAFE** complete manual DAG transfers. `--force` replaces the entire destination; back up first. |
| `migrate [--all] [--dry-run]` | Inspect or import pre-cut projects while all writers are stopped. |
| `deprecate-knowledge <id> --reason "<text>" --as <agent>` | Soft-delete a knowledge node (`status="deprecated"`). |
| `update <id> ... --as <agent>` | Edit node fields such as title, body, definition, acceptance, domain, backlog, tags, or refs. |
| `add-note <id> "<text>" --as <agent>` | Append a note thread entry to any node. |

Claims are serialized under the project lock, so two actors racing to take the same task cannot both win.

### Add to the DAG

| Command | Purpose |
|---|---|
| `add-initiative <name> [--desc "..."]` | Register an initiative. |
| `add-task [id] --initiative X --title "..." --body "..." --acceptance "..." --blocked-by A,B --as <agent>` | Append a task. The id is auto-allocated as `T-xxxxxxxx` when omitted. |
| `add-gate [id] --initiative X --title "..." --body "..." --purpose decision\|approval\|external-dependency\|research [--supersedes OLD] --as <agent>` | Append a gate. `--supersedes` atomically replaces an existing gate and rewires downstream `BLOCKS` edges. |
| `add-knowledge [id] --initiative X --title "..." --body "..." --scope-domains X [--scope-initiatives X] [--scope-tags X] [--scope-node-ids X] [--supersedes OLD] --as <agent>` | Append scoped knowledge; any `--scope-*` flag satisfies the scope requirement. `--supersedes` atomically replaces existing knowledge. |
| `add-node <id> --kind resolvable\|knowledge --title "..." [--subkind task\|gate] [--blocked-by A,B] [--derived-from A,B] [--refs a,b] [--meta '{...}']` | Low-level node creation (prefer `add-task` / `add-gate` / `add-knowledge`). |
| `add-edge <from> <to> --type BLOCKS\|SUPERSEDES\|DERIVED_FROM` | Low-level edge creation. |
| `remove-edge <from> <to> --type BLOCKS\|SUPERSEDES\|DERIVED_FROM` | Idempotently remove one exact edge. |
| `state` | Read the deterministic current core projection. |

## Operational guarantees

### Claims are atomic

Mutating commands run under a file lock. Two sessions or agents racing to claim the same task cannot both win.

### Logging is part of the mutation

The state change and the audit-log entry happen under the same lock. That keeps the log truthful under concurrent use.

### Cycles and unknown dependencies do not crash the DAG

A cycle or an unknown dependency keeps a task blocked. The CLI stays defensive.

## Troubleshooting

### A task is not ready (`NOT_READY`)

The task is blocked, already in progress, in backlog, or gated by an open gate. Inspect it with:

```bash
climier context <id>
climier status
```

### Additional work after a completed task

Create a new correction task that points to the accepted task, preserving the completed task as the audit-of-record:

```bash
climier add-task T-auth-7-correction \
  --initiative auth \
  --title "Correct the completed auth work" \
  --body "Describe the additional correction." \
  --acceptance "State the correction's acceptance criteria." \
  --blocked-by T-auth-7 \
  --as orchestrator
```

### A task is not ready yet

Create it, mark it as backlog, then claim it once it becomes ready:

```bash
climier add-task T-cutover-1 --initiative migration --title "Cut over traffic" --body "..." --acceptance "..." --blocked-by "" --as orchestrator
climier update T-cutover-1 --backlog true --as orchestrator
# later, when it is ready:
climier take T-cutover-1 --as implementer
```

### `update` fails on `in_progress`, `submitted`, or `done`

That is by design. The spec is frozen while a task is actively owned, awaiting validation, or after it becomes the audit-of-record. Use `add-note` or `release` for administration; create a separate correction task for additional work after acceptance.

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

# `--force` resets a project; it does not import an existing state.
```

## Release checklist

The v1.0.0 release is the first clean publication. The owner performs the
external tag and publish; the implementation chain leaves the repository ready
for those actions:

1. install or link the release binary and stop all writers, the UI, and the
   remote server;
2. review `climier migrate --all --dry-run`, then run `climier migrate --all`;
3. verify every project with `climier --project <checkout> status` and one
   authorized operation;
4. run `npm test`, `npm run surface:check`, `npm run lint:cut`,
   `npm run pack:check`, and `npm run smoke:pack`;
5. inspect `npm pack --dry-run` and confirm the CHANGELOG has one dated
   `[1.0.0]` section and an empty `[Unreleased]` section;
6. push the release commit and wait for CI on that exact commit: the matrix
   runs the test suite, the retired-surface check, the packed smoke, and the
   pack check on Node 20 and 24. A local green run does not substitute for it;
7. create tag `v1.0.0` on the commit CI verified and run `npm publish` only
   after the checks and the import rehearsal pass. `npm publish` needs an
   authenticated registry session; the tag and the publish are the release
   owner's actions.

The complete server shutdown, import, stale-lock recovery, and rollback
procedure is in [`docs/remote-server.md`](docs/remote-server.md).

## License

MIT
