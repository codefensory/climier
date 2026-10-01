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

## Execution and recovery

`climierflow` is the only task execution entrypoint:

| Command | Purpose |
|---|---|
| `climierflow run <id>` | Execute one task through claim, worktree, implementation, review, lifecycle, commit, merge, and cleanup |
| `climierflow status` | Inspect the current execution and available checkpoints |
| `climierflow resume <id>` | Continue an interrupted execution from a checkpoint |
| `climierflow restart <id>` | Start the task execution again |

Do not chain `take`, `submit`, `accept`, or `reject` manually. The runner owns
those lifecycle transitions.

## DAG curation and administration

| Command | Purpose |
|---|---|
| `init [--force]` | Create or deliberately reset `.climier.json` and live state |
| `resolve <id> --choice "..." --rationale "..." --as <agent>` | Resolve an open gate |
| `reopen <id> --reason "..." --as <agent>` | Correct a completed task or resolved gate |
| `release <id> --as <agent>` | Administrative claim release |
| `cancel <id> --reason "..." --as <agent>` | Administrative node cancellation |
| `restore <snapshot-id> --as orchestrator\|recovery` | Replace live state with a validated snapshot |
| `update <id> ... --as <agent>` | Edit task, gate, or knowledge fields |
| `add-note <id> "..." --as <agent>` | Append to a node's note thread |
| `deprecate-knowledge <id> --reason "..." --as <agent>` | Soft-delete knowledge |

The lifecycle commands `take`, `submit`, `accept`, and `reject` remain public
state operations for compatibility and recovery tooling, but they are not the
normal operator path for executing a task.

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
