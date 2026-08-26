// plugin-data.mjs: data.*.{get,set} under the project lock with redacted logs.
//
// Per ADR-005 §"API y persistencia" and the V1 host contract:
//   - Each set requires an agent identity (MISSING_AGENT when empty).
//   - data.node.set writes only `nodes[id].plugins[<pluginId>].data` and
//     preserves `meta` and every other plugin's keyspace.
//   - data.project.set writes only `plugins[<pluginId>].data[key]` and
//     preserves `nodes[id].plugins` for every node.
//   - meta and nodes[id].plugins are disjoint keyspaces; concurrent
//     mutations must preserve both. withLock(projectDir) serialises the
//     read-modify-write pair across plugins.
//   - get is read-only and lock-free. data.node.get only returns the
//     calling plugin's data, never another plugin's.
//   - The log envelope carries { action, agent, plugin_id, key, scope,
//     node_id? } and never the value. node_id? is present only when
//     scope=node.

import { withLock } from "./lock.mjs";
import { updateState, readState } from "./state.mjs";
import { append } from "./log.mjs";
import { throwV2 } from "./errors.mjs";

function assertAgent(agent, commandName, scope) {
  if (typeof agent === "string" && agent.trim()) return agent.trim();
  throwV2(
    "MISSING_AGENT",
    `${commandName}: agent required (set --as or CLIMIER_AGENT)`,
    { command: commandName, scope, flag: "as", env: "CLIMIER_AGENT" },
  );
}

// Ensure `node.plugins[pluginId]` exists on a node. Returns the node.
// Throws NODE_NOT_FOUND when the node is missing.
function ensureNodePluginEntry(state, pluginId, nodeId, commandName) {
  const node = state.nodes && state.nodes[nodeId];
  if (!node) {
    throwV2("NODE_NOT_FOUND", `${commandName}: ${nodeId} not found`, {
      node_id: nodeId,
    });
  }
  if (!node.plugins || typeof node.plugins !== "object" || Array.isArray(node.plugins)) {
    node.plugins = {};
  }
  if (!node.plugins[pluginId] || typeof node.plugins[pluginId] !== "object") {
    node.plugins[pluginId] = {};
  }
  return node;
}

// Ensure `state.plugins[pluginId].data` exists as an object. Returns
// the entry. Initialises a missing or non-object entry to {}.
function ensureProjectPluginEntry(state, pluginId) {
  if (!state.plugins || typeof state.plugins !== "object" || Array.isArray(state.plugins)) {
    state.plugins = {};
  }
  const entry = state.plugins[pluginId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    state.plugins[pluginId] = {};
  }
  if (
    !state.plugins[pluginId].data ||
    typeof state.plugins[pluginId].data !== "object" ||
    Array.isArray(state.plugins[pluginId].data)
  ) {
    state.plugins[pluginId].data = {};
  }
  return state.plugins[pluginId];
}

export function createData({ projectDir, agent, pluginId }) {
  if (typeof pluginId !== "string" || !pluginId) {
    throw new Error("createData: pluginId required");
  }
  return {
    node: {
      get(id) {
        if (typeof id !== "string" || !id) {
          return Promise.reject(new Error("data.node.get: id required"));
        }
        return readState(projectDir).then((state) => {
          if (!state) return undefined;
          const node = state.nodes[id];
          if (!node || !node.plugins) return undefined;
          const entry = node.plugins[pluginId];
          if (!entry || typeof entry !== "object") return undefined;
          return entry.data;
        });
      },
      async set(id, value) {
        if (typeof id !== "string" || !id) {
          throw new Error("data.node.set: id required");
        }
        const opAgent = assertAgent(agent, "data.node.set", "node");
        return withLock(projectDir, async () => {
          let stored;
          await updateState(projectDir, (state) => {
            if (!state) {
              throw new Error("data.node.set: state file missing");
            }
            const node = ensureNodePluginEntry(state, pluginId, id, "data.node.set");
            // Overwrite the whole data keyspace for the calling plugin. ADR
            // §"API y persistencia" defines V1 semantics as "modify only
            // its keyspace" — that keyspace is the full `data` object.
            node.plugins[pluginId].data = value;
            stored = node.plugins[pluginId].data;
            return state;
          });
          await append(projectDir, {
            agent: opAgent,
            action: "plugin-data-set",
            plugin_id: pluginId,
            key: null,
            scope: "node",
            node_id: id,
          });
          return stored;
        });
      },
    },
    project: {
      get(key) {
        if (typeof key !== "string" || !key) {
          return Promise.reject(new Error("data.project.get: key required"));
        }
        return readState(projectDir).then((state) => {
          if (!state || !state.plugins) return undefined;
          const entry = state.plugins[pluginId];
          if (!entry || typeof entry !== "object") return undefined;
          const data = entry.data;
          if (!data || typeof data !== "object") return undefined;
          return data[key];
        });
      },
      async set(key, value) {
        if (typeof key !== "string" || !key) {
          throw new Error("data.project.set: key required");
        }
        const opAgent = assertAgent(agent, "data.project.set", "project");
        return withLock(projectDir, async () => {
          await updateState(projectDir, (state) => {
            if (!state) {
              throw new Error("data.project.set: state file missing");
            }
            const entry = ensureProjectPluginEntry(state, pluginId);
            entry.data[key] = value;
            return state;
          });
          await append(projectDir, {
            agent: opAgent,
            action: "plugin-data-set",
            plugin_id: pluginId,
            key,
            scope: "project",
          });
        });
      },
    },
  };
}
