// The kernel owns locking, atomic persistence, revisions and redacted logs.

import { readState } from "../storage/state.ts";
import { mutate } from "../kernel/mutate.ts";
import {
  pluginDataNodeSetProvider,
  pluginDataProjectSetProvider,
  pluginDataNodeDeleteProvider,
  pluginDataProjectDeleteProvider,
} from "../providers/plugin-data/index.ts";
import { throwV2 } from "../contracts/errors.ts";
import { assertLocalBackend } from "./remote-guard.ts";
import type { PluginBackendClient, PluginData } from "./types.ts";
import { isRecord } from "../application/types.ts";

type MutationOutcome = { result: unknown };

type DataContext = { projectDir: string; agent: unknown; pluginId: string };

function assertAgent(agent: unknown, commandName: string, scope: string): string {
  if (typeof agent === "string" && agent.trim()) {
    return agent.trim();
  }
  throwV2(
    "MISSING_AGENT",
    `${commandName}: agent required (set --as or CLIMIER_AGENT)`,
    { command: commandName, scope, flag: "as", env: "CLIMIER_AGENT" },
  );
}

function nodePluginData(state: unknown, id: string, pluginId: string): unknown {
  if (!isRecord(state) || !isRecord(state.nodes) || !isRecord(state.nodes[id])) {
    return undefined;
  }
  const node = state.nodes[id];
  if (!isRecord(node.plugins) || !isRecord(node.plugins[pluginId])) {
    return undefined;
  }
  const entry = node.plugins[pluginId];
  return isRecord(entry) ? entry.data : undefined;
}

function projectPluginData(state: unknown, pluginId: string, key: string): unknown {
  if (!isRecord(state) || !isRecord(state.plugins) || !isRecord(state.plugins[pluginId])) {
    return undefined;
  }
  const plugin = state.plugins[pluginId];
  if (!isRecord(plugin.data)) {
    return undefined;
  }
  return plugin.data[key];
}

function nodeDataReader(projectDir: string, pluginId: string): (id: string) => Promise<unknown> {
  return async (id: string) => {
    if (typeof id !== "string" || !id) {
      throw new Error("data.node.get: id required");
    }
    const state = await readState(projectDir);
    return state ? nodePluginData(state, id, pluginId) : undefined;
  };
}

function projectDataReader(projectDir: string, pluginId: string): (key: string) => Promise<unknown> {
  return async (key: string) => {
    if (typeof key !== "string" || !key) {
      throw new Error("data.project.get: key required");
    }
    const state = await readState(projectDir);
    return state ? projectPluginData(state, pluginId, key) : undefined;
  };
}

function createNodeData({ projectDir, agent, pluginId }: DataContext): PluginData["node"] {
  return {
    get: nodeDataReader(projectDir, pluginId),
    async set(id: string, value: unknown) {
      if (typeof id !== "string" || !id) {
        throw new Error("data.node.set: id required");
      }
      const opAgent = assertAgent(agent, "data.node.set", "node");
      const outcome = await mutate({
        projectDir,
        request: { action: "plugin-data.node.set", actor: opAgent, input: { id, value } },
        provider: pluginDataNodeSetProvider,
        pluginId,
      }) as unknown as MutationOutcome;
      return (outcome.result as { value: unknown }).value;
    },
    async delete(id: string) {
      if (typeof id !== "string" || !id) {
        throw new Error("data.node.delete: id required");
      }
      const opAgent = assertAgent(agent, "data.node.delete", "node");
      const outcome = await mutate({
        projectDir,
        request: { action: "plugin-data.node.delete", actor: opAgent, input: { id } },
        provider: pluginDataNodeDeleteProvider,
        pluginId,
      }) as unknown as MutationOutcome;
      return outcome.result;
    },
  };
}

function createProjectData({ projectDir, agent, pluginId }: DataContext): PluginData["project"] {
  return {
    get: projectDataReader(projectDir, pluginId),
    async set(key: string, value: unknown) {
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
    async delete(key: string) {
      if (typeof key !== "string" || !key) {
        throw new Error("data.project.delete: key required");
      }
      const opAgent = assertAgent(agent, "data.project.delete", "project");
      const outcome = await mutate({
        projectDir,
        request: { action: "plugin-data.project.delete", actor: opAgent, input: { key } },
        provider: pluginDataProjectDeleteProvider,
        pluginId,
      }) as unknown as MutationOutcome;
      return outcome.result;
    },
  };
}

export function createData({ projectDir, agent, pluginId, backendClient }: {
  projectDir: string;
  agent: unknown;
  pluginId: unknown;
  backendClient: PluginBackendClient;
}): PluginData {
  assertLocalBackend(backendClient, "createData");
  if (typeof pluginId !== "string" || !pluginId) {
    throw new Error("createData: pluginId required");
  }
  const context: DataContext = { projectDir, agent, pluginId };
  return {
    node: createNodeData(context),
    project: createProjectData(context),
  };
}
