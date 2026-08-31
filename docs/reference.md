# climier reference

Complete reference for the climier surface.

If you only need the quickstart, use `README.md`. If you need the actual contract, use this file.

## State shape

`init` creates a `version: 3` state with this shape. Compatible v2 states are normalized to v3 on read/write:

```js
{
  version: 3,
  initiatives: {
    "auth": { desc: "Auth migration", created_at: "2026-01-01T00:00:00.000Z" }
  },
  nodes: {
    "T-auth-1": { id: "T-auth-1", kind: "resolvable", subkind: "task", title: "...", revision: 1 },
    "G-auth-1": { id: "G-auth-1", kind: "resolvable", subkind: "gate", title: "...", revision: 1 },
    "K-auth-1": { id: "K-auth-1", kind: "knowledge", title: "...", revision: 1 }
  },
  edges: [
    { from: "G-auth-1", to: "T-auth-1", type: "BLOCKS" }
  ],
  log: []
}
```

The required top-level collections are:

- `version: 3`
- `nodes`
- `edges`
- `initiatives`
- `log`

## Node model

### Resolvable nodes

Two resolvable subtypes exist:

- `kind: `resolvable`` + `subkind: `task``
- `kind: `resolvable`` + `subkind: `gate``

Common fields on resolvable nodes:

- `id`
- `kind`
- `subkind`
- `title`
- `revision`
- `body`
- `refs`
- `meta`
- `initiative`
- `domain`
- `tags`
- `status`

Task-specific fields:

- `definition`
- `acceptance`
- `backlog: true` when intentionally kept out of the ready pool
- `claim: { by, at }` while claimed
- `submitted_by`, `submitted_at` after submit
- `done_by`, `done_at`, `accepted_by`, `accepted_at` after accept
- `note` as delivery evidence

Gate-specific fields:

- `purpose`
- `resolution_mode`
- `resolution: { choice, rationale }` after resolve

### Knowledge nodes

Knowledge is a first-class node kind:

- `kind: `knowledge``

Knowledge-specific fields:

- `knowledge_type`
- `mitigation`
- `scope: { domains, initiatives, tags, node_ids }`
- `status: "active" | "deprecated"`
- `deprecation_reason`, `deprecated_at`, `deprecated_by` after deprecation

## Edge model

Allowed edge types for mutation:

- `BLOCKS`
- `SUPERSEDES`
- `DERIVED_FROM`

Canonical `BLOCKS` direction:

- `{ from: blocker, to: blocked, type: "BLOCKS" }`

That means blockers are incoming edges. `--blocked-by G1` on a task creates a `BLOCKS` edge from `G1` to the task.

Other directions:

- `SUPERSEDES`: new node -> old node
- `DERIVED_FROM`: new node -> source node

Validation rules:

- self-edge: rejected
- missing endpoint: rejected
- `BLOCKS`: both ends must be resolvable
- `SUPERSEDES`: both ends must be the same kind
- duplicate exact edge: rejected

## Derived status and satisfaction

Tasks are not manually marked `ready` or `blocked`. Those states are derived.

### Task statuses you will see

- `ready`
- `blocked`
- `backlog`
- `in_progress`
- `submitted` (awaiting validation; not claimable and not satisfied)
- `done` (accepted work)
- `archived`
- `canceled`

### Gate statuses you will see

- `open`
- `resolved`
- `superseded`
- `canceled`

### Knowledge statuses you will see

- `active`
- `deprecated`

### Satisfaction rules

A `BLOCKS` edge is satisfied only when the blocker is satisfied:

- task blocker: satisfied when `done` or `archived`; `submitted` never satisfies `BLOCKS`
- gate blocker: satisfied when `resolved`
- superseded gate blocker: satisfied only if the successor chain ends in a `resolved` gate
- knowledge never directly satisfies `BLOCKS` because `BLOCKS` requires resolvable endpoints

Backlog tasks are a separate pool. They stay `backlog`, not `ready`, until they are edited out of backlog via `update --backlog false`.

## Agent identity

Every mutating command needs an agent identity.

