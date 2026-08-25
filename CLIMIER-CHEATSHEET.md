# climier cheatsheet

Quick reference for agents working in this repository. State shape: `{ version: 2, initiatives, nodes, edges, log }` at `~/.climier/projects/<project_id>/tasks.json` (global, machine-local, NOT in the repo). The repo commits only `.climier.json`, which pins the `<project_id>`.

Errors are JSON to stdout with a structured shape: `{ ok: false, error: { code, message, details } }`. Branch on `error.code`, not `error.message`.

## Setup

- `climier init` — create the empty state file for this project (one-time per machine).
- `climier init --force` — full reset to empty state (after backing up).

## Orient / read

- `climier status` — summary + ready/in_progress/blocked/backlog task buckets + open gates + alerts. **in_progress is global by default** (every in_progress task is listed and counted regardless of caller); use `--claimed-by <agent>` to narrow to one agent's claims. `--as` is an identity tag for `context` and is intentionally not a filter for `status`.
- `climier status --all` — also dumps done / canceled / resolved / superseded / deprecated nodes.
- `climier status --initiative <name>` — narrow to one initiative.
- `climier status --kind task|gate|knowledge` — restrict buckets.
- `climier status --claimed-by <agent>` — narrow in_progress to one agent's claims (the only way to filter claims in `status`).
- `climier status --status in_progress` — same as the default in_progress view (any other `--status` value leaves the bucket empty).
- `climier status --stale-ms <N>` — change the stale threshold (default 2h).
- `climier context <id>` — agent-first view: node, derived_status, claim, blocking, knowledge, informing, alerts, allowed_actions.
- `climier context <id> --as <agent>` — scope `allowed_actions` to one agent.
- `climier show <id>` — raw node by id (`{ type, node }`).
- `climier history <id> [--limit N]` — log entries that reference a node.
- `climier search "<query>" [--all]` — search knowledge by id/title/body/mitigation/domain/tags/refs/meta. `--all` includes deprecated.
- `climier initiatives [--all]` — registered initiatives with usage counts.
- `climier log [--limit N] [--action X] [--agent X] [--task X] [--decision X]` — raw audit log.
- `climier snapshots` — list recoverable snapshots under `<state-dir>/snapshots/`, newest first. Each entry has `id`, `created_at`, `reason` (`force-init` / `corrupt-recovery` / `pre-restore`), `bytes`, and `sha256`. Only complete pairs (raw + metadata) appear.

## Worker loop (take → resolve)

- `climier take <id> --as <agent>` — idempotently claim a ready task. Sets `claim.by`, increments `revision`.
- `climier resolve <id> --note "<text>" --as <agent>` — close a task as done.
- `climier release <id> --as <agent>` — free the claim without resolving. Idempotent. `orchestrator` / `recovery` can release any agent's claim.
- `climier cancel <id> --reason "<text>" --as <agent>` — terminate a node (open/in_progress only). Claim owner or orchestrator/recovery.
- `climier reopen <id> --reason "<text>" --as <agent>` — roll a `done` task back to `open`. orchestrator/recovery, or original `done_by` for self-correction.
- `climier restore <snapshot-id> --as orchestrator|recovery` — replace the live state with a snapshot's raw bytes. Validates target v2 + required collections before any state change; takes a `pre-restore` snapshot of the current state under the same lock; restores via `tmp+rename`; appends `{ action: "restore", agent, snapshot_id }` to the restored log; returns `{ snapshot }`. Restricted to `orchestrator` / `recovery` — no per-agent restore. Targets that are absent, incomplete, corrupt, v1, future versions, or missing required collections fail with structured errors and leave state untouched.
- `climier add-note <id> "<text>" --as <agent>` — append a timestamped note (any status, append-only). Use for breadcrumb findings; also use `add-note "<id>" "blocked: ..."` for escalations.

## Spec edits

- `climier update <id> [--title X] [--body "..."] [--definition "..."] [--acceptance "..."] [--domain Y] [--tags a,b] [--refs a,b] [--meta '{...}'] [--backlog true|false] [--if-revision N] --as <agent>` — edit a node, bumps `revision`. Put extra context that doesn't fit a flag in `body`/`meta`.

## Add to the DAG

