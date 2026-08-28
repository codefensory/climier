# Plugins V1

How to author, install, and verify a Climier V1 plugin.

This guide is the public reference for plugin authors. The contract is
fixed by ADR-005 (`G-plugin-host-v1-adr`); the implementation lives in
`src/plugin-*.mjs`. The fastest way to see a working plugin is the
fixture at `test/fixtures/sample-plugin/` and its smoke test
`test/plugin-integration.test.mjs`.

## 1. The descriptor

Every plugin declares its identity in its `package.json` under the
`climier` key:

```json
{
  "climier": {
    "id": "example.audit",
    "command": "audit",
    "entry": "./climier.mjs"
  }
}
```

| Field | Meaning |
|---|---|
| `id` | Plugin identity. Must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Unique across installed plugins. Persisted as the key for plugin data and the argument of `climier uninstall <id>`. |
| `command` | CLI namespace. Cannot collide with a reserved core namespace (see §6). |
| `entry` | Path, relative to the package root, to the ESM entrypoint that exports `default.commands`. |

The npm package name (`package.json#name`) is only the install source;
it does not identify data and does not drive `uninstall`.

## 2. The entrypoint

`entry` is loaded as an ESM module. The default export must be an
object whose `commands` field is an object of named handlers:

```js
// climier.mjs
export default {
  commands: {
    ping(args, api) {
      return { ok: true, runtime: api.runtime };
    },
    async audit(args, api) {
      const status = await api.query.status();
      return { ok: true, summary: status.summary };
    },
  },
};
```

An optional `default.policy` field adds a policy plugin (ADR-007); see
§9 for the contract. `commands` and `policy` are independent: a plugin
may ship both, only one of them, or neither — `importEntry` rejects a
shape that mixes the two incorrectly.

Each handler receives:

- `args`: an array of strings — the original CLI tokens with the
  namespace and subcommand removed, in their original order. Flags are
  still present in the array; the plugin parses them itself.
- `api`: the V1 host API (see §3).

The handler's return value is serialised to stdout as JSON. Thrown
errors are wrapped into the structured envelope (see §6).

## 3. V1 API surface

ADR-005 §"API y persistencia" defines the surface. The host guarantees:

```js
api.runtime
  .project_dir   // string — --project value, or process.cwd()
  .agent         // string — --as value, or CLIMIER_AGENT env var, or ""

api.query
  .node(id)            // raw node, read without taking the project lock
  .context(id)         // context view; allowed_actions is scoped to api.runtime.agent
  .status(options?)    // status summary; same flags as `climier status`
  .history(id, opts?)  // history entries for a node

api.data
  .node
    .get(id)           // the calling plugin's data slice (undefined if missing)
    .set(id, value)    // under the project lock; preserves meta and other plugins
  .project
    .get(key)          // the calling plugin's data slot for the project key
    .set(key, value)   // under the project lock; preserves nodes[id].plugins
```

Identity rules:

- `api.runtime.project_dir` is the effective project root. It is the
  first occurrence of `--project` in argv, or `process.cwd()` when
  `--project` is missing.
- `api.runtime.agent` is the first occurrence of `--as`, or
  `CLIMIER_AGENT` from the environment, or the empty string. Empty is
  permitted at the surface level, but `data.*.set` rejects it with
  `PLUGIN_HANDLER_FAILED` (cause: "agent required ...").
- Handlers still receive every forwarded token in `args`, including any
  `--project`/`--as` flags the caller placed before or after the
  namespace. The host ignores those duplicates for runtime resolution;
  `api.runtime` is authoritative.

## 4. Persistence shape

Plugin data lives in two optional, additive fields of the v2 state:

```jsonc
{
  "version": 2,
  "plugins": {
    "example.audit": {
      "data": { "last-run": "2026-08-26T22:00:00Z" }
    }
  },
  "nodes": {
    "T1": {
      "id": "T1",
      "plugins": {
        "example.audit": {
          "data": { "verdict": "ok", "findings": [] }
        }
      }
    }
  }
}
```

- `plugins[<id>].data` is the project-wide keyspace for the plugin.
- `nodes[<id>].plugins[<id>].data` is the per-node keyspace.
- The two keyspaces (root `plugins`, node-level `plugins`, plus node
  `meta`) are disjoint. `data.*.set` takes the project lock, modifies
  only the calling plugin's slice, and preserves every other slice.