Resolution order:

1. `--as <agent>`
2. `CLIMIER_AGENT`
3. fail with `MISSING_AGENT`

So `CLIMIER_AGENT` is the fallback, not the override.

## Initiative rules

Initiatives must be pre-registered.

- register with `add-initiative <name>`
- nodes require `--initiative`
- unregistered initiatives fail with `INITIATIVE_NOT_FOUND`
- escape hatch: `--allow-unregistered-initiative=true`

`add-initiative <name>` returns:

```js
{ initiative: { name, desc, created_at } }
```

Duplicate initiative names are rejected.

## Creation commands

### `add-task [id]`

`add-task [id]` creates a task node. If the id is omitted, a `T-xxxxxxxx` id is generated.

Required flags:

- `--initiative`
- `--title`
- `--body`
- `--acceptance`
- `--blocked-by`

Important: `--blocked-by` is required so dependency intent is explicit. If there are no blockers, pass:

- `--blocked-by ""`

Optional flags:

- `--definition`
- `--domain`
- `--tags a,b`
- `--refs a,b`
- `--meta '{"x":1}'`
- `--derived-from A,B`
- `--backlog true`
- `--as <agent>`

Notes:

- `--supersedes` is invalid on tasks
- output is `{ node }`

### `add-gate [id]`

Creates a gate node. If the id is omitted, a `G-xxxxxxxx` id is generated.

Required flags:

- `--initiative`
- `--title`
- `--body`
- `--purpose`

Optional flags:

- `--resolution-mode`
- `--blocked-by A,B`
- `--supersedes OLD`
- `--derived-from A,B`
- `--domain`
- `--tags a,b`
- `--refs a,b`
- `--meta '{...}'`
- `--as <agent>`

`--supersedes` on a gate:

- marks the old gate `superseded`
- bumps its revision
- rewrites incoming `BLOCKS` edges to the new gate

Output is `{ node }`.

### `add-knowledge [id]`

Creates a knowledge node. If the id is omitted, a `K-xxxxxxxx` id is generated.

Required flags:

- `--initiative`
- `--title`
- `--body`
- at least one scope flag:
  - `--scope-domains`
  - `--scope-initiatives`
  - `--scope-tags`
  - `--scope-node-ids`

Optional flags:

- `--knowledge-type`
- `--mitigation`
- `--domain`
- `--tags a,b`
- `--refs a,b`
- `--meta '{...}'`
- `--supersedes OLD`
- `--derived-from A,B`
- `--as <agent>`

Output is `{ node }`.

### `add-node <id>`

Low-level escape hatch for raw node creation.

Required:

- `add-node <id>`
- `--kind resolvable|knowledge`
- `--title`
- `--initiative`
- for resolvable nodes: `--subkind task|gate`

Optional:

- `--body`
- `--refs a,b`
- `--meta '{...}'`
- `--domain`
- `--tags a,b`
- `--status`
- `--resolution-mode`
- `--purpose`
- `--definition`
- `--acceptance`
- `--choice`
- `--rationale`
- `--knowledge-type`
- `--mitigation`
- `--scope-domains`
- `--scope-initiatives`
- `--scope-tags`
- `--scope-node-ids`
- `--backlog true`
- `--blocked-by A,B`
- `--derived-from A,B`
- `--supersedes OLD`
- `--allow-unregistered-initiative=true`
- `--as <agent>`

Output is `{ node }`.

### `add-edge <from> <to>`

Low-level escape hatch for typed edges.

Required:

- `add-edge <from> <to>`
- `--type BLOCKS|SUPERSEDES|DERIVED_FROM`
- `--as <agent>`

Output is `{ edge }`.

## Lifecycle commands

### `take <id>`

`take <id>` claims exactly the requested task.

Accepted flags:

- `--as <agent>`
- legacy but ignored: `--initiative`, `--domain`, `--tag`

Rules:

- only resolvable tasks are claimable
- same agent taking again is idempotent
- another agent gets `ALREADY_CLAIMED`
- `orchestrator` may take over another claim
- blocked, backlog, submitted, done, canceled, resolved, superseded tasks fail with `NOT_READY`

