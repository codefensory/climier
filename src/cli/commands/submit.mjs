// `submit <id>` CLI adapter for the canonical task.submit operation.
// The operation bridge selects the local or remote mutation frontier.
import { createBackendClient, createOperationBridge } from "../../application/operations/index.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { executeRemoteTask, throwMissingRemoteNode } from "./internal/task-routing.mjs";

export const knownFlags = ["as", "note"];

export default async function submit({ statePath, projectDir, projectConfig, source, flags = {}, positional = [], backendClient } = {}) {
  const id = positional[0];
  if (!id) throwV2("MISSING_FIELD", "submit: node id required", { field: "id" });
  const agent = resolveAgent(flags, "submit");
  const note = typeof flags.note === "string" ? flags.note.trim() : flags.note;
  const dir = projectDir || statePath;
  const remote = await executeRemoteTask({
    backendClient,
    projectDir: dir,
    actor: agent,
    operation: "task.submit",
    command: "submit",
    id,
    input: { id, note, actor: agent },
    inspectTarget: true,
  });
  if (remote) {
    if (!remote.node) throwMissingRemoteNode("submit", id);
    return { node: remote.node, newly_ready: remote.mutation.effects?.newly_ready || [] };
  }
  const selectedClient = backendClient || createBackendClient({ projectDir: dir, projectConfig, source });
  const mutation = await createOperationBridge({ backendClient: selectedClient }).executeOperation({
    actor: agent,
    operation: "task.submit",
    input: { id, note, actor: agent },
  });

  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  if (!updated || !updated.node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `submit: kernel did not return node ${id}`, { id });
  }
  return {
    node: updated.node,
    newly_ready: mutation.effects && Array.isArray(mutation.effects.newly_ready)
      ? mutation.effects.newly_ready
      : [],
  };
}
