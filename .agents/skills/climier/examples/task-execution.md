# Unified task execution — end-to-end

Climier is the DAG control plane. `climierflow` is the only operator entrypoint for executing a task. The runner owns claim, worktree, implementation, review, lifecycle, commit, merge, and cleanup internally.

## Setup

```bash
cd ~/Dev/climier
# climier and climierflow are on PATH; project state is managed by Climier
```

## 1. Read and curate the DAG

Use Climier for the task contract and its surrounding graph:

```bash
climier status | jq '{summary, ready_ids: [.tasks.ready[].id], open_gates: [.gates.open[].id]}'
climier context T-auth-7
```

`context` is the read-only preflight. Check the task's acceptance, blockers, scoped knowledge, related nodes, and alerts. If the contract needs correction, curate it with Climier before execution:

```bash
climier update T-auth-7 --acceptance "..." --as <agent>
climier add-note T-auth-7 "..." --as <agent>
```

Do not reproduce the runner's internal lifecycle by hand.

## 2. Execute through the single entrypoint

```bash
climierflow run T-auth-7
```

The command runs the complete internal workflow and returns one terminal JSON object. A successful result has this shape:

```json
{
  "ok": true,
  "task_id": "T-auth-7",
  "status": "done",
  "terminal": true,
  "result": {
    "summary": "<result summary>",
    "commit": "<commit-sha>",
    "merged": true
  }
}
```

A blocked or failed execution keeps the same top-level contract and exposes structured recovery data:

```json
{
  "ok": false,
  "task_id": "T-auth-7",
  "status": "blocked",
  "terminal": true,
  "error": {
    "code": "<code>",
    "message": "<message>",
    "details": {}
  }
}
```

The terminal JSON is the execution report. The operator does not run separate lifecycle, commit, merge, or review commands.

## 3. Recover an interrupted execution

Inspect the runner, not its internal stages:

```bash
climierflow status T-auth-7
```

If the status reports a resumable checkpoint, continue it:

```bash
climierflow resume T-auth-7 [--summary TEXT]
```

If the current, non-completed attempt must start again instead, restart it with replacement contract values:

```bash
climierflow restart T-auth-7 --body "<replacement body>" --acceptance "<replacement acceptance>" --confirm-discard
```

`--summary` is optional for `resume`; `restart` requires `--body`,
`--acceptance`, and `--confirm-discard`. A completed and merged attempt is not
restartable: the runner returns `RESTART_REQUIRES_REVIEW`. Do not reopen it to
restart the completed flow; create a new correction task for additional work.
Use `climier status` and `climier context T-auth-7` to inspect the DAG before or
after recovery. Do not recreate the claim, worktree, implementation, review, or
merge sequence by hand.

## 4. Gates and knowledge remain Climier concepts

Create and curate gates and knowledge with Climier. Resolve a gate only through its DAG command:

```bash
climier add-gate D9 --initiative research --title "investigate auth library" \
  --body "Read .decisions/D9.md for the findings." \
  --purpose decision --as <agent>
climier resolve D9 --choice "use the selected approach" \
  --rationale "See the decision record." --as <agent>
climier add-knowledge K-auth --initiative auth --title "Auth constraints" \
  --body "..." --scope-initiatives auth --as <agent>
```

A task blocked by an unresolved gate stays blocked in the DAG. Once its contract is ready, execute it with `climierflow run <task-id>`.

## What is not an operator step

Do not invoke `take`, `submit`, `accept`, or `reject` as a hand-written execution sequence. Those lifecycle transitions are internal to `climierflow`; use the runner and inspect its terminal result or recovery status.
