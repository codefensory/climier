---
name: initiative-execution
description: Opt-in coordination for executing a Climier initiative one ready task at a time through climierflow.
---

# initiative-execution — opt-in initiative coordination

Use this skill only when the user explicitly selects an initiative-wide execution run or asks for coordinated progress across its task DAG. It is not the default path for a single task or a small change.

## Execution loop

1. Inspect `climier status` for the selected initiative and read each candidate with `climier context <task-id>`. Check readiness, blockers, scoped knowledge, and alerts before starting work.
2. Select one ready task whose contract and acceptance are executable.
3. Run one `climierflow run <task-id>` per task. There is no command that runs an entire initiative; do not invoke `climierflow` with an initiative id.
4. Check the terminal JSON result. Continue only when it is terminal and its evidence is sufficient: successful work reports `ok: true` and `status: "done"`; blocked or failed work reports structured `error` details.
5. Refresh initiative status and context before selecting the next ready task. Stop when no executable task remains, a dependency blocks progress, or the user’s requested scope is complete.

Each task gets its own runner invocation and terminal result. Do not treat a non-terminal or missing result as completion, and do not manually perform `take`, `submit`, `accept`, or `reject`; those lifecycle stages belong to the runner.

## Recovery

If an execution is interrupted, inspect the runner and use its recovery commands:

```bash
climierflow status
climierflow resume <task-id>
# or, when a fresh attempt is required:
climierflow restart <task-id>
```

Follow the runner’s reported checkpoint and recovery state. Do not recreate claims, worktrees, lifecycle transitions, reviews, commits, or merges by hand. Read `.agents/skills/climier/SKILL.md` for the canonical DAG and runner contract.
