---
name: climier
description: Use this skill when a Climier task, gate, knowledge node, task graph, claim, or other Climier operation is already in scope. Climier coordinates the DAG through a machine-local state file, atomic mutations, and a structured error surface; in Pi, task execution uses the `climier_flow` extension tool.
---

# climier — graph harness for multi-agent workflows

Climier is the DAG coordination layer for tracked work in this repository. State lives at `~/.climier/projects/<project_id>/tasks.json` (global, machine-local, NOT in the repo and NOT under git's purview). The repo only commits `.climier.json`, which pins the `<project_id>` that resolves to that state file. Storage is a graph of `nodes` (tasks, gates, knowledge) and typed `edges` (`BLOCKS`, `SUPERSEDES`, `DERIVED_FROM`). Operators use Climier to create, read, and curate that graph. In Pi, execution is launched through the `climier_flow` extension tool; its internal claim, worktree, implementation, review, lifecycle, commit, merge, and cleanup stages are not manual operator actions.

## When to use this skill

- The user asks you to execute the next task or asks "what's the next thing".
- A new operator session opens and you need to orient without prior context.
- Multiple executions need DAG coordination without stepping on each other.
- A task is blocked by an open gate and you need to resolve it.
- You need to create, read, or curate a task, gate, knowledge node, or dependency.
- The user or principal agent decided to represent the work in Climier.

## The 7 rules (read first, never violate)

1. **Never edit `~/.climier/projects/<project_id>/tasks.json` by hand.** Use Climier commands. The state is owned by the script.
2. **Run ONE task at a time.** In Pi, call `climier_flow` with `action: "run"`; do not start a second run for the same task.
3. **Never use `resolve` to close a task.** `resolve` is for gates and requires its choice and rationale. The runner owns task lifecycle transitions during execution.
4. **Recover interrupted execution through the Pi tool.** Call `climier_flow` with `action: "status"`, then `action: "resume"` with the optional `summary` when a checkpoint is available. The tool does not expose restart; do not fall back to shell. Ask for tool support if a non-completed attempt must be restarted. Do not manually reproduce internal stages.
5. **Identify yourself with `--as <agent-id>` on every mutating Climier command.** Use a stable id (e.g. `claude-auth`, `pi-frontend`).
6. **Read the scoped knowledge and gate resolutions that `context` shows you.** They are domain traps the team has already paid for; ignore them at your own risk.
7. **Run `context <id>` before calling `climier_flow` with `action: "run"`.** It's a read-only pre-flight: spec + knowledge + blockers + alerts + `allowed_actions` + a GO/NO-GO verdict via `derived_status`.

## Operator commands

`--project .` is the default. From inside a project, you can omit it. Use `--project <path>` only when invoking Climier from outside the project root.

Use Climier for DAG management and the Pi `climier_flow` extension tool for execution. In the tool-call examples below, `climier_flow` is the tool name and the JSON object is its arguments:

```bash
# Read the graph and the task contract
climier status
climier context <id>
climier show <id>
climier search "<query>"

# Create or curate tasks, gates, knowledge, and notes
climier add-initiative <name> --as <agent>
climier add-task <id> ... --as <agent>
climier add-gate <id> ... --as <agent>
climier add-knowledge <id> ... --as <agent>
climier update <id> ... --as <agent>
climier add-note <id> "..." --as <agent>
climier resolve <gate-id> --choice "..." --rationale "..." --as <agent>
```

Call the Pi tool `climier_flow` once per task with one of these argument objects (run/resume launch in the background):

```json
{ "action": "run", "task_id": "<id>" }
{ "action": "status", "task_id": "<task-id>" }
{ "action": "resume", "task_id": "<task-id>", "summary": "<optional checkpoint context>" }
{ "action": "list" }
```

The tool's `status` and `list` actions read saved run manifests; `list` is global and does not show DAG readiness. `run` and `resume` return a launch confirmation, while the live widget shows progress. `run` uses Pi's current directory by default; pass the optional `repo` argument to target a different checkout. The runner internally performs claim, worktree, implementation, review, lifecycle, commit, merge, and cleanup. The operator does not call those stages separately.

## Editing vs. closing: when to use which

`update` and `add-note` are for keeping the spec and the trail alive while work is in progress. Different semantics, different permissions:

- **`update` (any agent)**: edit a node's *spec* (`--title`, `--body`, `--definition`, `--acceptance`, `--domain`, `--backlog`, `--meta`, `--scope-*`, `--tags`, `--refs`, etc.). Bumps `revision`. Add `--if-revision N` to reject the update if the stored revision differs (cheap optimistic concurrency). Common use: refining a task before execution, or cleaning up a stale spec.
- **`add-note` (any agent)**: append a timestamped `{ts, agent, text}` entry to the node's `notes[]` thread. Any status. Append-only by design. Common use: recording context for future readers, attaching operator evidence, or leaving a comment on anything.

If the execution contract is wrong, add a note with the proposed change and update it before running or restarting. Use `--if-revision` to coordinate concurrent edits without losing changes; the runner owns claim-protected lifecycle fields.

## DAG curator view

```bash
# What's ready, blocked, stale, or gated
climier status

# Read the task contract before execution
climier context <id>

# Resolve a gate to unblock dependents
climier resolve <G> --choice "<chosen path>" --rationale "<why>" --as <agent>

# Administrative DAG correction when needed (not runner recovery)
climier reopen <id> --reason "<what's wrong>" --as <agent>
```

Use the Pi `climier_flow` tool for execution and recovery, as mapped above; never use shell Flow commands. The extension does not expose restart. Do not delegate implementation or validation stages manually. The runner owns those stages; Climier remains the source of truth for the DAG and its curation.

## Storage

- `<project-root>/.climier.json` — the repo-committed file pinning the `project_id`.
- `~/.climier/projects/<project_id>/tasks.json` — the global state file. NOT in the repo. NOT under git's purview.
- `.climier.json` is the only file climier-related in the repo. The state file is machine-local; backups are the operator's responsibility.
- Multiple machines with the same repo checkout share the `.climier.json` but each have their own state file (this is by design — agents are local processes, state is the shared truth on the host that runs them).

State shape: `{ version: 3, initiatives, nodes, edges, log }`.

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
# default state (the only schema this repository uses)
climier init
```

`init` no longer accepts a `--seed` flag (removed in climier 1.0). To bootstrap with example tasks/gates/knowledge, use `climier add-initiative` → `climier add-task` → `climier add-gate` → `climier add-knowledge`. Storage is NOT in the repo and NOT under git's purview. It lives in `~/.climier/projects/<id>/`. The repo only commits `.climier.json`.

## Errors: structured shape

Every climier error is JSON to stdout, exit code 1. Errors carry a code + details so callers can branch without parsing prose:

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
- `POLICY_DENIED` — an installed policy plugin rejected an otherwise state-valid mutation.
- `INVALID_STATUS` — node isn't in a status that allows this transition (e.g. `accept` on an `open` task, `resolve` on a resolved gate).
- `REVISION_CONFLICT` — `update --if-revision N` failed because the stored revision differs.
- `INVALID_EDGE_TYPE` / `INVALID_EDGE_KIND` / `SELF_EDGE` / `CYCLE_DETECTED` / `DUPLICATE_EDGE` / `INVALID_EDGE_TARGET` — edge problems.

Branch on `error.code`, not on `error.message`.

## Edge direction

The CLI phrases edges from the dependent's point of view: `--blocked-by G-y` means "this node is blocked by G-y". Internally the edge is stored canonically as `from: G-y, to: <this node>, type: BLOCKS`. The `from BLOCKS to` reading is: **to is BLOCKED-BY from**. The CLI never asks for `--blocks` — only `--blocked-by`. `SUPERSEDES` and `DERIVED_FROM` keep the user-supplied direction (the new node is `from`, the older node is `to`).

## The operator loop

```text
climier status → see what's ready, blocked, stale, and which gates are open
climier context <id> → read the task contract, knowledge, blockers, and alerts
climier update/add-* → curate the DAG when the contract needs changes
climier_flow(action: "run", task_id: <id>) → launch one task through the runner
climier_flow(action: "status", task_id: <id>) → inspect its saved run report
climier_flow(action: "resume", task_id: <id>, summary?: <text>) → continue a checkpoint
climier_flow(action: "list") → list saved runs globally
climier resolve <G> --choice --rationale → unblock downstream via a gate
```

## Common pitfalls

- **Running a task whose dependencies are unresolved.** If the node is not `ready`, read `climier context <id>` and inspect `blocking[]` before running it.
- **Using Climier lifecycle commands as execution steps.** `take`, `submit`, `accept`, and `reject` are internal to the runner for normal execution; invoke the Pi `climier_flow` tool with `action: "run"` instead.
- **Using `resolve` on a task.** Tasks do not use `resolve`; it is exclusively for gates with `--choice` and `--rationale`.
- **Starting duplicate execution.** Call `climier_flow` with `action: "status"` before starting another attempt for a task.
- **Recovering without the runner.** Use `climier_flow` with `action: "resume"` when a checkpoint is resumable; restart is not exposed by the Pi Flow tool, so do not invoke it through shell. Never recreate a claim, worktree, review, or merge manually.
- **Forgetting `--as`.** Mutating Climier commands (`resolve` for gates, `update`, `add-note`, `add-task`, `add-gate`, `add-knowledge`, and similar DAG curation commands) require `--as`. The CLI throws `MISSING_AGENT` with a structured details object.
- **`update` during an execution.** It is allowed only when the contract needs correction; use `--if-revision N` for optimistic concurrency and let the runner own lifecycle state.
- **Boolean flags before the command.** `climier --force init` is interpreted as `--force=init` (the parser consumes the next non-flag as the flag's value). Use `climier --force=true init` or put the flag after the command. The same applies to any boolean flag: if a flag is meant as a switch, use `--flag=true` when the command comes right after.

## Recovery

The Pi extension tool owns Flow interaction:

```json
{ "action": "status", "task_id": "<task-id>" }
{ "action": "resume", "task_id": "<task-id>", "summary": "<optional checkpoint context>" }
```

Check `climier status` and `climier context <task-id>` before and after recovery.
If a runner commit is incomplete after passing review, use the tool's `status`
report to inspect the checkpoint; do not commit or merge manually. Resume once
when the report indicates it is safe. If it still fails, stop at `manual_review`
and ask the Flow owner to reconcile the prompt and parser. Do not repeat the same
resume. Restart is not available through this Pi tool; do not invoke it through
shell. `reopen`, `release`, and `cancel` are explicit DAG-administration actions,
not runner recovery. If the task contract is wrong, curate it with `update` and
request Flow tool support if the attempt needs a fresh start.

## Correcting work after completion

A completed and merged attempt cannot be restarted. The runner rejects it with
`RESTART_REQUIRES_REVIEW`; do not reopen the task to restart its completed flow.
For additional work, preserve the completed task as the audit-of-record and
create a new correction task instead:

```bash
climier add-task T-auth-7-v2 --initiative auth \
  --title "Correct the completed auth work" \
  --body "Describe the additional correction." \
  --acceptance "State the correction's acceptance criteria." \
  --blocked-by T-auth-7 --as orchestrator
```

`reopen` remains available for explicit DAG administration, including gate
corrections; it is not a preparation step for restarting a completed runner
flow. Any task contract correction should be curated before a new execution.

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

Tasks stay blocked until `D9` is resolved. When the operator reads one with `context`, the body shows the `Read .decisions/D9.md first.` line; the Pi `climier_flow` run action then starts the runner with that task contract.

Why a gate, not a task: gates have a `purpose` (`decision`, `approval`, `external-dependency`, `research`) that maps naturally to "research findings + chosen approach", they resolve with a `--choice` + `--rationale` (which discourages trivial research), and the choice becomes a permanent record of *why* we picked one path.

Gates have no claim lifecycle — anyone with `--as` can `resolve` a gate. Use `add-gate --supersedes <old-id>` to retire an older gate atomically (the old gate becomes `superseded`, downstream `BLOCKS` edges are rewired to the new gate).

## Quick reference

Every command prints a single JSON value to stdout. There is no `--json` flag and no text mode. Agents parse the JSON directly; humans pipe through `jq`.

| Command | Purpose | Requires `--as` |
|---|---|---|
| `status [--initiative X] [--kind task\|gate\|knowledge] [--claimed-by X] [--stale-ms N] [--limit N] [--all]` | Global view: `summary` (ready/in_progress/blocked/backlog/open_gates/active_knowledge), task buckets, open gates, stale-claim alerts. `--all` adds done/canceled/resolved/superseded/deprecated. | no |
| `context <id> [--as X] [--staleMs N]` | Agent-first view: `node`, `derived_status`, `revision`, `claim`, `blocking[]`, `knowledge[]` (scoped), `informing[]`, `alerts[]`, `allowed_actions[]`. | no (optional `--as` to scope `allowed_actions`) |
| `show <id>` | Print the raw node by id. Returns `{ type, node }`. | no |
| `history <id> [--limit N]` | Log entries that reference a node. | no |
| `search "<query>" [--all]` | Search active knowledge by id/title/body/mitigation/domain/tags/refs/meta. `--all` includes deprecated. | no |
| `initiatives [--all]` | List registered initiatives with usage counts. `--all` includes zero-node initiatives. | no |
| `log [--limit N] [--action X] [--agent X] [--node X]` | Show the audit log, filterable. Logs use `node:` (not `task:`/`decision:`). | no |
| `resolve <G> --choice "<text>" --rationale "<text>" --as <agent>` | Resolve a gate; tasks never use this command. | yes |
| `reopen <id> --reason "<text>" --as <agent>` | Administrative correction of a task or resolved gate; not runner recovery. | yes |
| `cancel <id> --reason "<text>" --as <agent>` | Administrative termination of a node; not a substitute for runner recovery. | yes |
| Pi tool `climier_flow` with `action: "run"`, `task_id` | Launch one task; the runner owns claim, worktree, implementation, review, lifecycle, commit, merge, and cleanup. | no |
| Pi tool `climier_flow` with `action: "status"`, `task_id` | Inspect the saved runner report for a task. | no |
| Pi tool `climier_flow` with `action: "resume"`, `task_id`, optional `summary` | Resume a checkpointed execution. | no |
| Pi tool `climier_flow` with `action: "list"` | List saved executions globally. | no |
| `update <id> [--title X] [--body "..."] [--definition "..."] [--acceptance "..."] [--domain Y] [--backlog true\|false] [--scope-* ...] [--meta '{...}'] [--if-revision N] --as <agent>` | Edit a node. Bumps `revision`. `--if-revision N` for optimistic concurrency. | yes |
| `add-note <id> "<text>" --as <agent>` | Append a timestamped note to the node's `notes[]` thread. Any status. Append-only. | yes |
| `add-task [id] --initiative X --title "..." --body "..." --acceptance "..." --blocked-by A,B [--definition ...] [--domain ...] [--backlog true] --as <agent>` | Add a task. Requires `--body`, `--acceptance` and `--blocked-by` (pass `--blocked-by ""` for none). Omit `id` to auto-allocate (`T-xxxxxxxx`). | yes |
| `add-gate [id] --initiative X --title "..." --body "..." --purpose decision\|approval\|external-dependency\|research [--blocked-by A,B] [--supersedes OLD] --as <agent>` | Add a gate (decision/approval/research/etc). `--supersedes OLD` rewires downstream BLOCKS edges and marks the old gate superseded atomically. | yes |
| `add-knowledge [id] --initiative X --title "..." --body "..." [--scope-domains X] [--scope-initiatives X] [--scope-tags X] [--scope-node-ids X] [--mitigation "..."] [--supersedes OLD] --as <agent>` | Register a knowledge node. At least one `--scope-*` is required. | yes |
| `add-initiative <name> [--desc "..."] --as <agent>` | Register an initiative. Duplicates are rejected with `ID_CONFLICT`. | yes |
| `deprecate-knowledge <id> --reason "<text>" --as <agent>` | Soft-delete a knowledge node (`status="deprecated"`). | yes |
| `add-node <id> --kind resolvable\|knowledge --title "..." [--subkind task\|gate] [--blocked-by A,B] [--derived-from A,B] [--refs a,b] [--meta '{...}'] [--initiative X] ...` | Escape hatch: low-level node creation. Prefer `add-task` / `add-gate` / `add-knowledge`. | yes |
| `add-edge <from> <to> --type BLOCKS\|SUPERSEDES\|DERIVED_FROM --as <agent>` | Escape hatch: low-level edge CRUD. Rejects self-edges, cycles, duplicates. | yes |
| `init [--force]` | Create `.climier.json` and the project's live state. The `--seed` flag was removed in climier 1.0. | no |

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
| DAG write commands | `{ entity }` envelope | `resolve` (gate) → `{ node, newly_ready }`, `add-task` → `{ task }`, `add-gate` → `{ node }`, `add-knowledge` → `{ node }`, `update` → `{ node }` |
| `init` | `{ ok, seeded, file }` | (not entity-creating) |
| Pi Flow tool `run` / `resume` | Launch confirmation | Background run; inspect progress in the widget or use the tool's `status` action for the saved report |

Operator pattern:

```bash
# Read the DAG and task contract
id=$(climier status | jq -r '.tasks.ready[0].id')
climier context "$id"

# In Pi, invoke the extension tool with these arguments:
{ "action": "run", "task_id": "<id>" }
{ "action": "status", "task_id": "<task-id>" }
{ "action": "resume", "task_id": "<task-id>", "summary": "<optional>" }
{ "action": "list" }
```

The run/resume tool response only confirms background launch; use the widget
or the `status` action to inspect progress. Branch on `error.code`, not on the
message, in Climier errors. The extension does not expose restart.

## If the JSON gets corrupted or out of sync

`readState` returns `null` when the file is missing. To rebuild from scratch:

```bash
# Backup first (the state file is at ~/.climier/projects/<id>/tasks.json)
cp ~/.climier/projects/<project_id>/tasks.json ~/.climier/projects/<project_id>/tasks.json.bak

# Reset (only if you're sure; this loses log entries)
climier init --force
# Then inspect the DAG and use the Pi climier_flow tool's status/resume actions
```

The CLI also auto-recovers a corrupt JSON on `init --force` (or even without `--force` if the existing state is unreadable). Always backup first.

## Examples

See `examples/` in this skill:

- `examples/task-execution.md` — unified execution session: context → Pi Flow tool → background progress and recovery.
- `examples/dag-curation.md` — graph curation and gate resolution without manual execution stages.
- `examples/claim-serialization.md` — lock and claim behavior owned by the runner.