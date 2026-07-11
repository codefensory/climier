# climier

Task DAG harness for multi-agent workflows. A single-file state in each project (`.agents/tasks/tasks.json`), a CLI to manage it, and a model designed for several agents (or an orchestrator + workers) to claim and complete work in parallel without stepping on each other.

## Output: JSON-only

Every command prints a single JSON value to stdout. Errors are JSON to stdout, with non-zero exit. There is no `--json` flag (it's the default), no text mode. Use `jq` for human reading.

| Outcome | stdout | exit |
|---|---|---|
| Success | `{...}` or `[...]` (the command's result) | 0 |
| Error | `{ "ok": false, "error": "<message>" }` | 1 (validation) or 2 (bad invocation) |
| `--help` | plain text (the only non-JSON output) | 0 |

## What it is

- A small Node CLI (no runtime dependencies, stdlib only).
- State lives in **one JSON file per project**, committed to git.
- Tasks form a **DAG** with dependencies. Decisions are also nodes in the DAG, so a decision gates the tasks that need it.
- A task can be `ready` (deps done, claimable), `in_progress` (claimed by an agent), `done`, `blocked` (deps not met), or `archived`. `ready` and `blocked` are **derived** from the DAG; only `in_progress`/`done`/`archived` are persisted.
- `claim` is **atomic** with a file lock, so two agents cannot claim the same task.
- The orchestrator reads `ready` (which task, with what skills/effort/domain) and delegates.

## Install / use

From this repo (development):

```bash
node bin/climier.mjs <command>
```

From any project that has `.agents/tasks/tasks.json` in it, run from the project root. Use `--project <dir>` to point at another directory.

## Commands

| Command | What |
|---|---|
| `init` | Create an empty `.agents/tasks/tasks.json` in the CWD (or `--project <dir>`). |
| `status` | Global view: per-initiative counts, in_progress (who), ready (with skills/effort/domain/gotcha_count), blocked (with unsatisfied_deps + placeholder flag), open_decisions (with title + impact), blocked_by_decision, stale claims, active gotchas. Includes `summary.text` (one-line plain English) and `alerts` (decision-gate, stale-claim). |
| `ready` | Only the claimable-now tasks, with skills/effort/domain. This is the orchestrator's delegation view. |
| `claim <id> --as <agent>` | Take a `ready` task atomically. |
| `next <id>` | Definition + acceptance criteria + gotchas for the domain. |
| `pre-claim <id> [--staleMs N]` | Read-only task detail + pre-flight: spec, gotchas, derived status, current claim, stale warnings, structured `depends_on_detail` (kind/status/title/claimed_by per dep), GO/NO-GO verdict. |
| `done <id> "note" --as <agent>` | Mark complete; recompute ready. |
| `release <id> --as <agent>` | Free the claim without completing. |
| `reopen <id> "reason" --as orchestrator` | Roll a `done` task back to `in_progress`; downstream tasks re-block. Authority: orchestrator (or the original `done_by`). |
| `archive <id> "reason" --as <agent>` | Mark a task archived (terminal "we decided not to do this"). in_progress requires the claimer (or `orchestrator`/`recovery` escape hatch); ready/blocked tasks can be archived by any agent. |
| `block <id> "reason" --as <agent>` | Mark a blocker on the current task. |
| `decide <D> "<choice>" --because "..."` | Close a decision; unblocks tasks that depend on it. |
| `update <id> [--title X] [--body "..."] [--skills a,b] [--depends-on A,B] ... --as <agent>` | Edit a task. `in_progress`/`done` are locked. `--depends-on` rewrites the dependency list — use it to unblock a task. |
| `add-note <id> "text" --as <agent>` | Append a note to a task's running thread (any status). |
| `close-gotcha <id> --as <agent>` | Mark a gotcha resolved (soft delete; `forTask` and the `gotchas` view filter it out). Idempotent. |
| `reopen-gotcha <id> --as <agent>` | Undo a `close-gotcha`. |
| `tasks [--initiative X] [--status Y]` | List tasks. |
| `next-id <phase> [--suffix R]` | Get the next free task id for a phase (e.g. `next-id F1` → `{"next": "F1.T3"}`; `next-id F1 --suffix R` → `{"next": "F1.T1R"}`). Read-only. |
| `graph` | Print the DAG as text. |
| `add-task ...` | Add a task to the DAG. Pass either an explicit id (`add-task F1.T1 ...`) or `--phase F1` to auto-allocate the next free id in the phase. Add `--suffix R` (only with `--phase`) to tag the id (e.g. `F1.T1R`). |
| `add-initiative <name> --desc "..."` | Register an initiative. |
| `add-decision <id> --title "..." [--initiative X] [--applies-to F1,T2,...]` | Register a new decision (use for research that yields a choice). |

## Concepts

- **Initiative** — a string tag (`migration`, `redesign`, …). Tasks, decisions, and gotchas carry one. There is no project registry with logic; an initiative is just a tag and a description.
- **Decision** — a node in the DAG with `status: open|decided`. Tasks that `depends_on` a decision cannot be ready until it is `decided`.
- **Gotcha** — knowledge attached to a `domain` (or specific task id). `next` injects gotchas that match the worker's task.
- **Stale claim** — a claim older than 2 hours. `status` flags them; the orchestrator can `release` and reassign.

## License

MIT
