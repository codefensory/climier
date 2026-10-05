---
name: initiative-execution
description: Opt-in coordination for executing a Climier initiative one ready task at a time through the Pi Flow extension tool.
---

# initiative-execution — opt-in initiative coordination

Use this skill only when the user explicitly selects an initiative-wide execution run or asks for coordinated progress across its task DAG. It is not the default path for a single task or a small change.

## Execution loop

1. Inspect `climier status` for the selected initiative and read each candidate with `climier context <task-id>`. Check readiness, blockers, scoped knowledge, and alerts before starting work.
2. Select one ready task whose contract and acceptance are executable.
3. Call the Pi tool `climier_flow` once per task with `{ "action": "run", "task_id": "<task-id>" }`. Do not start a second run for the same task or pass an initiative id as a task id.
4. The tool launches in the background and confirms launch; inspect active progress in the Pi widget and use `{ "action": "status", "task_id": "<task-id>" }` to read the saved report.
5. Refresh initiative status and context before selecting the next ready task. Stop when no executable task remains, a dependency blocks progress, or the user’s requested scope is complete.

Do not treat a launch confirmation as completion, and do not manually perform `take`, `submit`, `accept`, or `reject`; those lifecycle stages belong to the runner.

## Recovery

If an execution is interrupted, inspect its report through the tool and resume only when a safe checkpoint is available:

```json
{ "action": "status", "task_id": "<task-id>" }
{ "action": "resume", "task_id": "<task-id>", "summary": "<optional checkpoint context>" }
```

The current Pi Flow tool does not expose restart. Do not fall back to a shell command; if a non-completed attempt requires a fresh start, explain the limitation and ask for tool support. A completed and merged attempt cannot be restarted; create a new correction task instead. Do not recreate claims, worktrees, lifecycle transitions, reviews, commits, or merges by hand. Read `.agents/skills/climier/SKILL.md` for the canonical DAG and runner contract.