- `uninstall <id>` removes the installed directory but does NOT purge
  data — reinstall restores the same surface.
- The DAG does not derive semantics from these fields; the host
  preserves them through every mutator, snapshot, and restore.

## 5. Lifecycle: install / uninstall

```bash
# Install from a local path or a registry name.
climier install <source>

# Uninstall by id. Does not purge data.
climier uninstall <id>
```

Install takes a global lock at `$CLIMIER_HOME/plugins/.lock`, runs
`npm install --prefix <staging> <source>`, validates the descriptor,
imports the entrypoint, and promotes the staging directory to
`installed/<id>` via an atomic rename. Uninstall removes
`installed/<id>` under the same lock.

There is no central registry or manifest. Each `installed/<id>/`
directory contains its own `node_modules`, `package.json`, and
entrypoint. The plugin list is derived from the directory contents.

## 6. Errors

Plugin errors use the structured envelope that core v2 commands already
emit:

```json
{ "ok": false, "error": { "code": "PLUGIN_XXX", "message": "...", "details": { ... } } }
```

with exit code 1.

| Code | When |
|---|---|
| `PLUGIN_INVALID_DESCRIPTOR` | descriptor shape, id regex, or reserved-namespace collision. |
| `PLUGIN_LOAD_FAILED` | ESM import failed or `default.commands` missing. |
| `PLUGIN_ID_CONFLICT` | id or command already installed. |
| `PLUGIN_NPM_UNAVAILABLE` | `npm` is not on PATH or `--version` fails. |
| `PLUGIN_NPM_FAILED` | `npm install --prefix ...` returned non-zero. |
| `PLUGIN_SUBCOMMAND_NOT_FOUND` | namespace is installed but the subcommand is missing or unknown. |
| `PLUGIN_HANDLER_FAILED` | the handler rejected (sync throw or async reject); details carry `plugin_id`, `namespace`, `subcommand`, and `cause`. |

If a handler throws an error that already has `code: "PLUGIN_*"` and a
`details` object, the host propagates it without rewrapping. A handler
that wants a custom PLUGIN envelope can attach `code` and `details` to
its own `Error`.

## 7. Author's smoke

Before publishing a plugin, run this smoke against a local copy:

1. Pick a project (`/tmp/smoke`), initialise it, and seed a task:
   ```bash
   mkdir -p /tmp/smoke && cd /tmp/smoke
   climier --project . init
   climier --project . --as me add-task T-smoke \
     --initiative my-initiative --title "smoke target" \
     --body "smoke" --acceptance "round-trip ok"
   ```
2. Install your plugin from its directory:
   ```bash
   climier --project . install /path/to/your-plugin
   ```
3. Run each subcommand with `--project`/`--as` placed in different
   orders; confirm `api.runtime.project_dir` and `api.runtime.agent`
   carry the effective values regardless of position, and that the
   forwarded argv preserves the original token order with the
   namespace + subcommand stripped.
4. Call `api.data.node.set` and `api.data.project.set`, then read
   back. Verify the persisted state:
   - `nodes[<id>].plugins[<your.id>].data` is set;
   - `plugins[<your.id>].data` is set;
   - `log` has entries with `action: "plugin-data-set"`, `plugin_id`,
     `scope`, and `node_id`/`key` — but no `value` field.
5. Verify secret safety: any string in your test value must NOT appear
   in any log entry's serialized form.
6. Uninstall, reinstall, and re-read: the values persist across
   reinstall because `uninstall` does not purge data.
7. Uninstall a second time after reinstall; the no-op removal still
   returns `uninstalled: true`.

The smoke is automated in `test/plugin-integration.test.mjs`. Use the
fixture at `test/fixtures/sample-plugin/` as a template for your own
descriptor and entrypoint.

## 8. Limitations (V1, by design)

- No hooks, events, workers, UI, permissions, secrets, or DAG/lifecycle
  semantics. A real need for any of these promotes `T-plugin-v2-rfc-backlog`.
- Plugin code runs with the user's permissions. There is no sandboxing,
  no timeout, no signing, and no protection against side effects
  triggered by `import`-time code.
- `data.*.set` re-serialises the whole `data` slice for the calling
  plugin. Very large values rewrite the project state file in full; V1
  leaves this cost to the author.
- A new `climier` invocation is a fresh Node process; the loader does
  not cache between invocations.

## 9. Policy plugins (ADR-007 / ADR-008)

