# Orchestrator delegation — reading `status` and assigning work

The orchestrator does NOT execute. It reads state, decides, and tells workers what to take.

## The orchestrator's only loop

```bash
1. status    → see who has what, what's blocked, what's stale, what gates are open
2. context <id>  → read a candidate task before delegating
3. resolve <G> --choice --rationale  → close any gate whose dependent tasks are waiting
4. (delegate to workers) → "agent-X, take T-Y, then context T-Y"
5. wait for submit → validator accepts or rejects the submitted task
```

## Example: 3 workers, 2 in parallel

```bash
$ climier status | jq '.tasks.ready[] | {id, domain}'
{
  "id": "T-api-1",
  "domain": "api"
}
{
  "id": "T-shared-2",
  "domain": "shared"
}
```

The orchestrator sees 2 ready tasks with different domains:
- `T-api-1` — domain: api
- `T-shared-2` — domain: shared

The orchestrator delegates:

> "**agent-claude-api**, take `climier take T-api-1 --as claude-api` and read `climier context T-api-1`.
>
> **agent-claude-shared**, take `climier take T-shared-2 --as claude-shared` and read `climier context T-shared-2`.
>
> I'll close D1 now so the dependent phases can be decomposed when you both finish."

```bash
# Orchestrator resolves a gate that unblocks downstream
$ climier resolve D1 --choice "raw-postgres" --rationale "skip Directus, fewer moving parts" --as orchestrator
{ "node": { "id": "D1", "status": "resolved", "resolution": { "choice": "raw-postgres", "rationale": "..." } }, "newly_ready": ["T-db-1", "T-db-2"] }
```

After both workers `submit` their tasks and validators accept them, the orchestrator re-runs `status` and sees new tasks are ready.

## When to resolve a gate

A gate is ready to resolve when:
- The choice is **reversible enough** (you can pivot later if wrong), or
- The team has enough information to commit.

Don't resolve gates prematurely — once resolved, dependent tasks unblock and workers will start on them.

## When NOT to be the orchestrator

If you're a worker agent and the user says "implement X", you are NOT the orchestrator. Run `climier status`, take one, do it, and submit it. The orchestrator role is explicit; don't mix it with coordination.

## Stale claim recovery

```bash
$ climier status --all | jq '.alerts'
[
  { "kind": "stale-claim", "task_id": "T-shared-2", "claimed_by": "ghost-agent-3", "age_ms": 9300000, "message": "..." }
]
```

`ghost-agent-3` no longer exists. Orchestrator frees the claim:

```bash
$ climier release T-shared-2 --as orchestrator | jq '.released'
true
```

Now another worker can `take` it.

## Spawning research as a gate (when you need an investigation first)

When the next chunk of work needs investigation ("evaluate library X", "compare two auth approaches"), the orchestrator registers a gate and a worker runs the research. This keeps research out of the task tree (no "T-RESEARCH" task clutter) and makes the chosen path a permanent record via the gate's `resolution`.

```bash
# Orchestrator: register the gate, leave it open
$ climier add-gate G-ui-transport --initiative climier-ui --title "decidir transporte de la UI" \
    --body "Compare node:http de la stdlib con una dependencia externa. Escribe los hallazgos en .decisions/G-ui-transport.md." \
    --purpose decision --as orchestrator
{ "node": { "id": "G-ui-transport", "title": "decidir transporte de la UI", "status": "open", "purpose": "decision", ... } }

# Delegate the research itself (or do it yourself if you're the only one)
> "agent-claude-research, compare the UI transport options, write findings to .decisions/G-ui-transport.md, then `climier resolve G-ui-transport --choice \"<choice>\" --rationale \"<summary>\" --as claude-research`."

# Worker runs the research, writes the doc, resolves the gate
$ climier resolve G-ui-transport --choice "use node:http" --rationale "The project remains stdlib-only; see .decisions/G-ui-transport.md for the comparison" --as claude-research
{ "node": { "id": "G-ui-transport", "status": "resolved", "resolution": { "choice": "use node:http", ... } }, "newly_ready": ["T-ui-api", "T-ui-static"] }

# Now the follow-up tasks (still blocked on the gate) become ready
$ climier status | jq '.tasks.ready[] | {id, title}'
{
  "id": "T-ui-api",
  "title": "add the local UI read API"
}
{
  "id": "T-ui-static",
  "title": "serve the UI assets"
}
```

Both `T-ui-api` and `T-ui-static` have `--body` starting with "Read .decisions/G-ui-transport.md first." When a worker claims one, `context` surfaces the instruction and they read the document before starting.

This is the canonical pattern when the work is "we don't know yet, go find out". Use it instead of creating a research task.

## Pre-delegation check (optional but recommended)

Before delegating, the orchestrator can run `climier context <id>` to surface the knowledge, blockers, and `allowed_actions`, and include them in the delegation message. The worker still re-reads via `context` themselves, but having the context up front reduces back-and-forth:

```bash
$ climier context T-api-12 | jq '{id: .node.id, derived_status, can_claim, knowledge_ids: [.knowledge[].id], blocking_unsatisfied: [.blocking[] | select(.satisfied == false) | .node.id]}'
{
  "id": "T-api-12",
  "derived_status": "ready",
  "can_claim": true,
  "knowledge_ids": ["K-auth-1", "K-api-3"],
  "blocking_unsatisfied": []
}
```

Then delegate with the knowledge surfaced:

> "**agent-claude-api**, take `climier take T-api-12 --as claude-api`. `climier context T-api-12` will surface K-auth-1 and K-api-3 (scoped knowledge) plus the full body — read both knowledge items and the body before starting."

This is optional — small, well-known tasks don't need it. Use it for tasks with knowledge, cross-team dependencies, or anything where a forgotten finding would burn hours.

## Adding new tasks mid-flight

The orchestrator can grow the DAG without restarting:

```bash
climier add-task T-web-99 \
  --initiative migration \
  --title "Update README with Elysia setup" \
  --body "Document the Elysia + Bun setup. Reference apps/api/AGENTS.md for the runtime contract." \
  --acceptance "README has a 'Local API dev' section with bun + elysia commands" \
  --blocked-by T-api-1 \
  --domain docs
```

The new task appears in `status.tasks.ready` (or `.blocked`) immediately. The orchestrator doesn't need to wait for a phase to close before adding more work.