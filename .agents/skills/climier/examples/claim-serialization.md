# Claim serialization and runner ownership

Climier stores task claims under a file lock next to the state file at `~/.climier/projects/<project_id>/.lock`. The runner owns claim transitions; Pi starts it through the `climier_flow` extension tool, and operators do not coordinate execution by racing lifecycle commands.

## What the runner guarantees

For a task execution, the runner acquires the project lock, reads fresh state, and records the claim atomically before continuing. A second execution cannot overwrite the first claim: it waits for the lock and then observes the task's current state.

The same lock protects state, revision, and audit-log updates. This prevents two executions from producing conflicting claims or a log entry that does not describe the committed state.

## How to inspect an execution

Use the Pi tool for saved runner state and Climier for the DAG projections:

```json
{ "action": "status", "task_id": "T-auth-7" }
```

```bash
climier context T-auth-7
climier status
```

If the report exposes a resumable checkpoint, continue with the tool action
`resume`, passing `task_id: "T-auth-7"` and an optional `summary`. The Pi tool
does not expose restart; do not use shell as a fallback. Ask for tool support
if a non-completed attempt must start over. A completed and merged attempt
cannot be restarted; create a new correction task rather than reopening it. Do
not recreate the claim, worktree, or lifecycle by hand.

## If a lock is stale

`withLock` does not auto-clear a stale lock. Confirm that no legitimate Climier or runner process is active before removing the lock file, then inspect the DAG and runner state before retrying:

```bash
rm ~/.climier/projects/<project_id>/.lock
climier status
```

Then inspect the saved execution with the Pi `climier_flow` tool using `action: "status"` and the task id.

The lock lives next to the state file inside `~/.climier/projects/<project_id>/`, not inside the repository. Cross-machine coordination requires a real lock service; the file-lock strategy is for local project coordination.
