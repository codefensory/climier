---
name: climier
description: Use this skill when a climier task, gate, knowledge node, task graph, claim, worker, validator, or other Climier operation is already in scope. Climier coordinates tracked work through a machine-local v2 state file, atomic claims, and a structured error surface.
---

# climier — graph harness for multi-agent workflows

Climier is the coordination layer for tracked work in this repository. State lives at `~/.climier/projects/<project_id>/tasks.json` (global, machine-local, NOT in the repo and NOT under git's purview). The repo only commits `.climier.json`, which pins the `<project_id>` that resolves to that state file. Storage is **v2**: a graph of `nodes` (tasks, gates, knowledge) and typed `edges` (`BLOCKS`, `SUPERSEDES`, `DERIVED_FROM`). Workers claim one task at a time with an atomic file lock; the orchestrator reads `status` and delegates via `context` + `take` + `resolve`.

## When to use this skill

- The user asks you to "work on the next task", "take a task", "what's the next thing".
- A new agent session opens and you need to orient without prior context.
- Multiple agents need to work in parallel without stepping on each other.
- A task is blocked by an open gate and you need to resolve it.
- You're acting as an orchestrator (delegating) instead of a worker (executing).
- The user or principal agent decided to represent the work in Climier.

## The 7 rules (read first, never violate)

1. **Never edit `~/.climier/projects/<project_id>/tasks.json` by hand.** Use climier commands. The state is owned by the script.
2. **Take ONE task at a time.** `take` is exclusive. If you need two, take one, resolve, then take the other.
3. **Never `resolve` without verifying the work.** The acceptance criteria from `context <id>` are the contract.
4. **If you can't finish, `release` and leave a note — never just abandon.** Abandoned claims go stale and block others. There is no v2 `block`; an escalation is `add-note "blocked: ..."` plus either `release` or a handoff to the orchestrator.
5. **Identify yourself with `--as <agent-id>` on every mutating command.** Use a stable id (e.g. `claude-auth`, `pi-frontend`).
6. **Read the scoped knowledge and gate resolutions that `context` shows you.** They are domain traps the team has already paid for; ignore them at your own risk.
7. **Run `context <id>` before `take <id>`.** It's a read-only pre-flight: spec + knowledge + blockers + `allowed_actions` + a GO/NO-GO verdict via `derived_status`. Cheaper than discovering the task is blocked (or already taken) after you've claimed it.

## The 7 commands you need (worker)

`--project .` is the default. From inside a project, you can omit it. Use `--project <path>` only when invoking climier from outside the project root.

```bash
# 1. Orient yourself
climier status

# 2. Pre-flight: spec + knowledge + blockers + allowed_actions (read-only)
climier context <id>

# 3. Take ONE task (idempotent — re-running with the same --as is a no-op)
climier take <id> --as <your-agent-id>

# 4. Re-read the spec now that you own it (shows the same context with claim + revision)
climier context <id>

# 5. Close it (REQUIRED: a note describing what you did)
climier resolve <id> --note "what you shipped, in one line" --as <your-agent-id>

# 5b. Required post-worker audit
#     After every resolve, run an independent validator using the climier-validator skill.
#     The validator returns PASS/FAIL/BLOCKED and reports follow-up work to the orchestrator.

# 6a. If you can't finish and want another agent to take it
climier release <id> --as <your-agent-id>

# 6b. If you need the orchestrator to unblock you
climier add-note <id> "blocked: <what you need to proceed>" --as <your-agent-id>
climier release <id> --as <your-agent-id>   # then hand off

# 7. Refine the spec (anytime, except when you own the claim)
#    Use --body to attach the long-form spec, --definition/--acceptance to
#    update metadata. Optimistic concurrency via --if-revision N.
climier update <id> --body "## Spec\n\nThe full design lives in..." --as <your-agent-id>

# 8. Leave a timestamped note (any status, append-only)
climier add-note <id> "tried approach X, hit Y; switching to Z" --as <your-agent-id>
```

## Editing vs. closing: when to use which

`update` and `add-note` are for keeping the spec and the trail alive while work is in progress. Different semantics, different permissions:

- **`update` (any agent)**: edit a node's *spec* (`--title`, `--body`, `--definition`, `--acceptance`, `--domain`, `--backlog`, `--meta`, `--scope-*`, `--tags`, `--refs`, etc.). Bumps `revision`. Add `--if-revision N` to reject the update if the stored revision differs (cheap optimistic concurrency). Common use: orchestrator refining a task before delegating, or any agent cleaning up a stale spec.
- **`add-note` (any agent)**: append a timestamped `{ts, agent, text}` entry to the node's `notes[]` thread. Any status. Append-only by design. Common use: workers leaving breadcrumb findings during a task; orchestrator adding context for future readers; the user leaving a comment on anything.

If a worker discovers the spec is wrong while they're `in_progress`, they can't `update` the claim-protected fields freely (revision will bump under them). The right move is `add-note` with the proposed change, then `release` so the orchestrator can `update` and ask the worker to re-take. The orchestrator can also use `--if-revision` to coordinate concurrent edits without losing changes.

## The orchestrator view (when you're delegating, not executing)

```bash
# Who's holding what, what's blocked, what's stale
climier status

# Read a task in agent-first shape (the delegation message uses this)
climier context <id>

# What decisions (gates) are open and blocking tasks
climier status                       # summary.open_gates

# Resolve a gate to unblock dependents
climier resolve <G> --choice "<chosen path>" --rationale "<why>" --as orchestrator

# Roll back a wrong "resolve" (orchestrator escape hatch)
climier reopen <id> --reason "<what's wrong>" --as orchestrator
```

When you delegate, tell the worker the **task id** and their **agent id**:
> "agent-claude-auth: `climier take T-auth-validate --as claude-auth`. Then `climier context T-auth-validate` to read the spec."

After a worker resolves a task, stalls, gets cancelled, or leaves an ambiguous state, run an independent `climier-validator` pass before treating the task as safe for downstream work. The validator must find the task worktree from `WORKTREE` notes or from `git worktree list` entries containing the task id. If it returns `PASS`, it merges the branch with `--no-ff` and leaves a `VALIDATION PASS ... merged=true` note. If it returns `FAIL`, create a new climier task from its follow-up report and assign a worker to the same worktree/branch. If it returns `BLOCKED`, resolve the missing evidence before continuing.

## Storage

- `<project-root>/.climier.json` — the repo-committed file pinning the `project_id`.
- `~/.climier/projects/<project_id>/tasks.json` — the global state file. NOT in the repo. NOT under git's purview.
- `.climier.json` is the only file climier-related in the repo. The state file is machine-local; backups are the operator's responsibility.
- Multiple machines with the same repo checkout share the `.climier.json` but each have their own state file (this is by design — agents are local processes, state is the shared truth on the host that runs them).

State shape (v2): `{ version: 2, initiatives, nodes, edges, log }`.

- `nodes`: tasks (resolvable labor), gates (resolvable decisions/approvals/external deps/research), knowledge (durable facts).
- `edges`: typed (`BLOCKS`, `SUPERSEDES`, `DERIVED_FROM`). Only `BLOCKS` affects readiness — `to` is blocked by `from`. The CLI surfaces `BLOCKS` from the dependent's POV as `--blocked-by`: `--blocked-by G-y` means "this node is blocked by G-y", and stores the canonical edge `{from: "G-y", to: <this node>, type: "BLOCKS"}`.
- `log`: append-only audit trail (`{ ts, agent, action, node, ... }`).

## Setup (first time only)

If `climier` is not on PATH:

```bash
# From the climier repo
cd ~/Dev/climier && npm link
```

If `~/.climier/projects/<project_id>/tasks.json` does not exist yet (no agent has run `init` from this repo on this machine):

```bash
# v2 state (the only schema this repository uses)
climier init --v2
```

`init` no longer accepts a `--seed` flag (removed in climier 1.0). To bootstrap with example tasks/gates/knowledge, use `climier add-initiative` → `climier add-task` → `climier add-gate` → `climier add-knowledge`. Storage is NOT in the repo and NOT under git's purview. It lives in `~/.climier/projects/<id>/`. The repo only commits `.climier.json`.

## Errors: structured shape

Every climier error is JSON to stdout, exit code 1. v2 errors carry a code + details so callers can branch without parsing prose:

```bash
$ climier take T-auth-7 --as ghost-agent
{
  "ok": false,
  "error": {
    "code": "ALREADY_CLAIMED",
    "message": "take: node T-auth-7 is claimed by claude-auth",
    "details": { "id": "T-auth-7", "owner": "claude-auth" }
  }
}
```

The codes an agent will see:

- `NODE_NOT_FOUND` — id doesn't exist in `nodes`.
- `INITIATIVE_NOT_FOUND` — `--initiative` wasn't registered via `add-initiative` first.
- `ID_CONFLICT` — `add-task`/`add-gate`/etc. tried to use an existing id.
- `MISSING_FIELD` / `MISSING_AGENT` — required flag absent.
- `NOT_READY` / `NOT_CLAIMABLE` / `ALREADY_CLAIMED` — `take` rejected for that reason.
- `NOT_OWNER` — `release`, `resolve`, `cancel`, or `reopen` rejected because the caller isn't the claim/done owner (and isn't orchestrator/recovery).
- `INVALID_STATUS` — node isn't in a status that allows this transition (e.g. `resolve` on an `open` task, `reopen` on a `resolved` gate without the right authority).
- `REVISION_CONFLICT` — `update --if-revision N` failed because the stored revision differs.
- `INVALID_EDGE_TYPE` / `INVALID_EDGE_KIND` / `SELF_EDGE` / `CYCLE_DETECTED` / `DUPLICATE_EDGE` / `INVALID_EDGE_TARGET` — edge problems.

