// plugins/data.mjs: data.*.{get,set} host adapters.
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

import { readState } from "../storage/state.mjs";
import { mutate } from "../kernel/mutate.mjs";
import {
  pluginDataNodeSetProvider,
  pluginDataProjectSetProvider,
  pluginDataNodeDeleteProvider,
  pluginDataProjectDeleteProvider,
} from "../providers/plugin-data/index.mjs";
import { throwV2 } from "../contracts/errors.mjs";
import { assertLocalBackend } from "./remote-guard.mjs";

function assertAgent(agent, commandName, scope) {
  if (typeof agent === "string" && agent.trim()) {
    return agent.trim();
  }
  throwV2(
    "MISSING_AGENT",
    `${commandName}: agent required (set --as or CLIMIER_AGENT)`,
    { command: commandName, scope, flag: "as", env: "CLIMIER_AGENT" },
  );
}

function nodePluginData(state, id, pluginId) {
  const entry = state?.nodes?.[id]?.plugins?.[pluginId];
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  return entry.data;
}

function projectPluginData(state, pluginId, key) {
  const data = state?.plugins?.[pluginId]?.data;
  if (!data || typeof data !== "object") {
    return undefined;
  }
  return data[key];
}

function nodeDataReader(projectDir, pluginId) {
  return async (id) => {
    if (typeof id !== "string" || !id) {
      throw new Error("data.node.get: id required");
    }
    const state = await readState(projectDir);
    return state ? nodePluginData(state, id, pluginId) : undefined;
  };
}

function projectDataReader(projectDir, pluginId) {
  return async (key) => {
    if (typeof key !== "string" || !key) {
      throw new Error("data.project.get: key required");
    }
    const state = await readState(projectDir);
    return state ? projectPluginData(state, pluginId, key) : undefined;
  };
}

function createNodeData({ projectDir, agent, pluginId }) {
  return {
    get: nodeDataReader(projectDir, pluginId),
    async set(id, value) {
      if (typeof id !== "string" || !id) {
        throw new Error("data.node.set: id required");
      }
      const opAgent = assertAgent(agent, "data.node.set", "node");
      const outcome = await mutate({
        projectDir,
        request: { action: "plugin-data.node.set", actor: opAgent, input: { id, value } },
        provider: pluginDataNodeSetProvider,
        pluginId,
      });
      return outcome.result.value;
    },
    async delete(id) {
      if (typeof id !== "string" || !id) {
        throw new Error("data.node.delete: id required");
      }
      const opAgent = assertAgent(agent, "data.node.delete", "node");
      const outcome = await mutate({
        projectDir,
        request: { action: "plugin-data.node.delete", actor: opAgent, input: { id } },
        provider: pluginDataNodeDeleteProvider,
        pluginId,
      });
      return outcome.result;
    },
  };
}

function createProjectData({ projectDir, agent, pluginId }) {
  return {
    get: projectDataReader(projectDir, pluginId),
    async set(key, value) {
      if (typeof key !== "string" || !key) {
        throw new Error("data.project.set: key required");
      }
      const opAgent = assertAgent(agent, "data.project.set", "project");
      await mutate({
        projectDir,
        request: { action: "plugin-data.project.set", actor: opAgent, input: { key, value } },
        provider: pluginDataProjectSetProvider,
        pluginId,
      });
    },
    async delete(key) {
      if (typeof key !== "string" || !key) {
        throw new Error("data.project.delete: key required");
      }
      const opAgent = assertAgent(agent, "data.project.delete", "project");
      const outcome = await mutate({
        projectDir,
        request: { action: "plugin-data.project.delete", actor: opAgent, input: { key } },
        provider: pluginDataProjectDeleteProvider,
        pluginId,
      });
      return outcome.result;
    },
  };
}

export function createData({ projectDir, agent, pluginId, backendClient }) {
  assertLocalBackend(backendClient, "createData");
  if (typeof pluginId !== "string" || !pluginId) {
    throw new Error("createData: pluginId required");
  }
  const context = { projectDir, agent, pluginId };
  return {
    node: createNodeData(context),
    project: createProjectData(context),
  };
}
