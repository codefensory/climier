---
name: climier
description: Use this skill to operate the Climier task DAG through the `climier` CLI — create, read, and curate initiatives, tasks, gates, knowledge, dependencies, statuses, and the audit trail. Task execution (claim, worktree, implementation, review, merge, lifecycle) belongs to the external climier-flow runner; see the `climier-flow` skill.
---

# climier — task DAG CLI

Climier is the DAG coordination layer for tracked work in a project. By default, state lives at `~/.climier/projects/<project_id>/tasks.json` (machine-local, NOT in the repo and NOT under git's purview); a project may instead declare a remote backend in `.climier.json`. The repo only commits `.climier.json`, which pins the `<project_id>` and, optionally, the backend that resolves its state. Storage is a graph of `nodes` (tasks, gates, knowledge) and typed `edges` (`BLOCKS`, `SUPERSEDES`, `DERIVED_FROM`).

This skill covers **using the CLI to read and curate the graph**. Executing a task — claim, worktree, implementation, review, lifecycle, commit, merge, and cleanup — is owned by the external `climier-flow` runner and its `climier_flow` Pi tool; use the `climier-flow` skill for that. Climier remains the source of truth for the DAG and its curation.

## When to use this skill

- Create, read, or curate a task, gate, knowledge node, initiative, or dependency.
- See what is ready, blocked, stale, backlog, or gated.
- Resolve a gate so downstream work unblocks.
- Record a note or correct a contract before work starts.
- Orient a new session on the project's tracked work.

## The rules (read first, never violate)

1. **Never edit the live state file by hand.** That is `~/.climier/projects/<project_id>/tasks.json` for the local backend, or the server for a remote backend. Use Climier commands; the state is owned by the script.
2. **Identify yourself with `--as <agent-id>` on every mutating command.** Use a stable id (e.g. `claude-auth`, `pi-frontend`).
3. **Never use `resolve` to close a task.** `resolve` is for gates and requires `--choice` and `--rationale`.
4. **Read the scoped knowledge and gate resolutions that `context` shows you.** They are domain traps the team has already paid for; ignore them at your own risk.
5. **Curate the contract before work starts.** Fix a wrong body or acceptance with `update`; record the reasoning with `add-note`. Use `--if-revision N` for optimistic concurrency.
6. **Register the initiative before building its graph.** `add-task`/`add-gate`/`add-knowledge` fail with `INITIATIVE_NOT_FOUND` otherwise (see Setup).

## Operator commands

`--project .` is the default. From inside a project, you can omit it. Use `--project <path>` only when invoking Climier from outside the project root.

```bash
# Read the graph and a node contract
climier status
climier context <id>
climier show <id>
climier search "<query>"
climier initiatives --all
climier log --limit 20

# Create or curate the graph
climier add-initiative <name> --desc "..." --as <agent>
climier add-task <id> ... --as <agent>
climier add-gate <id> ... --as <agent>
climier add-knowledge <id> ... --as <agent>
climier update <id> ... --as <agent>
climier add-note <id> "..." --as <agent>
climier resolve <gate-id> --choice "..." --rationale "..." --as <agent>
climier reopen <id> --reason "..." --as <agent>
```

## Editing vs. closing: when to use which

`update` and `add-note` are for keeping the spec and the trail alive while work is in progress. Different semantics, different permissions:

- **`update` (any agent)**: edit a node's *spec* (`--title`, `--body`, `--definition`, `--acceptance`, `--domain`, `--backlog`, `--meta`, `--scope-*`, `--tags`, `--refs`, etc.). Bumps `revision`. Add `--if-revision N` to reject the update if the stored revision differs (cheap optimistic concurrency). Common use: refining a task before execution, or cleaning up a stale spec.
- **`add-note` (any agent)**: append a timestamped `{ts, agent, text}` entry to the node's `notes[]` thread. Any status. Append-only by design. Common use: recording context for future readers, attaching operator evidence, or leaving a comment on anything.

## Writing durable DAG content

Climier stores these values as strings. Write human-facing content as Markdown source so headings, lists, links, and code remain structured in the durable record; Climier does not validate or transform Markdown. Keep titles as short, plain-text labels. For other fields, use structure only when it improves scanning—ordinary prose is already valid Markdown.

- Use `body` for task context, intended outcome, scope, and constraints. Keep the independently verifiable completion conditions in `acceptance`; use a short list when there is more than one criterion.
- Apply the same readable structure to gate/knowledge bodies, initiative `desc`, definitions, mitigations, and gate-resolution rationales when they have multiple parts.
- Use `update` to revise the durable contract. Use `add-note` for a concise, append-only progress update, finding, decision rationale, or evidence; do not use a comment to silently replace the contract.
- For a multi-part note, use a brief heading and bullets. Keep one-line updates as one line; do not add decorative Markdown or repeat the whole task spec.
- Pass multiline Markdown as one quoted argument. Preserve the Markdown source; do not flatten it, escape it for display, or hand-edit the state file.

```bash
climier update T-example --body '
## Goal
Describe the outcome and why it is needed.

## Scope
- Include the intended change.
- Exclude unrelated work.
' --as <agent-id>

climier add-note T-example '
### Verification
- `npm test` — passed.

### Follow-up
- The integration check remains outstanding.
' --as <agent-id>
```

## DAG curator view

```bash
# What's ready, blocked, stale, or gated
climier status

# Read a node contract
climier context <id>

# Resolve a gate to unblock dependents
climier resolve <G> --choice "<chosen path>" --rationale "<why>" --as <agent>

# Administrative DAG correction when needed (not runner recovery)
climier reopen <id> --reason "<what's wrong>" --as <agent>
```

Execution of a ready task is not a Climier command; it is launched through the `climier_flow` tool. See the `climier-flow` skill for launch, recovery, and the runner contract.

## Storage

- `<project-root>/.climier.json` — the repo-committed file pinning the `project_id` (and, optionally, the backend).
- `~/.climier/projects/<project_id>/tasks.json` — the **local** state file. NOT in the repo. NOT under git's purview. This is the default backend.
- `.climier.json` is the only file climier-related in the repo. The state file is machine-local; backups are the operator's responsibility.
- If `.climier.json` declares `backend: { "type": "remote", "url": "..." }`, the state lives on that server and the CLI routes every read and mutation there. Do not assume a local `tasks.json` exists; inspect `.climier.json` first.
- Multiple machines with the same repo checkout share the `.climier.json` but each have their own state file (this is by design — agents are local processes, state is the shared truth on the host that runs them).

State shape: `{ version: 1, initiatives, nodes, edges, log }`.

- `nodes`: tasks (resolvable labor), gates (resolvable decisions/approvals/external deps/research), knowledge (durable facts).
- `edges`: typed (`BLOCKS`, `SUPERSEDES`, `DERIVED_FROM`). Only `BLOCKS` affects readiness — `to` is blocked by `from`. The CLI surfaces `BLOCKS` from the dependent's POV as `--blocked-by`: `--blocked-by G-y` means "this node is blocked by G-y", and stores the canonical edge `{from: "G-y", to: <this node>, type: "BLOCKS"}`.
- `log`: append-only audit trail (`{ ts, agent, action, node, ... }`).

## Setup (first time only)

If `climier` is not on PATH, install it through either channel:

```bash
# npm channel (requires Bun 1.4+)
bun add --global climier

# or standalone binary, no runtime (Linux and macOS)
curl -fsSL https://github.com/codefensory/climier/releases/latest/download/install.sh | sh
```

From a checkout without installing, run `bun bin/climier.ts` in place of `climier`.

If `~/.climier/projects/<project_id>/tasks.json` does not exist yet (no agent has run `init` from this repo on this machine):

```bash
# canonical schema 1 state
climier init
```

`init` no longer accepts a `--seed` flag (removed in climier 1.0). Storage is NOT in the repo and NOT under git's purview; the repo only commits `.climier.json`.

### Bootstrap an initiative (required before any add-*)

`add-task`, `add-gate`, and `add-knowledge` require `--initiative <name>` to already be registered, otherwise the CLI fails with `INITIATIVE_NOT_FOUND`. `add-initiative` is **not** idempotent: re-registering an existing name fails with `ID_CONFLICT`. Register it once before building the DAG:

```bash
climier initiatives --all   # check first
climier add-initiative <name> --desc "<scope>" --as orchestrator
climier add-gate   <G-id>  --initiative <name> ...
climier add-task   <T-id>  --initiative <name> ...
```

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
- `NOT_READY` / `NOT_CLAIMABLE` / `ALREADY_CLAIMED` — a claim was rejected for that reason.
- `POLICY_DENIED` — an installed policy plugin rejected an otherwise state-valid mutation.
- `INVALID_STATUS` — node isn't in a status that allows this transition (e.g. `resolve` on a resolved gate).
- `REVISION_CONFLICT` — `update --if-revision N` failed because the stored revision differs.
- `INVALID_EDGE_TYPE` / `INVALID_EDGE_KIND` / `SELF_EDGE` / `CYCLE_DETECTED` / `DUPLICATE_EDGE` / `INVALID_EDGE_TARGET` — edge problems.

Branch on `error.code`, not on `error.message`.

## Edge direction

The CLI phrases edges from the dependent's point of view: `--blocked-by G-y` means "this node is blocked by G-y". Internally the edge is stored canonically as `from: G-y, to: <this node>, type: BLOCKS`. The `from BLOCKS to` reading is: **to is BLOCKED-BY from**. The CLI never asks for `--blocks` — only `--blocked-by`. `SUPERSEDES` and `DERIVED_FROM` keep the user-supplied direction (the new node is `from`, the older node is `to`).

## Research pattern (use gates, not tasks, for investigations)

When a task requires investigation before implementation, **don't create a task for the research**. Register a gate instead. The gate is the research; the rationale is the summary; the chosen path is the choice.

Use `docs/` for general project documentation that is not itself a climier node body. Store the research that backs a specific gate in a project doc and point the gate body at it; many projects use a convention such as `.decisions/<gate-id>.md`.

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

Tasks stay blocked until `D9` is resolved. When the operator reads one with `context`, the body shows the `Read .decisions/D9.md first.` line; the `climier-flow` runner then starts with that task contract.

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

## If the JSON gets corrupted or out of sync

`readState` returns `null` when the file is missing. To rebuild from scratch:

```bash
# Backup first (the state file is at ~/.climier/projects/<id>/tasks.json)
cp ~/.climier/projects/<project_id>/tasks.json ~/.climier/projects/<project_id>/tasks.json.bak

# Reset (only if you're sure; this loses log entries)
climier init --force
```

The CLI also auto-recovers a corrupt JSON on `init --force` (or even without `--force` if the existing state is unreadable). Always backup first.

## Common pitfalls

- **Forgetting `--as`.** Mutating commands (`resolve` for gates, `update`, `add-note`, `add-task`, `add-gate`, `add-knowledge`, and similar DAG curation commands) require `--as`. The CLI throws `MISSING_AGENT` with a structured details object.
- **Using `resolve` on a task.** Tasks do not use `resolve`; it is exclusively for gates with `--choice` and `--rationale`.
- **Running a task whose dependencies are unresolved.** If the node is not `ready`, read `climier context <id>` and inspect `blocking[]` before executing it.
- **Boolean flags before the command.** `climier --force init` is interpreted as `--force=init` (the parser consumes the next non-flag as the flag's value). Use `climier --force=true init` or put the flag after the command. The same applies to any boolean flag: if a flag is meant as a switch, use `--flag=true` when the command comes right after.

## Examples

See `examples/dag-curation.md` in this skill for graph curation and gate resolution. Execution examples live in the `climier-flow` skill.