Branch on `error.code`, not on `error.message`.

## Edge direction

The CLI phrases edges from the dependent's point of view: `--blocked-by G-y` means "this node is blocked by G-y". Internally the edge is stored canonically as `from: G-y, to: <this node>, type: BLOCKS`. The `from BLOCKS to` reading is: **to is BLOCKED-BY from**. The CLI never asks for `--blocks` — only `--blocked-by`. `SUPERSEDES` and `DERIVED_FROM` keep the user-supplied direction (the new node is `from`, the older node is `to`).

## The orchestrator loop (v2)

```text
status  → see who has what, what's blocked, what's stale, what gates are open
context <id> → read a candidate task before delegating
delegate  → "agent-X, take T-Y, then context T-Y"
[wait for resolve]
reopen or release → only on rollback / stuck-claim recovery
resolve <G> --choice --rationale → unblock downstream via gates
```

## Common pitfalls

- **Taking a task whose deps aren't resolved.** Symptom: `take: node T is open, not ready` (NOT_READY) or, more commonly, the node just doesn't appear in `status` `ready` bucket. Run `climier context <id>` to see `blocking[]` — every unsatisfied blocker is listed there with kind/status.
- **`resolve` without `--note`.** Climier requires `--note` on every task resolve; the note is the audit trail. Write what you shipped, not "ok" or "done". Gates use `--choice` + `--rationale` instead.
- **`resolve` from a different agent than `take`.** The agent that took must also resolve. If the original agent is gone, see "Recovery" below.
- **Two agents trying to `take` the same task.** One wins, the other gets `ALREADY_CLAIMED`. This is the lock working. Pick another task from `status` `ready` bucket.
- **Stale claims in `status`.** A claim older than 2h is stale (configurable via `--stale-ms`). The orchestrator should `release` it and let another worker take it. `context <id>` shows `claim.stale: true` for any task you inspect.
- **Forgot `--as`.** All mutating commands (`take`, `resolve`, `release`, `reopen`, `cancel`, `update`, `add-note`, `add-task`, `add-gate`, `add-knowledge`, `deprecate-knowledge`) require `--as`. The CLI throws `MISSING_AGENT` with a structured details object.
- **`update` while a task is `in_progress`.** It's allowed, but the revision bumps under the worker. If you need to coordinate, use `--if-revision N` or leave a note and ask the worker to `release` first.
- **Boolean flags before the command.** `climier --force init` is interpreted as `--force=init` (the parser consumes the next non-flag as the flag's value). Use `climier --force=true init` or put the flag after the command. The same applies to any boolean flag: if a flag is meant as a switch, use `--flag=true` when the command comes right after.

## Recovery (when a worker dies or a claim is stuck)

The default rule: only the claimer can `release` their own task. Escape hatches:

- **`release` by `orchestrator` or `recovery`**: anyone with `--as orchestrator` (or `--as recovery`) can release any `in_progress` task — even if claimed by another agent. Use this when:
  - The original agent is gone and the claim is stuck.
  - You need to reassign work mid-flight.
  - The task is orphaned (in_progress with no `claim.by`).

  ```bash
  climier release <id> --as orchestrator
  ```

  The task returns to `open` (v2 surfaces the bucket as `ready` when nothing else blocks it) and any other agent can `take` it. `release` is idempotent: running it on an unclaimed task returns `{ released: false, node }` with no state mutation.

- **`reopen` is the analogous escape hatch for `resolve`.** See "Correcting a wrong resolve" below.

- **`init --force`**: overwrites a corrupt or stale state file. Use only when you're sure; it deletes the current state and re-creates an empty one.

  ```bash
  climier init --v2 --force   # full reset to empty v2 state
  ```

- **There is no v2 `block`.** Escalation is `add-note "blocked: ..."` plus either `release` or a handoff to the orchestrator. The orchestrator can `release` the claim (which clears it), but cannot set a "block_reason" on a v2 task — that pattern was a v1 thing.

## Correcting a wrong resolve (`reopen`)

When a worker marks a task `done` but the work isn't actually finished (missing edge case, broken integration, missed acceptance criterion), the orchestrator rolls it back. The DAG self-corrects — anything that depended on the resolved task re-derives as blocked.

```bash
# Worker shipped T-auth-7 but the integration test is flaky.
$ climier reopen T-auth-7 --reason "le falta validar el caso de timeout" --as orchestrator
{ "node": { "id": "T-auth-7", "status": "open", "revision": 4, ... } }

# T-api-12 (blocked by T-auth-7) is now blocked again, even though the worker
# had already taken and started it. Review the history before unblocking.
$ climier history T-api-12
```

Authority (mirrors `release`):
- **`orchestrator` (or `recovery`)** — can reopen any `done` task. The escape hatch.
- **The original `done_by` agent** — can self-reopen if they realize their own work was incomplete.
- **Anyone else** — rejected with `NOT_OWNER` (structured error).

Same rules apply to gates: reopen rolls a `resolved` gate back to `open` and clears `resolution`.

When to use `reopen` vs creating a new task:
- **`reopen`** (default): the original task is incomplete; correcting it is "finishing the work", not a different piece of work. The DAG stays clean.
- **New task** (e.g. `T-auth-7-v2`): the correction is structurally different from the original — a v2, a migration, a new approach. Not a retry.

Prefer `reopen`. The DAG is the system's view of reality; don't create a sibling task that leaves dependents unblocked on a foundation that isn't actually done.

## Research pattern (use gates, not tasks, for investigations)

When a task requires investigation before implementation, **don't create a task for the research**. Register a gate instead. The gate is the research; the rationale is the summary; the chosen path is the choice.

Use `docs/` for general project documentation that is not itself a climier node body. Use `.decisions/<gate-id>.md` only for the research file that backs a specific gate.

```bash
# 1. Register the gate (open)
climier add-gate D9 --initiative research --title "investigar auth library" \
  --body "Read .decisions/D9.md for the full comparison once written." \
  --purpose decision

# 2. Do the research. Write findings to .decisions/D9.md.

# 3. Close the gate
climier resolve D9 --choice "use Lucia" --rationale "Lucia: no vendor lock-in; see .decisions/D9.md" --as orchestrator

# 4. Create follow-up tasks that block on D9; reference the doc in --body
climier add-task F2.T1 --initiative migration --title "implement Lucia sessions" \
  --body "Read .decisions/D9.md first. Implement per the chosen approach." \
  --acceptance "session validation works end-to-end; tsc pasa" \
  --blocked-by D9
```

Tasks stay blocked until `D9` is resolved. When a worker claims one, `context` shows the `Read .decisions/D9.md first.` line in the body — workers read the doc before starting.

Why a gate, not a task: gates have a `purpose` (`decision`, `approval`, `external-dependency`, `research`) that maps naturally to "research findings + chosen approach", they resolve with a `--choice` + `--rationale` (which discourages trivial research), and the choice becomes a permanent record of *why* we picked one path.

Gates have no claim lifecycle — anyone with `--as` can `resolve` a gate. Use `add-gate --supersedes <old-id>` to retire an older gate atomically (the old gate becomes `superseded`, downstream `BLOCKS` edges are rewired to the new gate).

## Quick reference

Every command prints a single JSON value to stdout. There is no `--json` flag (it was removed in v0.2) and no text mode. Agents parse the JSON directly; humans pipe through `jq`.

| Command | Purpose | Requires `--as` |
|---|---|---|
| `status [--initiative X] [--kind task\|gate\|knowledge] [--claimed-by X] [--stale-ms N] [--limit N] [--all]` | Global view: `summary` (ready/in_progress/blocked/backlog/open_gates/active_knowledge), task buckets, open gates, stale-claim alerts. `--all` adds done/canceled/resolved/superseded/deprecated. | no |
| `context <id> [--as X] [--staleMs N]` | Agent-first view: `node`, `derived_status`, `revision`, `claim`, `blocking[]`, `knowledge[]` (scoped), `informing[]`, `alerts[]`, `allowed_actions[]`. Replaces v1 `next` + `pre-claim`. | no (optional `--as` to scope `allowed_actions`) |
| `show <id>` | Print the raw node by id. Returns `{ type, node }`. | no |
| `history <id> [--limit N]` | Log entries that reference a node (v2) or task (v1). | no |
| `search "<query>" [--all]` | Search active v2 knowledge by id/title/body/mitigation/domain/tags/refs/meta. `--all` includes deprecated. | no |
| `initiatives [--all]` | List registered initiatives with usage counts. `--all` includes zero-node initiatives. | no |
| `log [--limit N] [--action X] [--agent X] [--task X] [--decision X]` | Show the audit log, filterable. v2 logs use `node:` (not `task:`/`decision:`). | no |
| `take <id> --as <agent>` | Idempotently claim exactly one v2 task. Sets `claim.by`, increments `revision`. | yes |
| `resolve <id> --note "<text>" --as <agent>` | Close a task as done. `--choice` + `--rationale` close a gate. | yes |
| `release <id> --as <agent>` | Free a task's claim without resolving. `orchestrator`/`recovery` can release any agent's claim. Idempotent. | yes |
| `reopen <id> --reason "<text>" --as <agent>` | Roll a `done` task back to `open`; downstream tasks re-block. `orchestrator`/`recovery` can reopen any task; the original `done_by` can self-reopen. Same rules for resolved gates. | yes |
| `cancel <id> --reason "<text>" --as <agent>` | Terminate a node without resolving (open/in_progress only). Claim owner or `orchestrator`/`recovery`. | yes |
| `update <id> [--title X] [--body "..."] [--definition "..."] [--acceptance "..."] [--domain Y] [--backlog true\|false] [--scope-* ...] [--meta '{...}'] [--if-revision N] --as <agent>` | Edit a node. Bumps `revision`. `--if-revision N` for optimistic concurrency. | yes |
| `add-note <id> "<text>" --as <agent>` | Append a timestamped note to the node's `notes[]` thread. Any status. Append-only. | yes |
| `add-task [id] --initiative X --title "..." --body "..." --acceptance "..." --blocked-by A,B [--definition ...] [--domain ...] [--backlog true] --as <agent>` | Add a task. v2 requires `--body`, `--acceptance` and `--blocked-by` (pass `--blocked-by ""` for none). Omit `id` to auto-allocate (`T-xxxxxxxx`). | yes |
| `add-gate [id] --initiative X --title "..." --body "..." --purpose decision\|approval\|external-dependency\|research [--blocked-by A,B] [--supersedes OLD] --as <agent>` | Add a gate (decision/approval/research/etc). `--supersedes OLD` rewires downstream BLOCKS edges and marks the old gate superseded atomically. | yes |
| `add-knowledge [id] --initiative X --title "..." --body "..." [--scope-domains X] [--scope-initiatives X] [--scope-tags X] [--scope-node-ids X] [--mitigation "..."] [--supersedes OLD] --as <agent>` | Register a knowledge node. At least one `--scope-*` is required. | yes |
| `add-initiative <name> [--desc "..."] --as <agent>` | Register an initiative. v2 rejects duplicates with `ID_CONFLICT`. | yes |
| `deprecate-knowledge <id> --reason "<text>" --as <agent>` | Soft-delete a knowledge node (`status="deprecated"`). | yes |
| `add-node <id> --kind resolvable\|knowledge --title "..." [--subkind task\|gate] [--blocked-by A,B] [--derived-from A,B] [--refs a,b] [--meta '{...}'] [--initiative X] ...` | Escape hatch: low-level node creation. Prefer `add-task` / `add-gate` / `add-knowledge`. | yes |
| `add-edge <from> <to> --type BLOCKS\|SUPERSEDES\|DERIVED_FROM --as <agent>` | Escape hatch: low-level edge CRUD. Rejects self-edges, cycles, duplicates. | yes |
| `init [--force] [--v2]` | Create `.climier.json` and the project's live state. `--v2` creates the v2 graph schema. The `--seed` flag was removed in climier 1.0. | no |

## Output: JSON only

Every command prints a single JSON value to stdout. There is no `--json` flag and no text mode. Agents parse the JSON directly; humans pipe through `jq`.

```bash
# What an agent receives on stdout
$ climier status | jq '.summary'
{ "ready": 4, "in_progress": 1, "blocked": 7, "backlog": 2, "open_gates": 2, "active_knowledge": 5 }

# What a human sees when reading
$ climier status | jq '.tasks.ready[].id'
"T-auth-7"
"T-api-12"
...
```

Errors are JSON too (see "Errors: structured shape" above).

The convention for return shapes is principled (stable across versions):

| Command type | Shape | Examples |
|---|---|---|
| Read commands | Raw data (object/array) | `status` → `{ summary, tasks, gates, knowledge_count, alerts }`, `context` → `{ node, derived_status, claim, blocking, knowledge, alerts, allowed_actions }`, `show` → `{ type, node }` |
| Write commands | `{ entity }` envelope | `take` → `{ node, context, freshly_claimed }`, `resolve` → `{ node, newly_ready }`, `add-task` → `{ task }`, `add-gate` → `{ node }`, `add-knowledge` → `{ node }`, `update` → `{ node }` |
| `init` | `{ ok, seeded, file }` | (not entity-creating) |

Agent pattern:

```bash
# Read → take the first id
id=$(climier status | jq -r '.tasks.ready[0].id')

# Write → check the returned entity
node_id=$(climier take "$id" --as my-agent | jq -r '.node.id')

# Error → branch on the code, not the message
if ! climier take T-auth-7 --as alice >/dev/null 2>&1; then
  err=$(climier take T-auth-7 --as alice 2>&1 | jq -r '.error.code')
  case "$err" in
    NOT_READY) ;;              # blocked, try another
    ALREADY_CLAIMED) ;;        # someone else has it
    NODE_NOT_FOUND) ;;         # id doesn't exist
  esac
fi
```

## If the JSON gets corrupted or out of sync

`readState` returns `null` when the file is missing. To rebuild from scratch:

```bash
# Backup first (the state file is at ~/.climier/projects/<id>/tasks.json)
cp ~/.climier/projects/<project_id>/tasks.json ~/.climier/projects/<project_id>/tasks.json.bak

# Reset (only if you're sure; this loses log entries)
climier init --v2 --force
# Then re-take / re-resolve the in-progress tasks you need
```

The CLI also auto-recovers a corrupt JSON on `init --force` (or even without `--force` if the existing state is unreadable). Always backup first.

## Examples

See `examples/` in this skill:

- `examples/worker-flow.md` — end-to-end worker session: status → context → take → resolve.
- `examples/orchestrator-delegation.md` — orchestrator reading `status`, delegating to 2 workers, resolving a gate.
- `examples/concurrent-claims.md` — what happens when 2 agents race for the same task (the file lock).