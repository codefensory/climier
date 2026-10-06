
import { createBackendClient, createOperationBridge } from "../../application/operations/index.ts";
import { throwV2 } from "../../contracts/errors.ts";
import { resolveAgent } from "../actor.ts";
import { executeRemoteTask, throwMissingRemoteNode } from "./internal/task-routing.ts";
import type { CliMutation, CommandContext } from "./contracts.ts";

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
  }) as CliMutation;
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

export default async function accept({ statePath, projectDir, projectConfig, source, flags, positional, backendClient }: CommandContext) {
  const id = positional[0];
  if (!id) {throwV2("MISSING_FIELD", "accept: node id required", { field: "id" });}
  const agent = resolveAgent(flags, "accept");
  const dir = projectDir || statePath;
  return (await acceptRemote({ backendClient, dir, agent, id }))
    || acceptLocal({ backendClient, projectConfig, source, dir, agent, id });
}
