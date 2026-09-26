// `reject <id>` CLI adapter for the canonical task.reject operation.
// The operation bridge selects the local or remote mutation frontier.
import { createBackendClient, createOperationBridge } from "../../application/operations/index.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { executeRemoteTask, throwMissingRemoteNode } from "./internal/task-routing.mjs";

export const knownFlags = ["as", "reason"];

async function rejectRemote({ backendClient, dir, agent, id, reason }) {
  const remote = await executeRemoteTask({
    backendClient,
    projectDir: dir,
    actor: agent,
    operation: "task.reject",
    command: "reject",
    id,
    input: { id, reason },
    inspectTarget: true,
  });
  if (!remote) {
    return null;
  }
  if (!remote.node) {
    throwMissingRemoteNode("reject", id);
  }
  return { node: remote.node };
}

async function rejectLocally({ backendClient, dir, projectConfig, source, agent, id, reason }) {
  const selectedClient = backendClient || createBackendClient({ projectDir: dir, projectConfig, source });
  const mutation = await createOperationBridge({ backendClient: selectedClient }).executeOperation({
    actor: agent,
    operation: "task.reject",
    input: { id, reason },
  });
  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  if (!updated || !updated.node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `reject: kernel did not return node ${id}`, { id });
  }
  return { node: updated.node };
}

export default async function reject({ statePath, projectDir, projectConfig, source, flags = {}, positional = [], backendClient } = {}) {
  const id = positional[0];
  if (!id) {
    throwV2("MISSING_FIELD", "reject: node id required", { field: "id" });
  }
  const agent = resolveAgent(flags, "reject");
  const reason = typeof flags.reason === "string" ? flags.reason.trim() : flags.reason;
  const dir = projectDir || statePath;
  const remote = await rejectRemote({ backendClient, dir, agent, id, reason });
  if (remote) {
    return remote;
  }
  return rejectLocally({ backendClient, dir, projectConfig, source, agent, id, reason });
}
