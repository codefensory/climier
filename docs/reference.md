# climier reference

Complete reference for the climier surface.

## CLI output and exit codes

The CLI emits one JSON value on stdout for every command result or operational
failure. Operational failures use this envelope:

```json
{
  "ok": false,
  "error": { "code": "STABLE_CODE", "message": "...", "details": {} }
}
```

`error.code` is the machine contract. `details` is always present for
structured failures and may contain operation-specific data such as node IDs,
revisions, or batch indexes. Consumers must not parse prose from `message`.
The public routes used by replanners (`task` create/update, edge add/remove,
`batch`, `state`, `context`, `status`, gate, and knowledge commands) preserve
their domain codes, including `CYCLE_DETECTED`,
`STATE_REVISION_CONFLICT`, and `BATCH_OPERATION_FAILED`. Plugin data,
compatibility, and runtime failures use `PLUGIN_DATA_INVALID`,
`PLUGIN_API_INCOMPATIBLE`, and `PLUGIN_RUNTIME_UNAVAILABLE` respectively when
those boundaries report them.

| Outcome | Exit | Contract |
|---|---:|---|
| Success | 0 | command result object or array |
| Domain conflict, storage failure, or internal failure | 1 | structured error envelope |
| Unknown command or no command | 2 | legacy routing error envelope |

Storage failures are exposed as `STORAGE_ERROR` with the original storage code
in `details.cause`; opaque failures are exposed as `CLI_INTERNAL_ERROR`. Help
and version remain the only intentional plain-text outputs and exit 0. There is
no `--json` switch because JSON is already the default.

Remote v1 accepts HTTP and HTTPS origins. The operator owns the server listener address and transport exposure; `listen.host` is a non-empty host string passed to the operating system, and Climier does not impose a loopback, interface, or network-vendor policy. HTTPS is recommended. For an HTTP origin outside loopback, successful `login`, `link`, and remote `init` results include a `warnings` field containing `{ kind: "insecure-remote-http", severity: "warning", message: "<command>: <origin> is not HTTPS; the login password and bearer travel without transport encryption." }`; `<origin>` is `new URL(backend.url).origin`. `--no-warnings` suppresses that field and is accepted before or after the command. Loopback HTTP and HTTPS do not warn; remote failures never fall back to local state.

If you only need the quickstart, use `README.md`. If you need the actual contract, use this file.

## Commit messages

Repository commits use this subject format:

```text
<type>(<scope>)!?: <subject> [<node-id>]
```

