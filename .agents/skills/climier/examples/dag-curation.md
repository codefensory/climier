# DAG curation and task execution

Climier is the control plane for project state. In Pi, read and curate the graph with `climier`, then execute a ready task through the `climier_flow` extension tool.

## The operator loop

```bash
climier status
climier context <id>
```

Then call the Pi tool `climier_flow` with `{ "action": "run", "task_id": "<id>" }`.

Use `context` before execution to inspect acceptance, blockers, scoped knowledge, related nodes, alerts, and allowed actions. If the contract is incomplete, correct it before starting the runner:

```bash
climier update <id> --acceptance "..." --as <agent>
climier add-note <id> "..." --as <agent>
```

The runner owns the task claim, worktree, implementation, review, lifecycle, commit, merge, and cleanup stages. Do not assign or reproduce those stages with separate commands.

## Resolving gates

A gate is ready to resolve when the decision has enough evidence and the chosen path is recorded. Resolve it with Climier, then let the DAG derive newly executable tasks:

```bash
climier resolve G-auth --choice "opaque sessions" \
  --rationale "Keeps the client contract stable." --as <agent>
climier status
```

Then call `climier_flow` with `{ "action": "run", "task_id": "T-auth" }`.

Do not resolve a task with `resolve`; that command is for gates.

## Research before implementation

For an investigation, register a research gate and keep the findings in its decision document:

```bash
climier add-gate G-ui-transport --initiative climier-ui \
  --title "Choose the UI transport" \
  --body "Compare the options in .decisions/G-ui-transport.md." \
  --purpose research --as <agent>
# write .decisions/G-ui-transport.md
climier resolve G-ui-transport --choice "use node:http" \
  --rationale "The project remains stdlib-only; see the decision record." \
  --as <agent>
```

Tasks blocked by the gate become ready only after the gate is resolved. Start each ready task with the Pi tool `climier_flow`, action `run`.

## Recovery and administration

Inspect and recover an interrupted run through the Pi tool `climier_flow`:

```json
{ "action": "status", "task_id": "<task-id>" }
{ "action": "resume", "task_id": "<task-id>", "summary": "<optional checkpoint context>" }
```

The tool does not expose restart; do not use a shell command as a fallback. If
a non-completed attempt requires a fresh start, explain the limitation and ask
for tool support. A completed and merged attempt cannot be restarted; create a
new correction task. Use `reopen`, `release`, and `cancel` only for explicit
DAG administration. Use `climier status` and `climier context <id>` to verify
the graph before or after recovery.

## Adding work while a run is active

The DAG can be curated without recreating an execution sequence:

```bash
climier add-task T-web-99 \
  --initiative migration \
  --title "Update the setup guide" \
  --body "Document the supported local setup." \
  --acceptance "The guide includes the supported commands." \
  --blocked-by T-api-1 --as <agent>
climier status
```

The new node remains governed by its dependencies. When it is ready, call `climier_flow` with `{ "action": "run", "task_id": "T-web-99" }`.
