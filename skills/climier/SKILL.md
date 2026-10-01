---
name: climier
description: Operate climier, the JSON-first task DAG CLI for creating, reading, and curating tasks, gates, knowledge, and dependencies. Use climierflow as the single entrypoint for task execution and recovery.
---

# climier — JSON-first task DAG CLI

## What it is (and is NOT)

Climier stores workflow state: tasks form a DAG, gates are resolvable nodes that
block tasks, and knowledge holds scoped durable facts. Mutations are recorded in
an append-only audit log.

Climier is the DAG control plane, not the task executor. Use `climier` to read
or curate graph state and use `climierflow` to execute a task. The runner owns
claim, worktree, implementation, review, lifecycle, commit, merge, and cleanup.

## Install

```bash
npm install -g climier   # Node 20+, or Bun 1.3+ as an alternative runtime
```

Or from a clone — `bin/climier.mjs` runs under either runtime:

```bash
node bin/climier.mjs --help
bun bin/climier.mjs --help
```

Run commands from the project root so the project resolves.

## State model

- `<project>/.climier.json` — stable project metadata (committable).
- `~/.climier/projects/<project-id>/tasks.json` — live mutable state (never
  commit). Override home with `$CLIMIER_HOME` for isolated experiments.

## Curate the DAG

Use the read-only views before changing or executing work:

```bash
climier status
climier context <id>
climier show <id>
climier history <id>
```

`context` is the task preflight. Read its acceptance, blockers, related nodes,
scoped knowledge, alerts, and allowed actions. Curate gates, tasks, knowledge,
and notes with the corresponding Climier commands. If a task contract needs
correction, update it before execution.

```bash
climier update <id> --acceptance "..." --as <agent>
climier add-note <id> "..." --as <agent>
climier resolve <gate-id> --choice "..." --rationale "..." --as <agent>
```

## Execute through the single entrypoint

Once the task is ready and its contract is sufficient, run:

```bash
climierflow run <task-id>
```

The terminal result is one JSON object. A successful run includes `ok`,
`task_id`, `status`, `terminal`, and a `result` with summary, commit, and merge
information. A failed or blocked run keeps the same envelope and includes a
structured `error` with `code`, `message`, and `details`.

Do not invoke `take`, `submit`, `accept`, or `reject` as a hand-written task
execution sequence. Those lifecycle transitions are owned by the runner.

## Recovery

Inspect and recover through the runner:

```bash
climierflow status
climierflow resume <task-id>
climierflow restart <task-id>
```

Use `resume` when a checkpoint is available. Use `restart` when the attempt
must start again. Do not recreate a claim, worktree, review, commit, or merge
sequence manually. Use `reopen`, `release`, and `cancel` only for explicit DAG
administration, not as replacements for runner recovery.

## Invariants

- `ready` and `blocked` are derived from dependencies; never hand-written.
- Only blockers in `done` or `archived` satisfy dependencies.
- A cycle or unknown dependency keeps a task blocked; the CLI stays defensive.
- Gates block through `BLOCKS` edges until `resolve --choice --rationale`.
- The runner's terminal JSON is the execution evidence; inspect it before
  deciding whether recovery is needed.

## Output contract

JSON-only on stdout for normal commands. Success is the command result object;
failure is `{ok:false, error:{code, message, details}}` with exit 1. Branch on
`error.code`, never on message text. Help is the intentional plain-text
exception.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| Task is not ready | A blocker, open gate, backlog setting, or active run prevents execution | `climier context <id>` and `climier status` |
| An execution stopped | The runner reported a failure or checkpoint | `climierflow status`, then `resume` or `restart` |
| A completed task needs correction | The recorded result no longer satisfies its contract | `climier reopen <id> --reason "..." --as <agent>`, then rerun |

## When NOT to use climier

- Single linear work with no dependencies, decisions, or coordination needs — a
  todo list is enough.
- Secrets or large blobs — tasks hold short text; point at files instead.
- Manual lifecycle orchestration — use `climierflow run` and its recovery
  commands instead.

Full command reference: [`references/commands.md`](./references/commands.md).
Upstream docs: the repository's `README.md` and `docs/reference.md`.