The allowed types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`,
`test`, `build`, `ci`, `chore`, and `revert`. `scope` and `!` are optional;
`[<node-id>]` is mandatory for ordinary commits and must resolve with
`climier show <node-id>`. Examples:

```text
feat(cli): add a task export command [T-example-export]
fix(install): abort on a mismatched sha256 without writing [T-example-installer]
```

Enable the repository hook explicitly after checking out the repository:

```bash
bun run setup:hooks
```

That command sets `core.hooksPath` to `.githooks`. Hook installation is not part
of `prepare`, so installing the package does not change a consumer's Git
configuration.

The hook exempts these subjects:

- `Merge ...`
- `Revert "..."`
- `fixup! ...`, `squash! ...`, and `amend! ...`
- release commits beginning with `release: v...` or `chore(release): ...`

The explicit escapes are `git commit --no-verify`, which skips the local hook,
and `CLIMIER_COMMIT_NO_TASK=1`, which skips only DAG node lookup while retaining
format validation. The contract is enforced locally only: CI does not validate
commit messages.

## State shape

`init` creates the canonical schema-1 state with this shape. The reader accepts only this form. The one-time import window for pre-canonical projects has completed and its tool is retired. If older or incomplete state is found, preserve the project files and restore a verified canonical backup or contact the maintainer; never use `init --force` to convert or recover data:

```js
{
  version: 1,
  fence_generation: 1,
  revision: 0,
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

- `version: 1`
- `fence_generation`
- `revision`
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

## Local web UI (experimental)

`climier urls [--initiative X] [--id NODE] [--port N] [--origin URL]` prints UI deep links. Local links are marked `local_only` and work while `climier ui` runs on this machine.

`climier ui [--port N] [--open=true|false]` starts the local read-only board and
opens it in the browser. It is experimental: it lives in the `ui/` subproject
with its own dependencies, reads the schema-1 state through the CLI's own
derivation functions, and is not included in the published tarball. A missing
subproject or dependency produces an actionable error. The CLI surface and
JSON contract do not depend on it.

The local adapter answers the same `/v1` read contract as the hosted server
for **every project in the local storage root** (`$CLIMIER_HOME/projects`):
`GET /v1/projects` (the catalog), `POST /v1/auth/login`,
`GET /v1/projects/:id/ui/{snapshot,nodes,activity}` with `ETag`/`304`, and the
`/ui/events` SSE stream — but without bearer auth or the remote catalog. The
same `ui/dist` bundle serves the remote DAG on the server and the local DAG on
loopback; the browser client probes `/v1/projects` once and treats a `200`
(open) response as authenticated, so the login gate only appears when the
server requires a bearer.

`climier ui` is launched from a project root (`--project`) and starts the
loopback server; the launch project only identifies the process (and the token
label). The catalog reads every local project by id, lock-safe and without a
project root. A project's display name comes from the `rename` sidecar
(`$CLIMIER_HOME/projects/<id>/project.json`) or, when `climier ui` is launched
from a workspace root such as `~/dev`, from an in-memory index of the
`.climier.json` files found below it (two levels, shallowest wins). The index is
read-only. A project whose state is unreadable stays in the catalog with neutral
counters; opening it surfaces the real error.

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

- `--domain`
- `--tags a,b`
- `--refs a,b`
- `--meta '{"x":1}'`
- `--derived-from A,B`
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

These commands record task ownership and review outcomes:

- `take <id> --as <agent>` claims a ready task.
- `submit <id> --note "..." --as <agent>` records an owned task's handoff for review.
- `accept <id> --as <agent>` transitions submitted work to `done`.
- `reject <id> --reason "..." --as <agent>` returns submitted work to `open`.

Use `release`, `reopen`, and `cancel` for explicit administration. Claims are
serialized under the project lock.

### `take <id>`

`take <id>` claims exactly the requested task.

Accepted flags:

- `--as <agent>`

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

Resolves an open gate as part of DAG curation; it is not a task lifecycle transition.

Required:

- `--choice "..."`
- `--rationale "..."`
- `--as <agent>`

A second resolve of an already resolved gate fails. To correct an accepted
decision, use `reopen` first and then resolve it again with explicit choice and
rationale. The operation stores `resolution: { choice, rationale }` and computes
newly ready dependents.

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
- whole-token matches inside the entry's `note` text

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

Read-only listing of recoverable snapshots captured under `<state-dir>/snapshots/`. Mirrors the `listSnapshots` primitive from `src/storage/state.ts`: only complete pairs (raw + metadata) appear, metadata id mismatches with the filename are excluded, and the result is sorted descending by id (timestamp-prefixed, so lexicographic order matches creation order — newest first).

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

Replace the live state with a validated schema-1 snapshot. The operation runs
through the recovery path under the project lock and takes a pre-restore
snapshot before changing the live state. A policy plugin may restrict the
actor; callers must use the actor permitted by the active policy.

Behavior:

- validates a complete snapshot pair and its metadata before changing anything;
- validates the canonical schema-1 collections and ledger fields;
- takes the pre-restore snapshot, writes the validated state atomically, and
  appends the restore event to the restored log;
- returns `{ snapshot: <metadata> }` and leaves state untouched on invalid input.

Use `init --force` only for an intentional reset of the project, never to
convert an existing project. For a pre-cut project, use the ordered import in
[`docs/remote-server.md`](remote-server.md).

### `state`

Returns the deterministic current core projection. It is read-only and does not
inspect historical snapshots.

### `batch` and edge removal

`batch --file <json>` or `batch --stdin` applies an authorized group of
operations atomically. Remote v1 also supports the explicit `push` and `pull`
DAG transfer commands; the linked server-side project remains authoritative for
normal operations. The low-level `remove-edge <from> <to> --type ...` operation
is idempotent and removes only one exact edge.

### `rename "<name>"`

`rename "<name>"` sets the project's display name: the label the local and
hosted UIs show in the project switcher instead of the opaque `project_id`. The
default is the checkout directory name, recorded automatically on first contact;
`rename` overrides it in `.climier.json`, in the local state directory, and, on
a linked checkout, in the server catalog through
`POST /v1/projects/:id/rename`. Names collapse whitespace and are bounded to 120
characters. Every authenticated remote request also carries the local name in
`x-climier-project-name`, so a project provisioned before names existed adopts
one on first contact without a separate command.

### Remote v1 authentication

`link <origin> [--replace=true] [--name "<name>"]` records the remote type and complete URL while
preserving the checkout project ID. `login [--server <origin>]` reads a password
from a TTY without echo and stores only the origin-indexed bearer in the local
credential profile; `logout` removes that local entry. A checkout with a retired
protocol marker fails with `REMOTE_CONFIG_OUTDATED` before auth or local state
I/O; relink it to the configured URL to clean the metadata. `init` may provision
an absent remote project, while reads and writes never create storage implicitly.
The server requires a private password, a service-lifetime lock, and a durable
auth file; `server init` generates the password or adopts an existing,
operator-chosen value, and only `--rotate-password` rotates it. Its bind address
and transport are operator-managed.
Successful HTTP non-loopback `login`, `link`, and remote `init` operations warn
unless `--no-warnings` is supplied; see
[`docs/remote-server.md`](remote-server.md) for transport, backup, rotation,
transfers, and stale-lock recovery.

## Server commands

The `server` namespace manages the host that serves a project DAG to remote
clients. Its commands are local-host operations: they do not read or write
project state, do not take `--as`, and stay available in a checkout that is
linked to a remote backend.

### `server init [--root P] [--host H] [--port N] [--data-root P] [--state-home P] [--ui-root P] [--service-user U] [--service-name N] [--unit systemd|none] [--allow-missing-paths] [--dry-run] [--force] [--rotate-password] [--print-secret] [--yes]`

Generates the artifacts a host needs to run the server: a private configuration,
an environment file holding the server secret, and a service unit. `--root` is
required; the listen address defaults to loopback on port `43127`, the storage
paths default to `<root>/data` and `<root>/state`, and the unit file defaults to
`<root>/climier-server.service`.

- the configuration `server.json` (`0600`) carries `listen`, `dataRoot`,
  `stateHome`, and an optional `uiRoot`, and every path is absolute;
- the environment file `server.env` (`0600`) carries the server credential and
  an optional request body-size limit;
- storage paths are created with mode `0700` when missing, and
  `--allow-missing-paths` defers creating them for a mount or volume that
  appears later;
- `--unit systemd` (the default) also writes the unit file, while `--unit none`
  writes configuration and environment only, for a container or a foreground
  process supervisor.

`init` never installs, enables, or starts the unit, and never runs `chown`,
`chmod`, or `sudo`: with `--service-user <user>` it adds `User=`/`Group=` to the
unit and reports the ownership commands the operator must apply.

Re-running with the same options over matching artifacts changes nothing. A
missing artifact is created and the others are preserved; an artifact that
conflicts with the requested options fails with `SERVER_CONFIG_EXISTS` and writes
nothing. `--force` recreates conflicting artifacts and keeps the existing
password, and only `--rotate-password` mints a new secret, invalidating every
session. `--print-secret` writes the secret to stdout and is unsafe outside
controlled recovery. `--dry-run` reports the actions without writing.

The generated unit supervises the process and nothing else: `ExecStart` runs the
installed `climier` executable with `server run <configuration>`,
`EnvironmentFile` names the generated environment file, and `Restart=on-failure`
is the only resilience policy. Hardening, the service identity, and the listener
ordering are the operator's policy and belong in a systemd drop-in, so the root
may live anywhere the service identity can read and write.

### `server doctor [--config P] [--env-file P] [--probe-bind] [--strict]`

Runs the same pre-bind checks as `server init` without creating directories,
taking the service lock, or binding the address: configuration shape and
permissions, storage paths, the secret, the optional UI root, and the body-size
limit. It returns structured checks with `status` and `fix`. Without `--config`
it reads `server.json` from the project root and, without `--env-file`, the
matching `server.env` that the unit delivers. `--probe-bind` briefly opens the
configured address, and its findings are warnings unless `--strict` is passed.
`doctor` cannot prove that a service manager delivered the environment file, and
it does not detect drift in an installed unit.

### `server setup`

Interactive front end over `server init`: it asks for the same options and calls
the same code path. Without a TTY it fails with `CLI_USAGE_ERROR` and lists the
flags to pass instead.

### `server run <configuration>`

Binds the configured address, prints `{"ok":true,"host":"<host>","port":<port>}`
on stdout, and then serves in the foreground; `SIGINT` and `SIGTERM` close the
listener. The process holds a service-lifetime lock in `stateHome`, so a second
process pointed at the same state fails with `SERVER_ALREADY_RUNNING`.

Artifacts, service installation, the client handoff, backup, rotation, and
recovery are documented in [`docs/remote-server.md`](remote-server.md).

## Install and upgrade

`climier` ships as an npm package (Bun runtime) and as self-contained binaries
for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and `windows-x64`.
The documentation site's install guide covers both channels, the checksummed
one-line installer, and manual downloads.

### `upgrade [--check] [--version <X.Y.Z>]`

Operator command: it does not mutate the DAG and does not need `--as`. It reads
the published release manifest and follows the install channel:

- `binary`: downloads the asset, verifies its SHA-256, and replaces the running
  executable atomically (a `.old` swap on Windows); a running server keeps the
  previous executable until its service restarts.
- `npm`: delegates to the owning package manager; it never edits `node_modules`
  by hand.
- `source-link`: does not auto-update; it prints the git instructions.
- `one-off`: fails with `UPGRADE_UNSUPPORTED_DISTRIBUTION`.

`--check` reports the comparison without changing anything and never reports the
install as current when the manifest is unreachable
(`UPDATE_CHECK_UNREACHABLE`). `--version` pins an explicit upgrade or downgrade;
a downgrade without it fails with `UPGRADE_DOWNGRADE_REQUIRES_VERSION`. If the
manifest declares a newer `state_schema`, the result sets `migration_required`
and advises reviewing the release notes before upgrading. An active runner
execution blocks the upgrade with `UPGRADE_FLOW_ACTIVE`.

## Low-level semantics worth knowing

- every created node starts at `revision: 1`
- mutating lifecycle commands bump `revision`
- state mutation and log append happen under the same lock
- `show`, `context`, `search`, `take`, `update`, and lifecycle commands require the canonical schema-1 state
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

## Minimal flow

```bash
climier init
climier add-initiative auth --desc "Auth migration" --as orchestrator
climier add-gate G-auth --initiative auth --title "Choose session model" --body "Decide" --purpose decision --as orchestrator
climier add-task T-auth --initiative auth --title "Implement sessions" --body "Build it" --acceptance "Works" --blocked-by G-auth --as alice
climier context T-auth
climier resolve G-auth --choice "Opaque sessions" --rationale "Safer default" --as orchestrator
climier take T-auth --as implementer
climier submit T-auth --note "Implementation complete" --as implementer
climier accept T-auth --as reviewer
climier history T-auth
climier status --all
```
