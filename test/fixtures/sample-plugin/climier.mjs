// T-plugin-fixture — sample V1 plugin entrypoint.
//
// Self-contained ESM module that exposes one dedicated subcommand per
// V1 API method declared in ADR-005 §"API y persistencia":
//
//   runtime          -> api.runtime
//   query-node       -> api.query.node(id)
//   query-context    -> api.query.context(id)
//   query-status     -> api.query.status()
//   query-history    -> api.query.history(id, { limit })
//   data-node-get    -> api.data.node.get(id)
//   data-node-set    -> api.data.node.set(id, value)
//   data-project-get -> api.data.project.get(key)
//   data-project-set -> api.data.project.set(key, value)
//
// Each command is intentionally small and maps to exactly one api
// method so the integration test (test/plugin-integration.test.mjs)
// can attribute failures to a specific surface.
//
// The module has no external runtime dependencies; it is meant to be
// installed as a local path by `climier install <fixture-dir>`.

function parseArgs(tokens) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (typeof t !== "string") continue;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      let key, val;
      if (eq !== -1) {
        key = t.slice(2, eq);
        val = t.slice(eq + 1);
      } else {
        key = t.slice(2);
        const next = tokens[i + 1];
        if (next !== undefined && !String(next).startsWith("--")) {
          val = next;
          i++;
        } else {
          val = true;
        }
      }
      flags[key] = val;
    } else {
      positional.push(t);
    }
  }
  return { flags, positional };
}

function requirePositional(positional, idx, name) {
  const v = positional[idx];
  if (typeof v !== "string" || !v) {
    const e = new Error(`sample: ${name} required`);
    e.code = "PLUGIN_HANDLER_FAILED";
    e.details = { missing: name };
    throw e;
  }
  return v;
}

function parseJson(raw, where) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const e = new Error(`sample: ${where} is not valid JSON: ${err.message}`);
    e.code = "PLUGIN_HANDLER_FAILED";
    e.details = { where, raw };
    throw e;
  }
}

export default {
  commands: {
    // runtime: echoes api.runtime and the forwarded argv so the test can
    // verify both the host's effective resolution and the order
    // preservation of forwarded tokens.
    runtime(args, api) {
      return {
        command: "runtime",
        runtime: api.runtime,
        forwarded_args: args,
      };
    },

    // query.node
    async "query-node"(args, api) {
      const { positional } = parseArgs(args);
      const id = requirePositional(positional, 0, "node id");
      const node = await api.query.node(id);
      return { command: "query-node", id, node: node ?? null };
    },

    // query.context
    async "query-context"(args, api) {
      const { positional } = parseArgs(args);
      const id = requirePositional(positional, 0, "node id");
      const ctx = await api.query.context(id);
      return {
        command: "query-context",
        id,
        derived_status: ctx.derived_status,
        allowed_actions: ctx.allowed_actions,
      };
    },

    // query.status
    async "query-status"(_args, api) {
      const status = await api.query.status();
      return { command: "query-status", summary: status.summary };
    },

    // query.history
    async "query-history"(args, api) {
      const { positional, flags } = parseArgs(args);
      const id = requirePositional(positional, 0, "node id");
      const opts =
        flags.limit !== undefined ? { limit: Number(flags.limit) } : undefined;
      const result = await api.query.history(id, opts);
      // api.query.history returns the { id, entries } envelope produced
      // by `climier history`; forward the inner entries array verbatim.
      return {
        command: "query-history",
        id,
        entries: Array.isArray(result?.entries) ? result.entries : [],
      };
    },

    // data.node.get
    async "data-node-get"(args, api) {
      const { positional } = parseArgs(args);
      const id = requirePositional(positional, 0, "node id");
      const data = await api.data.node.get(id);
      return { command: "data-node-get", id, data: data ?? null };
    },

    // data.node.set
    async "data-node-set"(args, api) {
      const { positional } = parseArgs(args);
      const id = requirePositional(positional, 0, "node id");
      const raw = requirePositional(positional, 1, "json value");
      const value = parseJson(raw, "data-node-set value");
      await api.data.node.set(id, value);
      return { command: "data-node-set", id, ok: true };
    },

    // data.project.get
    async "data-project-get"(args, api) {
      const { positional } = parseArgs(args);
      const key = requirePositional(positional, 0, "project key");
      const data = await api.data.project.get(key);
      return { command: "data-project-get", key, data: data ?? null };
    },

    // data.project.set
    async "data-project-set"(args, api) {
      const { positional } = parseArgs(args);
      const key = requirePositional(positional, 0, "project key");
      const raw = requirePositional(positional, 1, "json value");
      const value = parseJson(raw, "data-project-set value");
      await api.data.project.set(key, value);
      return { command: "data-project-set", key, ok: true };
    },
  },
};
