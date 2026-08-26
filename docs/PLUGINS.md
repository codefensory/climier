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