Output shape:

```js
{ node, context, freshly_claimed }
```

That is the literal return contract: `{ node, context, freshly_claimed }`.

### `release <id>`

Frees an `in_progress` implementation claim without resolving it.

Rules:

- task only
- owner may release
- `orchestrator` and `recovery` may release any task claim
- no claim is idempotent and returns `released: false`
- success sets `claim = null`, `status = "open"`, revision++

Output:

```js
{ released, node }
```

### `submit <id>`

Submits an owned implementation for independent validation.

Required:

- `--as <agent>`
- `--note "..."`

Rules:

- task only, exclusively `in_progress -> submitted`
- only the current `claim.by` may submit
- clears `claim` and stores `submitted_by`, `submitted_at`
- returns `{ node, newly_ready: [] }`; submission never unblocks work

### `accept <id>`

Accepts a submitted task.

Required: `--as <agent>`.

Rules:

- task only, exclusively `submitted -> done`
- preserves submission metadata; sets `done_by = submitted_by`, `done_at`, `accepted_by`, `accepted_at`
- computes `{ node, newly_ready }` after the task becomes satisfied

### `reject <id>`

Returns a submitted task to actionable work.

Required: `--as <agent>` and `--reason "..."`.

Rules:

- task only, exclusively `submitted -> open`
- clears claim and current submission/acceptance metadata
- records the rejection reason in the atomic mutation log; it does not create a new task

### `resolve <id>`

Closes a resolvable node as a compatibility/manual bypass.

For tasks:

- required: `--note`
- remains available for `open` / `in_progress -> done`; workers and automated flows use `submit` instead
- sets `status = "done"`
- stores `done_by`, `done_at`, `note`
- clears claim

For gates:

- required: `--choice`
- required: `--rationale`
- no claim required
- sets `status = "resolved"`
- stores `resolution: { choice, rationale }`

Output shape:

```js
{ node, newly_ready }
```

That is the literal return contract: `{ node, newly_ready }`.

### `reopen <id>`

Re-opens a terminal resolvable node.

Required:

- `--as <agent>`
- `--reason "..."`

Rules:

- task must currently be `done`
- gate must currently be `resolved`
- only original `done_by` or `orchestrator` / `recovery`
- task reopen clears claim, submission metadata, acceptance metadata and done metadata
- clears `resolution` when reopening a gate
- sets `status = "open"`

Output is `{ node }`.

### `cancel <id>`

Terminates a resolvable node without resolving it.

Required:

- `--as <agent>`
- `--reason "..."`

Rules:

- task allowed from `open`, `in_progress` or `submitted`
- owner may cancel claimed work
- `orchestrator` and `recovery` may cancel
- unclaimed `open` nodes are effectively orchestrator/recovery only
- success sets `status = "canceled"`, clears claim, bumps revision

Output is `{ node }`.

### `deprecate-knowledge <id>`

Soft-deletes a knowledge node.

Required:

- `--as <agent>`
- `--reason "..."`

Rules:

- knowledge only
- sets `status = "deprecated"`
- stores `deprecation_reason`, `deprecated_at`, `deprecated_by`
- bumps revision

Output is `{ node }`.

### `add-note <id>`

Appends a timestamped note to any node.

Required:

- `add-note <id>`
- note text as trailing positional text
- `--as <agent>`

Notes are append-only. Output is `{ node }`.

## Update and revision control

### `update <id>`

Edits a node and bumps its revision.

Required:

- `--as <agent>`
- at least one field to change

Optional optimistic locking:

- `--if-revision N`

If the stored revision differs, update fails with `REVISION_CONFLICT`.

Supported mutable flags:

- `--title`
- `--body`
- `--initiative`
- `--domain`
- `--tags a,b`
- `--refs a,b`
- `--meta '{...}'`
- `--definition`
- `--acceptance`
- `--backlog true|false`
- `--purpose`
- `--resolution-mode`
- `--knowledge-type`
- `--mitigation`
- `--scope-domains`
- `--scope-initiatives`
- `--scope-tags`
- `--scope-node-ids`