Policy plugins extend the V1 contract with an optional authorisation
face. A plugin MAY export `default.policy = { applies?, authorize }`;
if it does, the host selects the policy at runtime, asks it to
_authorise_ every mutating handler, and either lets the mutation
proceed or rejects it with a structured `POLICY_*` error. The
descriptor, install path, plugin id, and `api.*` surface are
unchanged.

This section fixes the public contract. It does NOT promise
authentication, composition, sandboxing, a dedicated timeout, or
persistent auditing — those are explicitly out of scope (ADR-007
§"Decisión", ADR-008 §"Negativas").

### 9.1 Shape

```js
// climier.mjs
export default {
  policy: {
    // Optional. Returns true when this policy applies to the current
    // project config; false (or absent) means "always applies".
    // Receives the frozen raw `.climier.json` object (or `{}` when
    // missing). MUST be a pure function over its input.
    async applies(projectConfig) { … },

    // Required when `default.policy` is exported. Receives the
    // action + snapshot under the lock; returns one of:
    //   { decision: "allow" }
    //   { decision: "deny", reason: "<human readable>" }
    //   { decision: "abstain" }
    // Any other return is a POLICY_ERROR. Throwing is a POLICY_ERROR.
    async authorize({ action, actor, target, snapshot,
                      projectDir, projectConfig }) { … },
  },
};
```

`importEntry` accepts `default.policy` only when its shape is strict:
`policy` is a plain object, `authorize` is a function when present,
`applies` is a function when present, and no field beyond those two
exists. Violations fail the entire plugin load with
`PLUGIN_LOAD_FAILED` (carrying `details.field`) — `commands` is not
loaded either, so the host is never half-wired.

### 9.2 Canonical actions

ADR-008 §"Acciones canónicas" lists the action names the seam sends
to `authorize`:

```text
task.create    task.take        task.takeover*   task.resolve
task.release   task.reopen      task.cancel      task.update
gate.create    gate.resolve     gate.reopen      gate.cancel
gate.update
knowledge.create   knowledge.deprecate   knowledge.update
initiative.create   edge.add   note.add
state.restore*   state.init_force*
```

`*` = internal to the seam; never exposed through the public
plugin-core registry, never accepted as a `core.run({ op })` argument.
The public registry keeps the legacy `task.update` shape for
backwards compatibility; the handler classifies by subkind inside
`update.mjs` and translates to `task.update`, `gate.update`, or
`knowledge.update` before the seam sees it.

A plugin can only `deny` an action it understands — the host does
not interpret the response further than `allow`/`deny`/`abstain`.
Defaults core apply on `abstain` and on no policy installed; see
§9.5.

### 9.3 Discovery and selection

`loadApplicablePolicy({ projectDir })` runs once per mutating command,
before the project lock:

1. `readProjectConfig(projectDir)` — reads `.climier.json` raw, or `{}`
   when the file is missing. The object is frozen before being passed
   to `applies`.
2. `loadInstalledPolicyPlugins()` scans `installed/*/package.json` for
   entries with a valid `default.policy`. Selection is NOT cached
   across commands — installing or uninstalling a policy plugin is
   observable on the next invocation.
3. For each candidate:
   - `applies` absent → always a candidate.
   - `applies(projectConfig)` present → invoked once with the frozen
     config; truthy means applicable.
4. Exactly one applicable policy → returned to the handler.
5. Zero applicable → handler receives `null` and applies defaults
   core.
6. Two or more applicable → `POLICY_CONFLICT`. Details carry both
   the installed `plugin_ids` and their `namespaces`.

### 9.4 Authorisation under the lock

The decision runs INSIDE the handler's existing `withLock(projectDir)`,
against a snapshot taken from the read state:

```js
const decision = await authorizeAction({
  policy,        // loadApplicablePolicy result, or null
  action,        // canonical action from §9.2
  actor,         // --as / CLIMIER_AGENT (never empty for mutators)
  target,        // { id, kind, subkind, status?, claim? }
  snapshot,      // read-only view of state under the lock
  projectDir,
  projectConfig, // frozen raw .climier.json (or {})
});
```

The snapshot is a defensive copy of `nodes`, `edges`, and
`initiatives`. Plugins MUST treat it as read-only — the host does
not enforce immutability for performance, but a mutation will not
be persisted and may corrupt the live read.

`authorizeAction` returns:

