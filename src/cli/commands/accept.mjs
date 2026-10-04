
import { createBackendClient, createOperationBridge } from "../../application/operations/index.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { executeRemoteTask, throwMissingRemoteNode } from "./internal/task-routing.mjs";

export const knownFlags = ["as"];

async function acceptRemote({ backendClient, dir, agent, id }) {
  const remote = await executeRemoteTask({
    backendClient,
    projectDir: dir,
    actor: agent,
    operation: "task.accept",
    command: "accept",
    id,
    input: { id, actor: agent },
    inspectTarget: true,
  });
  if (!remote) {return null;}
  if (!remote.node) {throwMissingRemoteNode("accept", id);}
  return { node: remote.node, newly_ready: remote.mutation.effects?.newly_ready || [] };
}

async function acceptLocal({ backendClient, projectConfig, source, dir, agent, id }) {
  const selectedClient = backendClient || createBackendClient({ projectDir: dir, projectConfig, source });
  const mutation = await createOperationBridge({ backendClient: selectedClient }).executeOperation({
    actor: agent,
    operation: "task.accept",
    input: { id, actor: agent },
  });
  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  if (!updated || !updated.node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `accept: kernel did not return node ${id}`, { id });
  }
  return {
    node: updated.node,
    newly_ready: mutation.effects && Array.isArray(mutation.effects.newly_ready)
      ? mutation.effects.newly_ready
      : [],
  };
}

export default async function accept({ statePath, projectDir, projectConfig, source, flags = {}, positional = [], backendClient } = {}) {
  const id = positional[0];
  if (!id) {throwV2("MISSING_FIELD", "accept: node id required", { field: "id" });}
  const agent = resolveAgent(flags, "accept");
  const dir = projectDir || statePath;
  return (await acceptRemote({ backendClient, dir, agent, id }))
    || acceptLocal({ backendClient, projectConfig, source, dir, agent, id });
}