Notes:

- `--backlog false` removes the backlog flag
- `--tags` and `--refs` replace the full array
- `--meta` must be a JSON object
- output is `{ node }`

## Read commands

### `status`

Main dashboard.

Supported filters:

- `--initiative X`
- `--kind task|gate|knowledge`
- `--status X`
- `--domain X`
- `--claimed-by X`
- `--stale-ms N`
- `--limit N`
- `--all`
- `--as <agent>`

Default output shape:

```js
{
  summary: { ready, in_progress, blocked, backlog, open_gates, active_knowledge },
  tasks: { ready: [...], in_progress: [...], blocked: [...], backlog: [...] },
  gates: { open: [...] },
  knowledge_count: 0,
  alerts: []
}
```

With `--all`, additional groups appear:

- `done`
- `canceled`
- `resolved`
- `superseded`
- `deprecated`
- `knowledge` item dump instead of only `knowledge_count`

Notes:

- `summary` is always present
- `in_progress` is **global by default** — every in_progress task in scope is listed and counted regardless of caller. Use `--claimed-by <agent>` to narrow to one agent's claims; `--as` is an identity tag (it scopes `context`'s `allowed_actions`) and is intentionally NOT a filter for `status`.
- `--status` filters all buckets, not just derived ones. The only `--status` value that surfaces the in_progress bucket is `in_progress`; any other value leaves it empty.
- Stale-claim alerts follow the same rule: global by default, narrowed only by `--claimed-by`.

### `context <id>`

Agent-first node context.

Output shape:

```js
{
  node,
  derived_status,
  can_claim,
  revision,
  claim,
  blocking,
  knowledge,
  informing,
  alerts,
  allowed_actions
}
```

Important details:

- `claim` is normalized to `{ by, at, stale }` or `null`
- `blocking` contains incoming `BLOCKS` with inline blocker nodes and satisfaction flags
- `knowledge` returns matching knowledge ordered by specificity
- `allowed_actions` is always present
- `allowed_actions` changes by node kind, status, and agent

Alert kinds currently surfaced:

- `STALE_CLAIM`
- `SUPERSEDED_BLOCKER`
- `KNOWLEDGE_DEPRECATED_SOON`

### `search "<query>"`

Searches knowledge nodes only.

Flags:

- `--all` includes deprecated knowledge

Return shape:

```js
{ matches, count }
```

Each match contains:

- `id`
- `kind`
- `title`
- `initiative`
- `domain`
- `status`
- `matched_fields`
- `snippet`

Search is case-insensitive substring matching over:

- `id`
- `title`
- `body`
- `mitigation`
- `domain`
- `tags`
- `refs`
- `meta`

### `show <id>`

Returns the raw node.

Output shape:

```js
{ type, node }
```

That is the literal return contract: `{ type, node }`.

`type` is `task`, `gate`, or `knowledge`.

### `history <id>`

Returns log entries that reference an id.

Flags:

- `--limit N`

Output shape:

```js
{ id, entries }
```

An entry matches when the id appears in:

- `entry.node`
- whole-token matches inside `entry.note`

### `initiatives`

Lists registered initiatives.

Default:

- only initiatives with live nodes are shown

Use `--all` to include zero-node initiatives.

Output shape:

```js
{
  initiatives: [{ name, desc, created_at, nodes, tasks, knowledge }],
  unregistered: { nodes: 0, values: [] },
  all: boolean
}
```

### `snapshots`

Read-only listing of recoverable snapshots captured under `<state-dir>/snapshots/`. Mirrors the `listSnapshots` primitive from `src/storage/state.mjs`: only complete pairs (raw + metadata) appear, metadata id mismatches with the filename are excluded, and the result is sorted descending by id (timestamp-prefixed, so lexicographic order matches creation order — newest first).

Output shape:

```js
{ snapshots: [ { id, created_at, reason, bytes, sha256 }, ... ] }
```

Reasons:

