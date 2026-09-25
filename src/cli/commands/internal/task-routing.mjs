import { createOperationBridge } from "../../../application/operations/index.mjs";
import { throwV2 } from "../../../contracts/errors.mjs";

export function isRemoteBackend(backendClient) {
  return backendClient && backendClient.type === "remote";
}

export function remoteNode(result) {
  return result && result.node ? result.node : null;
}

export async function readRemoteNode(backendClient, id) {
  return remoteNode(await backendClient.readNode({ id }));
}

export async function requireRemoteTask(backendClient, id, command) {
  const node = await readRemoteNode(backendClient, id);
  if (!node || node.kind !== "resolvable" || node.subkind !== "task") {
    throwV2(
      "REMOTE_UNSUPPORTED_OPERATION",
      `${command}: remote ${node ? `${node.kind}/${node.subkind || "?"}` : "target"} is not a task operation owned by this adapter`,
      { command, id, kind: node && node.kind, subkind: node && node.subkind },
    );
  }
  return node;
}

export async function executeRemoteTask({
  backendClient,
  actor,
  operation,
  input,
  id,
  command,
  inspectTarget = false,
  collection = "updated",
}) {
  if (!isRemoteBackend(backendClient)) return null;
  if (!backendClient || typeof backendClient.executeOperation !== "function" ||
      typeof backendClient.executeBatch !== "function") {
    throwV2("INVALID_OPERATION_BRIDGE", `${command}: remote backend client does not support operation execution`);
  }
  const target = inspectTarget ? await requireRemoteTask(backendClient, id, command) : null;
  const normalizedInput = { ...input };
  delete normalizedInput.actor;
  if (operation === "task.update" && target && normalizedInput.if_revision === undefined) {
    normalizedInput.if_revision = Number.isInteger(target.revision) ? target.revision : 1;
  } else if (operation === "task.update" && normalizedInput.if_revision === undefined) {
    normalizedInput.if_revision = 1;
  }
  const bridge = createOperationBridge({ backendClient });
  const mutation = await bridge.executeOperation({ actor, operation, input: normalizedInput });
  const entries = mutation && mutation.diff && Array.isArray(mutation.diff[collection])
    ? mutation.diff[collection]
    : [];
  const node = entries.find((entry) => entry.id === id)?.node || target || remoteNode(mutation) || mutation.result?.node || null;
  return { mutation, node };
}

export function throwMissingRemoteNode(command, id) {
  throwV2("INVALID_EXECUTION_CONTRACT", `${command}: remote operation did not return node ${id}`, { id });
}
