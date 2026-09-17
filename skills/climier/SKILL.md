---
name: climier
description: Operate climier, the JSON-first task DAG CLI (tasks, gates, knowledge, atomic take/submit/accept) for coordinating work across agents, sessions, or humans. Use when managing a task DAG, running orchestrator+worker flows, resolving decision gates, or sharing task state across sessions/worktrees. Triggers on climier, task DAG, take/submit/accept task, decision gates, ready/blocked tasks, stale claim.
---

# climier — JSON-first task DAG CLI

## What it is (and is NOT)

climier stores **workflow state**: tasks form a DAG, gates are resolvable
nodes that block tasks, knowledge holds scoped durable facts. Every mutation
lands in an append-only audit log; `take` is atomic under a file lock.

**It is agnostic and records only — it never executes anything.** It does not
spawn agents, run tests, or verify claims. Orchestrators and workers do the
work; climier is the system of record that survives session context loss.
Never treat it as an executor or scheduler.

## Install

```bash
npm install -g climier   # Node 20+, or Bun 1.3+ as an alternative runtime
```

Or from a clone — `bin/climier.mjs` runs under either runtime (the executable
shebang prefers Bun):

```bash
node bin/climier.mjs --help
bun bin/climier.mjs --help
```

Run commands from the project root so the project resolves.

## State model

- `<project>/.climier.json` — stable project metadata (committable).
- `~/.climier/projects/<project-id>/tasks.json` — live mutable state (never
  commit). Override home with `$CLIMIER_HOME` (use a temp dir for
  experiments — never pollute a real home).

## Core workflow patterns

### Orchestrator (seeds the DAG)

```bash
climier init
climier add-initiative <name> --desc "..." --as orchestrator
climier add-gate G-<id> --initiative <name> --title "..." --body "..." \
  --purpose decision|approval|external-dependency|research --as orchestrator
climier add-task T-<id> --initiative <name> --title "..." --body "..." \
  --acceptance "<binary, checkable criteria>" --blocked-by G-x,T-y --as orchestrator
```

### Worker (one task at a time)

```bash
climier context T-x                      # spec + blockers + scoped knowledge FIRST
climier take T-x --as <agent>            # atomic claim; NOT_READY if blocked/claimed
# ... do the work ...
climier submit T-x --note "evidence summary" --as <agent>
```

### Validator (only accepted work unblocks)

```bash
climier accept T-x --as <validator>      # -> done; unblocks dependents
climier reject T-x --reason "gap" --as <validator>   # -> back to open
```

### Recovery

```bash
climier release T-x --as orchestrator    # free a stale claim
climier reopen T-x --reason "..." --as orchestrator  # wrong done -> open
climier cancel T-x --reason "..." --as <agent>
climier status / context / history <id> / log
```

## Invariants (load-bearing)

- `ready` and `blocked` are **derived** from dependencies; never hand-written.
- **`submitted` never unblocks dependents** — only `accept` (→ `done`) does.
  This is the whole point: a worker's report is a claim, not a verdict.
- Only blockers in `done`/archived satisfy dependencies.
- Gates block via BLOCKS edges until `resolve --choice --rationale`.
- A cycle or unknown dependency keeps a task blocked; the CLI stays defensive.

## Output contract

JSON-only on stdout, always. Success = the result object (top-level `ok:true`
only exists on `init`); failure = `{ok:false, error:{code, message}}` with
exit 1. **Branch on `error.code`, never on message text** (stable codes:
`NOT_READY`, `ALREADY_CLAIMED`, `ID_CONFLICT`, `CYCLE_DETECTED`,
`STATE_REVISION_CONFLICT`, `STORAGE_ERROR`, ...). Errors go to stdout, not
stderr.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `take: node X is not ready` (`NOT_READY`) | blocked, claimed, backlog, or open gate | `climier context <id>` + `status` |
| Stale claim blocks progress | worker died | `climier release <id> --as orchestrator` |
| Done by mistake | wrong accept | `climier reopen <id> --reason ...` |

## When NOT to use climier

- Single linear task with no dependencies, decisions, or parallel actors — a
  todo list is enough.
- Anything requiring execution/scheduling — climier only records state.
- Secrets or large blobs — tasks hold short text (body/acceptance/notes);
  point at files instead.

Full command reference: [`references/commands.md`](./references/commands.md).
Upstream docs: the climier repository's `README.md` and `docs/reference.md`.
