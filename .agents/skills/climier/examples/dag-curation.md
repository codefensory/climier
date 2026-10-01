# DAG curation and task execution

Climier is the control plane for project state. The operator reads and curates the graph with `climier`, then executes a ready task only through `climierflow`.

## The operator loop

```bash
climier status
climier context <id>
climierflow run <id>
```

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
climierflow run T-auth
```

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

Tasks blocked by the gate become ready only after the gate is resolved. Start each ready task with `climierflow run <task-id>`.

## Recovery and administration

Inspect an interrupted run through the runner:

```bash
climierflow status
climierflow resume <id>
climierflow restart <id>
```

Use `reopen`, `release`, and `cancel` only for explicit DAG administration. They are not substitutes for the runner's execution or recovery commands. Use `climier status` and `climier context <id>` to verify the graph before or after recovery.

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

The new node remains governed by its dependencies. When it is ready, invoke `climierflow run T-web-99`.
