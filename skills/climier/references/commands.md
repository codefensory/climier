# climier — command reference (condensed)

Source of truth: the repository `README.md` and `docs/reference.md`.
All commands print JSON to stdout. `--as <agent>` tags identity in the audit log.

## Read-only

| Command | Purpose |
|---|---|
| `status [--initiative X] [--kind task\|gate\|knowledge] [--status X] [--claimed-by X] [--stale-ms N] [--limit N] [--all]` | Full view: summary, alerts, in-progress, ready, backlog, blocked, open gates, knowledge, and stale claims |
| `context <id>` | Agent-first view: spec, blockers, informing edges, scoped knowledge, and allowed actions |
| `search "<q>" [--all]` | Substring search over active knowledge (`--all` includes deprecated) |
| `history <id> [--limit N]` | Audit entries referencing a node |
| `show <id>` | Raw node JSON |
| `initiatives` | Registered and unregistered initiative values |
| `log [--limit N] [--action X] [--agent X] [--node X]` | Audit log |
| `snapshots` | Recoverable snapshots |
| `ui [--port N] [--open=bool]` | Local read-only web UI |

## Task lifecycle

| Command | Purpose |
|---|---|
| `take <task-id> --as <agent>` | Claim a ready task |
| `submit <task-id> --note "..." --as <agent>` | Submit owned work for review with an audit note |
| `accept <task-id> --as <agent>` | Transition submitted work to `done` |
| `reject <task-id> --reason "..." --as <agent>` | Return submitted work to `open` with a reason |
| `release <task-id> --as <agent>` | Release an active claim |
| `reopen <task-id> --reason "..." --as <agent>` | Reopen a task or resolved gate for correction |
| `cancel <task-id> --reason "..." --as <agent>` | Cancel a node |

`submitted` work does not satisfy dependencies. Only `done` and `archived`
blockers unblock downstream tasks.

## DAG curation and administration

| Command | Purpose |
|---|---|
| `init [--force]` | Create or deliberately reset `.climier.json` and live state |
| `resolve <id> --choice "..." --rationale "..." --as <agent>` | Resolve an open gate |
| `reopen <id> --reason "..." --as <agent>` | Reopen a task or resolved gate for correction |
| `release <id> --as <agent>` | Administrative claim release |
| `cancel <id> --reason "..." --as <agent>` | Administrative node cancellation |
| `restore <snapshot-id> --as orchestrator\|recovery` | Replace live state with a validated snapshot |
| `update <id> ... --as <agent>` | Edit task, gate, or knowledge fields |
| `add-note <id> "..." --as <agent>` | Append to a node's note thread |
| `deprecate-knowledge <id> --reason "..." --as <agent>` | Soft-delete knowledge |

The lifecycle commands `take`, `submit`, `accept`, and `reject` record ownership
and review state in the project DAG.

## DAG construction

| Command | Purpose |
|---|---|
| `add-initiative <name> [--desc "..."] --as <agent>` | Register an initiative |
| `add-task [id] --initiative X --title --body --acceptance --blocked-by A,B` | Append a task |
| `add-gate [id] --initiative X --title --body --purpose decision\|approval\|external-dependency\|research [--supersedes OLD]` | Append a gate |
| `add-knowledge [id] --initiative X --title --body [--scope-domains X] [--scope-initiatives X] [--scope-tags X] [--scope-node-ids X]` | Add scoped durable knowledge |
| `add-node` / `add-edge <from> <to> --type BLOCKS\|SUPERSEDES\|DERIVED_FROM` | Low-level escape hatches |

Canonical `BLOCKS` direction: `{from: blocker, to: blocked}`.

## Statuses

- Task persisted: `open | in_progress | submitted | done | canceled`.
- Derived: `ready | blocked | backlog`.
- Gate: `open | resolved`.
- Knowledge: `active | deprecated`.

## Exit codes

- 0 success · 1 domain/storage failure (`{ok:false, error:{code,...}}`) ·
  2 unknown command.
