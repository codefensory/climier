---
name: climier
description: Operate climier, the JSON-first task DAG CLI for creating, reading, and curating tasks, gates, knowledge, dependencies, and task lifecycle state.
---

# climier — JSON-first task DAG CLI

## What it is

Climier stores shared workflow state: tasks form a DAG, gates are resolvable
nodes that block tasks, and knowledge holds scoped durable facts. Mutations are
recorded in an append-only audit log.

Use Climier to inspect and curate the graph and to record task ownership and
review outcomes. Its lifecycle commands are `take`, `submit`, `accept`, and
`reject`; its administrative commands include `release`, `reopen`, and `cancel`.

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

## Inspect and curate the DAG

Use the read-only views before changing state:

```bash
climier status
climier context <id>
climier show <id>
climier history <id>
```

`context` shows the node contract, blockers, related nodes, scoped knowledge,
alerts, and available actions. Curate gates, tasks, knowledge, and notes with
the corresponding Climier commands. Correct a task contract before claiming
it.

```bash
climier update <id> --acceptance "..." --as <agent>
climier add-note <id> "..." --as <agent>
climier resolve <gate-id> --choice "..." --rationale "..." --as <agent>
```

## Record task lifecycle

A common lifecycle is:

```bash
climier take <task-id> --as <agent>
# Perform the work, recording relevant progress with add-note.
climier submit <task-id> --note "Implementation complete" --as <agent>
# A reviewer records the outcome:
climier accept <task-id> --as <reviewer>
```

Use `reject <task-id> --reason "..." --as <reviewer>` to return submitted
work to `open`. A `submitted` task does not satisfy dependencies; only `done`
or `archived` blockers do. Claims are serialized under the project lock.

## Invariants

- `ready` and `blocked` are derived from dependencies; never hand-written.
- Only blockers in `done` or `archived` satisfy dependencies.
- A cycle or unknown dependency keeps a task blocked; the CLI stays defensive.
- Gates block through `BLOCKS` edges until `resolve --choice --rationale`.
- Every mutation and its audit entry are committed together.

## Output contract

JSON-only on stdout for normal commands. Success is the command result object;
failure is `{ok:false, error:{code, message, details}}` with exit 1. Branch on
`error.code`, never on message text. Help is the intentional plain-text
exception.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| Task is not ready | A blocker, open gate, or backlog setting prevents a claim | `climier context <id>` and `climier status` |
| A task is already claimed | Another actor owns it | Inspect `context`; use `release` only for explicit administration |
| Submitted work needs changes | A reviewer rejected the submission | Read the rejection in the audit history, address it, and submit again |

## When NOT to use climier

- Single linear work with no dependencies, decisions, or coordination needs — a
  todo list is enough.
- Secrets or large blobs — tasks hold short text; point at files instead.

Full command reference: [`references/commands.md`](./references/commands.md).
Upstream docs: the repository's `README.md` and `docs/reference.md`.