- `force-init` — taken by `init --force` over a previous state file
- `corrupt-recovery` — taken by `init` when the existing file was corrupt JSON
- `pre-restore` — taken by `restore` of the state that is about to be displaced

No flags.

### `restore <snapshot-id>`

Replace the live state with a validated snapshot. v2 snapshots are normalized to v3 before persistence. Authority is restricted to `orchestrator` / `recovery` — no per-agent restore.

Requires:

- `--as orchestrator|recovery`

Behavior:

- Validates the snapshot exists as a complete pair (`<id>.json` + `<id>.meta.json`); metadata id matches the filename; metadata parses.
- Validates the raw bytes parse as a v2 or v3 JSON state and carry every required collection (`nodes`, `edges`, `initiatives`, `log`). v2 is normalized to v3; v1, future versions, missing fields, or unparseable raw → fail with `INVALID_STATUS` without mutating state.
- All target validation runs BEFORE the pre-restore snapshot, so a bad target leaves no trace in `<state-dir>/snapshots/`.
- Under `withLock`:
  - asserts the current state file exists (no current state to displace → fail)
  - calls `createSnapshot(projectDir, "pre-restore")` (raw + metadata, same `tmp+rename` discipline as `init --force`)
  - writes the validated, normalized v3 state to the state path via `tmp+rename`
  - appends `{ ts, agent, action: "restore", snapshot_id }` to the restored log (the entry lands in the state we just wrote, not the displaced one)
- Returns `{ snapshot: <metadata> }`.

Output shape:

```js
{ snapshot: { id, created_at, reason, bytes, sha256 } }
```

Error codes:

- `MISSING_AGENT` — `--as` missing or empty
- `NOT_OWNER` — `--as` is some agent other than `orchestrator` or `recovery`
- `MISSING_FIELD` — no snapshot id passed positionally
- `NODE_NOT_FOUND` — target absent, incomplete pair, corrupt metadata, or `meta.id` does not match filename
- `INVALID_STATUS` — raw is unparseable, not an object, missing version, v1, future version, or missing a required collection; or current state file is missing (no pre-restore snapshot possible)

## Low-level semantics worth knowing

- every created node starts at `revision: 1`
- mutating lifecycle commands bump `revision`
- state mutation and log append happen under the same lock
- `show`, `context`, `search`, `take`, `update`, lifecycle commands are version-aware
- `add-node` and `add-edge` are the raw escape hatches; prefer `add-task [id]`, `add-gate [id]`, and `add-knowledge [id]`

## Structured errors

Command failures use a structured error shape:

```js
{ ok: false, error: { code, message, details } }
```

Important codes you will actually hit:

- `MISSING_FIELD`
- `MISSING_AGENT`
- `NODE_NOT_FOUND`
- `INITIATIVE_NOT_FOUND`
- `ID_CONFLICT`
- `INVALID_EDGE_TARGET`
- `INVALID_EDGE_KIND`
- `INVALID_EDGE_TYPE`
- `SELF_EDGE`
- `DUPLICATE_EDGE`
- `REVISION_CONFLICT`
- `NOT_READY`
- `NOT_CLAIMABLE`
- `ALREADY_CLAIMED`
- `NOT_OWNER`
- `INVALID_STATUS`
- `STATE_V1_UNSUPPORTED` — a `version: 1` state file was found. v1 is no longer supported. The error `details.migration_steps` explains how to back up and recreate the project; `details.hint` points at `climier init --force` as the path to overwrite a v1 state file (after backup).

## Minimal flow

```bash
climier init
climier add-initiative auth --desc "Auth migration" --as orchestrator
climier add-gate G-auth --initiative auth --title "Choose session model" --body "Decide" --purpose decision --as orchestrator
climier add-task T-auth --initiative auth --title "Implement sessions" --body "Build it" --acceptance "Works" --blocked-by G-auth --as alice
climier context T-auth
climier resolve G-auth --choice "Opaque sessions" --rationale "Safer default" --as orchestrator
climier take T-auth --as alice
climier submit T-auth --note "Implemented and tested" --as alice
climier accept T-auth --as validator-auth
climier history T-auth
climier status --all --as alice
```
