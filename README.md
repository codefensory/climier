# climier

Task DAG harness for multi-agent workflows. A single-file state in each project (`.agents/tasks/tasks.json`), a CLI to manage it, and a model designed for several agents (or an orchestrator + workers) to claim and complete work in parallel without stepping on each other.

## What it is

- A small Node CLI (no runtime dependencies, stdlib only).
- State lives in **one JSON file per project**, committed to git.
- Tasks form a **DAG** with dependencies. Decisions are also nodes in the DAG, so a decision gates the tasks that need it.
- A task can be `ready` (deps done, claimable), `in_progress` (claimed by an agent), `done`, `blocked` (deps not met), or `skipped`. `ready` and `blocked` are **derived** from the DAG; only `in_progress`/`done`/`skipped` are persisted.
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
| `status` | Global view: counts per initiative, in_progress (who), ready, blocked-by-decision, stale claims, active gotchas. |
| `ready` | Only the claimable-now tasks, with skills/effort/domain. This is the orchestrator's delegation view. |
| `claim <id> --as <agent>` | Take a `ready` task atomically. |
| `next <id>` | Definition + acceptance criteria + gotchas for the domain. |
| `pre-claim <id> [--staleMs N]` | Read-only pre-flight: task, gotchas, derived status, current claim, stale warnings, GO/NO-GO verdict. |
| `done <id> "note" --as <agent>` | Mark complete; recompute ready. |
| `release <id> --as <agent>` | Free the claim without completing. |
| `reopen <id> "reason" --as orchestrator` | Roll a `done` task back to `in_progress`; downstream tasks re-block. Authority: orchestrator (or the original `done_by`). |
| `block <id> "reason" --as <agent>` | Mark a blocker on the current task. |
| `decide <D> "<choice>" --because "..."` | Close a decision; unblocks tasks that depend on it. |
| `tasks [--initiative X] [--status Y]` | List tasks. |
| `graph` | Print the DAG as text. |
| `add-task ...` | Add a task to the DAG. |
| `add-initiative <name> --desc "..."` | Register an initiative. |
| `add-decision <id> --title "..." [--initiative X] [--applies-to F1,T2,...]` | Register a new decision (use for research that yields a choice). |

## Concepts

- **Initiative** — a string tag (`migration`, `redesign`, …). Tasks, decisions, and gotchas carry one. There is no project registry with logic; an initiative is just a tag and a description.
- **Decision** — a node in the DAG with `status: open|decided`. Tasks that `depends_on` a decision cannot be ready until it is `decided`.
- **Gotcha** — knowledge attached to a `domain` (or specific task id). `next` injects gotchas that match the worker's task.
- **Stale claim** — a claim older than 2 hours. `status` flags them; the orchestrator can `release` and reassign.

## License

MIT
