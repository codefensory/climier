# climier — command reference (condensed)

Source of truth: the climier repository (`README.md` and `docs/reference.md`).
All commands print JSON to stdout. `--as <agent>` tags identity in the audit log.

## Read-only

| Command | Purpose |
|---|---|
| `status [--initiative X] [--kind task\|gate\|knowledge] [--status X] [--claimed-by X] [--stale-ms N] [--limit N] [--all]` | Full view: summary, alerts, in-progress, ready, backlog, blocked, open gates, knowledge, stale claims |
| `context <id>` | Agent-first view: spec, blockers, informing edges, scoped knowledge, allowed actions |
| `search "<q>" [--all]` | Substring search over active knowledge (`--all` includes deprecated) |
| `history <id> [--limit N]` | Audit entries referencing a node |
| `show <id>` | Raw node JSON |
| `initiatives` | Registered + unregistered initiative values |
| `log [--limit N] [--action X] [--agent X] [--task X] [--decision X]` | Audit log |
| `snapshots` | Recoverable snapshots (id, reason, bytes, sha256) |
| `ui [--port N] [--open=bool]` | Local read-only web UI (needs `npm install` in `ui/` once) |

## Mutating

| Command | Purpose |
|---|---|
| `init [--force]` | Create `.climier.json` + live state |
| `take <id> --as <agent>` | Atomic, idempotent claim of a ready task |
| `submit <id> --note "..." --as <agent>` | in_progress → submitted (awaiting validation; clears claim; never unblocks) |
| `accept <id> --as <agent>` | submitted → done (unblocks dependents) |
| `reject <id> --reason "..." --as <agent>` | submitted → open |
| `release <id> --as <agent>` | Free an in_progress claim |
| `reopen <id> --reason "..." --as <agent>` | done → open (policy-constrained) |
| `cancel <id> --reason "..." --as <agent>` | Terminate from open/in_progress/submitted |
| `resolve <id> --choice "..." --rationale "..." --as <agent>` | Resolve an open gate (not a task lifecycle op) |
| `restore <snapshot-id> --as orchestrator\|recovery` | Replace live state with a validated snapshot |
| `update <id> ... --as <agent>` | Edit title/body/acceptance/domain/backlog/tags/refs |
| `add-note <id> "..." --as <agent>` | Append to a node's note thread |
| `deprecate-knowledge <id> --reason "..." --as <agent>` | Soft-delete knowledge |

## DAG construction

| Command | Purpose |
|---|---|
| `add-initiative <name> [--desc "..."]` | Register an initiative |
| `add-task [id] --initiative X --title --body --acceptance --blocked-by A,B` | Append task (auto id `T-xxxxxxxx`); for backlog, add then `update <id> --backlog true` |
| `add-gate [id] --initiative X --title --body --purpose decision\|approval\|external-dependency\|research [--supersedes OLD]` | Append gate |
| `add-knowledge [id] --initiative X --title --body [--scope-domains X] [--scope-initiatives X] [--scope-tags X] [--scope-node-ids X]` | Scoped durable fact (any `--scope-*` satisfies scope) |
| `add-node` / `add-edge <from> <to> --type BLOCKS\|SUPERSEDES\|DERIVED_FROM` | Low-level escape hatches |

Canonical BLOCKS direction: `{from: blocker, to: blocked}`.

`--body "..."` takes inline text; `--body-file <path>` reads it from a markdown file instead (mutually exclusive, 512 KiB cap). Prefer the file form for long specs — write to a temp file and cite its path. Available on `add-task`, `add-gate`, `add-knowledge`, `add-node` and `update`.

## Statuses

- Task persisted: `open | in_progress | submitted | done | canceled`.
- Derived: `ready | blocked | backlog`.
- Gate: `open | resolved`.
- Knowledge: `active | deprecated`.

## Exit codes

- 0 success · 1 domain/storage failure (`{ok:false, error:{code,...}}`) ·
  2 unknown command.
