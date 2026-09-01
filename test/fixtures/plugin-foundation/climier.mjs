import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(args) {
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (typeof token !== "string") continue;
    if (token.startsWith("--")) {
      if (!token.includes("=") && args[i + 1] && !String(args[i + 1]).startsWith("--")) i += 1;
      continue;
    }
    positional.push(token);
  }
  return positional;
}

function required(positional, index, name) {
  const value = positional[index];
  if (typeof value !== "string" || value.length === 0) {
    const error = new Error(`foundation: ${name} required`);
    error.code = "PLUGIN_HANDLER_FAILED";
    error.details = { missing: name };
    throw error;
  }
  return value;
}

function jsonValue(raw, name) {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    const error = new Error(`foundation: ${name} must be JSON: ${cause.message}`);
    error.code = "PLUGIN_HANDLER_FAILED";
    error.details = { field: name };
    throw error;
  }
}

function failure(error) {
  const cause = error?.details?.cause || error;
  return {
    error: {
      code: cause?.code || "CORE_ERROR",
      message: cause?.message || String(cause),
      details: cause?.details || {},
    },
  };
}

export default {
  commands: {
    async snapshot(_args, api) {
      return { command: "snapshot", snapshot: await api.query.snapshot() };
    },

    async "data-set"(args, api) {
      const positional = parseArgs(args);
      const nodeId = required(positional, 0, "node id");
      const key = required(positional, 1, "data key");
      const value = jsonValue(required(positional, 2, "data value"), "data value");
      await api.data.node.set(nodeId, { [key]: value });
      await api.data.project.set(key, value);
      return { command: "data-set", nodeId, key };
    },

    async "data-get"(args, api) {
      const positional = parseArgs(args);
      const nodeId = required(positional, 0, "node id");
      const key = required(positional, 1, "data key");
      const node = await api.data.node.get(nodeId);
      return { command: "data-get", node: node?.[key] ?? null, project: await api.data.project.get(key) ?? null };
    },

    async "project-set"(args, api) {
      const positional = parseArgs(args);
      const key = required(positional, 0, "data key");
      const value = jsonValue(required(positional, 1, "data value"), "data value");
      await api.data.project.set(key, value);
      return { command: "project-set", key };
    },

    async "data-delete"(args, api) {
      const positional = parseArgs(args);
      const nodeId = required(positional, 0, "node id");
      const key = required(positional, 1, "data key");
      return {
        command: "data-delete",
        node: await api.data.node.delete(nodeId),
        project: await api.data.project.delete(key),
      };
    },

    async "runtime-write"(args, api) {
      const marker = required(parseArgs(args), 0, "marker");
      await fs.writeFile(path.join(api.runtime.dataDir, "marker.json"), JSON.stringify({ marker }), "utf8");
      return { command: "runtime-write", dataDir: api.runtime.dataDir };
    },

    async "runtime-read"(_args, api) {
      const raw = await fs.readFile(path.join(api.runtime.dataDir, "marker.json"), "utf8");
      return { command: "runtime-read", dataDir: api.runtime.dataDir, marker: JSON.parse(raw).marker };
    },

    async repair(_args, api) {
      const batch = await api.core.batch({
        operations: [
          { op: "task.create", input: { id: "T-pf-repair-a", initiative: "plugin-foundation", title: "repair a", body: "a", acceptance: "a" } },
          { op: "task.create", input: { id: "T-pf-repair-b", initiative: "plugin-foundation", title: "repair b", body: "b", acceptance: "b" } },
          { op: "edge.add", input: { from: "T-pf-repair-a", to: "T-pf-repair-b", type: "BLOCKS" } },
        ],
      });
      return { command: "repair", batch };
    },

    async rollback(_args, api) {
      try {
        await api.core.batch({
          operations: [
            { op: "task.create", input: { id: "T-pf-rollback", initiative: "plugin-foundation", title: "rollback", body: "rollback", acceptance: "never persists" } },
            { op: "edge.add", input: { from: "T-pf-shell-a", to: "T-pf-shell-b", type: "BLOCKS" } },
          ],
        });
      } catch (error) {
        return failure(error);
      }
      throw new Error("foundation: rollback fixture unexpectedly succeeded");
    },

    async cas(_args, api) {
      try {
        const snapshot = await api.query.snapshot();
        await api.core.batch({
          if_state_revision: snapshot.revision - 1,
          operations: [{ op: "task.create", input: { id: "T-pf-stale-cas", initiative: "plugin-foundation", title: "stale", body: "stale", acceptance: "never persists" } }],
        });
      } catch (error) {
        return failure(error);
      }
      throw new Error("foundation: stale CAS fixture unexpectedly succeeded");
    },

    async "api-cycle"(_args, api) {
      try {
        await api.core.run({
          op: "edge.add",
          input: { from: "T-pf-shell-b", to: "T-pf-shell-a", type: "BLOCKS" },
        });
      } catch (error) {
        return failure(error);
      }
      throw new Error("foundation: API cycle fixture unexpectedly succeeded");
    },

    async "batch-cycle"(_args, api) {
      try {
        await api.core.batch({
          operations: [{ op: "edge.add", input: { from: "T-pf-shell-b", to: "T-pf-shell-a", type: "BLOCKS" } }],
        });
      } catch (error) {
        return failure(error);
      }
      throw new Error("foundation: batch cycle fixture unexpectedly succeeded");
    },
  },
};