- `climier add-initiative <name> [--desc "..."] --as <agent>` — register an initiative. Duplicates are rejected with `ID_CONFLICT`.
- `climier add-task [id] --initiative X --title "..." --body "..." --acceptance "..." --blocked-by A,B --as <agent>` — add a task. `--body`, `--acceptance` and `--blocked-by` are required; pass `--blocked-by ""` when there are no blockers. Omit `id` to auto-allocate (`T-xxxxxxxx`).
- `climier add-gate [id] --initiative X --title "..." --body "..." --purpose decision|approval|external-dependency|research [--blocked-by A,B] [--supersedes OLD] --as <agent>` — add a gate (decision/approval/etc). `--supersedes OLD` rewires downstream BLOCKS edges atomically.
- `climier add-knowledge [id] --initiative X --title "..." --body "..." [--scope-domains X] [--scope-initiatives X] [--scope-tags X] [--scope-node-ids X] [--mitigation "..."] [--supersedes OLD] --as <agent>` — register a knowledge node. At least one `--scope-*` is required.
- `climier deprecate-knowledge <id> --reason "<text>" --as <agent>` — soft-delete a knowledge node.

## Escape hatches (low-level graph CRUD)

- `climier add-node <id> --kind resolvable|knowledge --title "..." [--subkind task|gate] [--blocked-by A,B] [--derived-from A,B] [--refs a,b] [--meta '{...}'] --initiative X ... --as <agent>` — low-level node creation. Prefer the wrappers above.
- `climier add-edge <from> <to> --type BLOCKS|SUPERSEDES|DERIVED_FROM --as <agent>` — low-level edge CRUD.

## Edge direction

CLI phrases edges from the dependent's POV: `--blocked-by G-y` means "this node is blocked by G-y". The canonical stored shape is `from: G-y, to: <this node>, type: BLOCKS` — **to is BLOCKED-BY from**. The CLI never asks for `--blocks`; only `--blocked-by`. `SUPERSEDES` and `DERIVED_FROM` keep the user-supplied direction.

## Authority matrix

| Command | Owner | orchestrator / recovery | Other |
|---|---|---|---|
| `take <ready>` | yes (idempotent) | yes (take over) | yes (if ready) |
| `resolve <task>` | yes (claim owner) | no (use `reopen` + reassign) | no |
| `release <task>` | yes | yes | no (`NOT_OWNER`) |
| `cancel <task>` | yes | yes | no |
| `reopen <done>` | yes (original `done_by`) | yes | no |
| `resolve <gate>` | n/a (gates aren't claimable) | yes | yes |
| `update` | any | any | any |
| `add-note` | any | any | any |
| `add-task` / `add-gate` / `add-knowledge` | n/a (creates new node) | any | any |
| `deprecate-knowledge` | n/a | any | any |
| `restore <snapshot>` | n/a | yes | no (`NOT_OWNER`) |

## Common error codes

- `NODE_NOT_FOUND` — id doesn't exist.
- `NOT_READY` — `take` on a node that isn't ready.
- `ALREADY_CLAIMED` — `take` on a node claimed by another agent.
- `NOT_OWNER` — `release` / `resolve` / `cancel` / `reopen` from a non-owner, non-orchestrator.
- `INVALID_STATUS` — transition not allowed from current status (e.g. `resolve` on an `open` task).
- `MISSING_FIELD` / `MISSING_AGENT` — required flag absent.
- `REVISION_CONFLICT` — `update --if-revision N` failed because the stored revision differs.
- `INITIATIVE_NOT_FOUND` — `--initiative` not registered; run `add-initiative` first.
- `ID_CONFLICT` — duplicate id on add (task / gate / knowledge / initiative).
- `INVALID_EDGE_TYPE` / `INVALID_EDGE_KIND` / `SELF_EDGE` / `CYCLE_DETECTED` / `DUPLICATE_EDGE` / `INVALID_EDGE_TARGET` — edge problems.

## One-liner: full cycle

```bash
# orient
climier status
# pick a task
id=$(climier status | jq -r '.tasks.ready[0].id')
# pre-flight
climier context "$id"
# claim
climier take "$id" --as my-agent
# ... do work ...
# close
climier resolve "$id" --note "what shipped, what was verified" --as my-agent
```

## One-liner: orchestrator

```bash
climier status              # orient
climier context <id>        # read candidate
climier resolve <G> --choice X --rationale Y --as orchestrator   # close a gate
climier release <id> --as orchestrator                           # free stuck claim
climier reopen <id> --reason "..." --as orchestrator              # roll back wrong resolve
```