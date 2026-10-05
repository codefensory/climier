# DAG curation

Climier is the control plane for project state. Read and curate the graph with `climier`; execution of a ready task is owned by the external `climier-flow` runner and is launched through the `climier_flow` Pi tool (see the `climier-flow` skill).

## The operator loop

```bash
climier status
climier context <id>
```

Use `context` to inspect acceptance, blockers, scoped knowledge, related nodes, alerts, and allowed actions. If the contract is incomplete, correct it before work starts:

```bash
climier update <id> --acceptance "..." --as <agent>
climier add-note <id> "..." --as <agent>
```

Once the node is `ready` and its contract is correct, launch it through the `climier_flow` tool with `{ "action": "run", "task_id": "<id>" }`. The runner owns the task claim, worktree, implementation, review, lifecycle, commit, merge, and cleanup; do not reproduce those stages with separate commands.

## Resolving gates

A gate is ready to resolve when the decision has enough evidence and the chosen path is recorded. Resolve it with Climier, then let the DAG derive newly executable tasks:

```bash
climier resolve G-auth --choice "opaque sessions" \
  --rationale "Keeps the client contract stable." --as <agent>
climier status
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

Tasks blocked by the gate become ready only after the gate is resolved.

## Adding work while a run is active

The DAG can be curated without touching an in-flight execution:

```bash
climier add-task T-web-99 \
  --initiative migration \
  --title "Update the setup guide" \
  --body "Document the supported local setup." \
  --acceptance "The guide includes the supported commands." \
  --blocked-by T-api-1 --as <agent>
climier status
```

The new node is governed by its dependencies. When it is ready, launch it through the `climier_flow` tool.

## Recovery

Recovery of an interrupted run is a `climier-flow` concern: inspect it with the tool's `status` action, then `resume` when a checkpoint is safe, or `restart` a non-completed attempt. See the `climier-flow` skill. `reopen`, `release`, and `climier cancel` remain explicit DAG-administration actions.
