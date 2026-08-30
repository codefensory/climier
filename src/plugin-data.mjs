// plugin-data.mjs: data.*.{get,set} host adapters.
//
// Per ADR-005 §"API y persistencia" and the V1 host contract:
//   - Each set requires an agent identity (MISSING_AGENT when empty).
//   - data.node.set writes only `nodes[id].plugins[<pluginId>].data` and
//     preserves `meta` and every other plugin's keyspace.
//   - data.project.set writes only `plugins[<pluginId>].data[key]` and
//     preserves `nodes[id].plugins` for every node.
//   - get is read-only and lock-free. data.node.get only returns the
//     calling plugin's data, never another plugin's.
//   - Both sets delegate their complete mutation to kernel.mutate. The
//     kernel owns locking, atomic persistence, revisions and redacted logs.

import { readState } from "./state.mjs";
import { mutate } from "./kernel/mutate.mjs";
import {
  pluginDataNodeSetProvider,
  pluginDataProjectSetProvider,
} from "./providers/plugin-data/index.mjs";
import { throwV2 } from "./errors.mjs";

function assertAgent(agent, commandName, scope) {
  if (typeof agent === "string" && agent.trim()) return agent.trim();
  throwV2(
    "MISSING_AGENT",
    `${commandName}: agent required (set --as or CLIMIER_AGENT)`,
    { command: commandName, scope, flag: "as", env: "CLIMIER_AGENT" },
  );
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
        const outcome = await mutate({
          projectDir,
          request: {
            action: "plugin-data.node.set",
            actor: opAgent,
            input: { id, value },
          },
          provider: pluginDataNodeSetProvider,
          pluginId,
        });
        return outcome.result.value;
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
        await mutate({
          projectDir,
          request: {
            action: "plugin-data.project.set",
            actor: opAgent,
            input: { key, value },
          },
          provider: pluginDataProjectSetProvider,
          pluginId,
        });
      },
    },
  };
}