| Policy outcome | Decision shape | Handler behaviour |
|---|---|---|
| `policy === null` | `{ decision: "abstain" }` | defaults core |
| `authorize` returns `{ decision: "allow" }` | `{ decision: "allow" }` | mutation proceeds |
| `authorize` returns `{ decision: "deny", reason }` | `{ decision: "deny", reason }` | handler throws `POLICY_DENIED` |
| `authorize` returns `{ decision: "abstain" }` | `{ decision: "abstain" }` | defaults core |
| `authorize` throws or returns a malformed shape | — | handler throws `POLICY_ERROR` |

The seam does NOT cache decisions across calls; each mutation re-runs
the full selection + authorisation. The seam does NOT introduce a
new lock; it runs on the handler's critical path (ADR-008
§"Seam por handler").

### 9.5 Core invariants the seam cannot weaken

ADR-008 §"Invariantes core" lists the rules that no `allow` may
override. Plugins that return `allow` for any of these are still
rejected by the handler:

- DAG and state shape remain valid (validation runs before the seam
  where relevant; otherwise the handler rejects after).
- Atomicity, lock and logging: deny/error never produces a state
  mutation or a success log entry.
- A task without a claim can only receive a winning claim under
  concurrency; the seam arbitrates who wins.
- `task.resolve` requires `claim.by === actor`. The owner check runs
  BEFORE the seam — a non-owner cannot resolve even when the policy
  returns `allow`.
- `done_by` records the actor that resolved.
- `--allow-unregistered-initiative` is not a public capability and
  not a policy action; the internal escape hatch lives in
  `addNodeInternal({ allowUnregisteredInitiative: true })`.

When the policy is absent or abstains, the handler enforces these
invariants on its own. `release`, `cancel`, and `reopen` no longer
compare against actor names like `"orchestrator"` or `"recovery"`;
the only authority signal is `claim.by` for tasks (or `done_by` for
`reopen`). A non-owner that asks for `release` on someone else's
claim without policy `allow` gets `NOT_OWNER`.

### 9.6 Takeover table (task.take / task.takeover)

ADR-008 §"Tabla de take" specifies the only place actor strings
affect the result:

| State at lock | Action | `allow` | `deny` | `abstain` |
|---|---|---|---|---|
| task free | `task.take` | claim created | `POLICY_DENIED` | claim created (default core) |
| same actor holds claim | (none) | idempotent | idempotent | idempotent |
| other actor holds claim | `task.takeover` | claim replaced; `previous_owner` recorded | `POLICY_DENIED` | `ALREADY_CLAIMED` |

The classification runs inside the lock, never on actor names alone.

### 9.7 Errors

| Code | When |
|---|---|
| `POLICY_LOAD_FAILED` | plugin export shape invalid at install/load time (re-uses the existing `PluginLoadFailed` plumbing). |
| `POLICY_ERROR` | `applies` or `authorize` threw, returned a non-object, or returned an unknown `decision`. `details.cause_message` carries the original cause. |
| `POLICY_DENIED` | `authorize` returned `{ decision: "deny" }`. `details` carries `plugin_id`, `op`, `action`, `reason`, `actor`. State and log are untouched. |
| `POLICY_CONFLICT` | more than one installed policy `applies` to the project. `details` carries `plugin_ids` and `namespaces`. |

Denials and errors do NOT add a state-log entry in this version
(ADR-008 §"Contexto, help y auditoría"). The error envelope is the
audit trail.

### 9.8 Out of scope (explicit non-goals)

ADR-007 §"Decisión" + ADR-008 §"Negativas" carve out what policy
plugins do not provide today. Documenting them here so authors do
not assume otherwise:

- **No authentication.** `actor` is the literal `--as` /
  `CLIMIER_AGENT` string. The host does not verify identity.
- **No composition.** When more than one policy is applicable, the
  seam returns `POLICY_CONFLICT`. There is no priority, merge, or
  chain logic.
- **No sandboxing.** The plugin's `authorize` runs in-process, with
  the user's permissions, with access to the host's module cache and
  the filesystem. Plugins MUST NOT write to state files directly.
- **No dedicated timeout.** A slow policy holds the project lock
  for the duration of its `authorize`. The host does not cancel
  long-running policies; if you need a cap, enforce it inside your
  own `authorize`.
- **No persistent auditing.** Denials do not append to the state
  log. The JSON error is the only record.
