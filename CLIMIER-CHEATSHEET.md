# climier cheatsheet

Quick reference for agents and operators working in this repository. State shape:
canonical schema-1 `{ version: 1, initiatives, nodes, edges, log, fence_generation, revision }`
at `~/.climier/projects/<project_id>/tasks.json` (global, machine-local, NOT in the
repo). The repo commits only `.climier.json`, which pins the `<project_id>`.
Remote v2 setup, TLS, backup, rotation, and recovery are in
`docs/remote-server.md`.

Errors are JSON to stdout with a structured shape:
`{ ok: false, error: { code, message, details } }`. Branch on `error.code`, not
`error.message`.

## Setup

- `climier init` — create the empty state file for this project (one-time per machine).
- `climier init --force` — full reset to empty state (after backing up); never use it to import an existing project.
- `climier migrate --all --dry-run` — inspect every pre-cut project without writing.
- `climier migrate --all` — import the project park after stopping all writers; verify each project before restart.

## Orient / read

- `climier status` — summary + ready/in_progress/blocked/backlog task buckets + open gates + alerts. `in_progress` is global by default; use `--claimed-by <agent>` to narrow claims.
- `climier status --all` — also dumps done / canceled / resolved / superseded / deprecated nodes.
- `climier status --initiative <name>` — narrow to one initiative.
- `climier status --kind task|gate|knowledge` — restrict buckets.
- `climier status --claimed-by <agent>` — narrow in_progress to one agent's claims.
- `climier status --status in_progress` — show in_progress work.
- `climier status --stale-ms <N>` — change the stale threshold (default 2h).
- `climier context <id>` — agent-first view: node, derived status, claim, blocking, knowledge, informing, alerts, allowed actions.
- `climier context <id> --as <agent>` — scope `allowed_actions` to one agent.
- `climier show <id>` — raw node by id (`{ type, node }`).
- `climier history <id> [--limit N]` — log entries that reference a node.
- `climier search "<query>" [--all]` — search knowledge by id/title/body/mitigation/domain/tags/refs/meta.
- `climier initiatives [--all]` — registered initiatives with usage counts.
- `climier log [--limit N] [--action X] [--agent X] [--node X]` — raw audit log.
- `climier snapshots` — list recoverable snapshots under `<state-dir>/snapshots/`.

## Task lifecycle

Use the task lifecycle commands to record ownership and review state:

```bash
climier context <task-id>
climier take <task-id> --as <agent>
climier submit <task-id> --note "Implementation complete" --as <agent>
climier accept <task-id> --as <reviewer>
```

Use `reject` to return submitted work to `open`. Use `reopen`, `release`, and
`cancel` for explicit DAG administration.

## Spec edits

- `climier update <id> [--title X] [--body "..."] [--definition "..."] [--acceptance "..."] [--domain Y] [--tags a,b] [--refs a,b] [--meta '{...}'] [--backlog true|false] [--if-revision N] --as <agent>` — edit a node and bump `revision`.

## Add to the DAG

- `climier add-initiative <name> [--desc "..."] --as <agent>` — register an initiative.
- `climier add-task [id] --initiative X --title "..." --body "..." --acceptance "..." --blocked-by A,B --as <agent>` — add a task. Pass `--blocked-by ""` when there are no blockers.
- `climier add-gate [id] --initiative X --title "..." --body "..." --purpose decision|approval|external-dependency|research [--blocked-by A,B] [--supersedes OLD] --as <agent>` — add a gate.
- `climier add-knowledge [id] --initiative X --title "..." --body "..." [--scope-domains X] [--scope-initiatives X] [--scope-tags X] [--scope-node-ids X] [--mitigation "..."] [--supersedes OLD] --as <agent>` — register scoped knowledge.
- `climier deprecate-knowledge <id> --reason "..." --as <agent>` — soft-delete knowledge.

## Escape hatches (low-level graph CRUD)

- `climier add-node <id> --kind resolvable|knowledge --title "..." [--subkind task|gate] [--blocked-by A,B] [--derived-from A,B] [--refs a,b] [--meta '{...}'] --initiative X ... --as <agent>` — low-level node creation. Prefer the wrappers above.
- `climier add-edge <from> <to> --type BLOCKS|SUPERSEDES|DERIVED_FROM --as <agent>` — low-level edge creation.
- `climier remove-edge <from> <to> --type BLOCKS|SUPERSEDES|DERIVED_FROM --as <agent>` — remove one exact edge.

## Edge direction

CLI phrases edges from the dependent's point of view: `--blocked-by G-y` means
"this node is blocked by G-y". The canonical stored shape is
`from: G-y, to: <this node>, type: BLOCKS` — **to is BLOCKED-BY from**.
`SUPERSEDES` and `DERIVED_FROM` keep the user-supplied direction.

## Task lifecycle reference

| Operation | State effect |
|---|---|
| `take` | Claim a ready task |
| `submit` | Hand owned work off for review, with an audit note |
| `accept` | Transition submitted work to `done` |
| `reject` | Return submitted work to `open` with a reason |
| `release` | Explicitly release an active claim |
| `cancel` | Explicitly cancel a task |
| `reopen` | Reopen an accepted task or resolved gate for correction |
| `resolve <gate>` | Resolve a gate with a choice and rationale |

## Common error codes

- `NODE_NOT_FOUND` — id doesn't exist.
- `NOT_READY` — a task cannot start because it is blocked or unavailable.
- `ALREADY_CLAIMED` — another actor currently owns the task.
- `INVALID_STATUS` — a transition is not allowed from the current status.
- `MISSING_FIELD` / `MISSING_AGENT` — required flag absent.
- `REVISION_CONFLICT` — `update --if-revision N` found a newer revision.
- `INITIATIVE_NOT_FOUND` — `--initiative` is not registered.
- `ID_CONFLICT` — duplicate id on add.
- `INVALID_EDGE_TYPE` / `INVALID_EDGE_KIND` / `SELF_EDGE` / `CYCLE_DETECTED` / `DUPLICATE_EDGE` / `INVALID_EDGE_TARGET` — edge problems.
