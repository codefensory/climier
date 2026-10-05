# Unified task execution — end-to-end

Climier is the DAG control plane. In Pi, invoke execution and recovery through the `climier_flow` extension tool. The runner owns claim, worktree, implementation, review, lifecycle, commit, merge, and cleanup internally.

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

## 2. Execute through the Pi extension tool

Call the `climier_flow` tool with:

```json
{ "action": "run", "task_id": "T-auth-7" }
```

This launches the complete workflow in the background. The immediate tool result confirms launch; the Pi widget tracks active progress. Use the tool's `status` action to inspect a saved run report:

```json
{ "action": "status", "task_id": "T-auth-7" }
```

The extension's status/list actions read run manifests. They are not DAG views: use `climier status` and `climier context` for readiness, blockers, and task contracts.

## 3. Recover an interrupted execution

Inspect the report with the tool, then resume only when its checkpoint indicates that is safe:

```json
{ "action": "status", "task_id": "T-auth-7" }
{ "action": "resume", "task_id": "T-auth-7", "summary": "<optional checkpoint context>" }
```

`summary` is optional. The current Pi Flow tool does not expose `restart`; do not invoke Flow through shell as a fallback. If a non-completed attempt needs a fresh start, explain the tool limitation and ask for that capability. A completed and merged task must not be restarted; create a new correction task instead.

Do not recreate the claim, worktree, implementation, review, or merge sequence by hand.

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

A task blocked by an unresolved gate stays blocked in the DAG. Once its contract is ready, invoke `climier_flow` with `action: "run"` and the task id.

## What is not an operator step

Do not invoke `take`, `submit`, `accept`, or `reject` as a hand-written execution sequence. Those lifecycle transitions are internal to the runner; use the Pi Flow tool and inspect its saved status report.
