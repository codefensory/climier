import { createOperationBridge } from "../../../application/operations/index.mjs";
import { throwV2 } from "../../../contracts/errors.mjs";

export function isRemoteBackend(backendClient) {
  return backendClient?.type === "remote";
}

function requireOperationBridge(backendClient, command) {
  if (typeof backendClient?.executeOperation !== "function" || typeof backendClient?.executeBatch !== "function") {
    throwV2("INVALID_OPERATION_BRIDGE", `${command}: remote backend client does not support operation execution`);
  }
}

export async function executeRemoteDomain({ backendClient, actor, operation, input, command }) {
  if (!isRemoteBackend(backendClient)) return null;
  requireOperationBridge(backendClient, command);

  const remoteInput = { ...input };
  delete remoteInput.actor;
  if (["gate.resolve", "gate.reopen", "gate.cancel"].includes(operation) && remoteInput.id && remoteInput.if_revisions === undefined) {
    const target = await readRemoteNode(backendClient, remoteInput.id, command, (node) => node.kind === "resolvable" && node.subkind === "gate");
    remoteInput.if_revisions = { [remoteInput.id]: Number.isInteger(target.revision) ? target.revision : 1 };
  }
  if (operation === "note.add" && remoteInput.id && remoteInput.if_revision === undefined) {
    const target = await readRemoteNode(backendClient, remoteInput.id, command, () => true);
    remoteInput.if_revision = Number.isInteger(target.revision) ? target.revision : 1;
  }
  if (operation === "gate.create" && remoteInput.resolution_mode !== undefined) {
    throwV2("REMOTE_UNSUPPORTED_OPERATION", `${command}: remote gate.create does not support resolution_mode`, { command, field: "resolution_mode" });
  }
  if (operation === "knowledge.create" && remoteInput.derived_from !== undefined) {
    throwV2("REMOTE_UNSUPPORTED_OPERATION", `${command}: remote knowledge.create does not support derived_from`, { command, field: "derived_from" });
  }
  if (operation === "knowledge.create" && remoteInput.refs === undefined) remoteInput.refs = [];
  return createOperationBridge({ backendClient }).executeOperation({ actor, operation, input: remoteInput });
}

export async function readRemoteNode(backendClient, id, command, accepts = () => true) {
  if (typeof backendClient?.readNode !== "function") {
    throwV2("INVALID_OPERATION_BRIDGE", `${command}: remote backend client must support node reads`);
  }
  const node = (await backendClient.readNode({ id }))?.node || null;
  if (!node || !accepts(node)) {
    throwV2("REMOTE_UNSUPPORTED_OPERATION", `${command}: remote target is not supported by this adapter`, {
      command, id, kind: node?.kind, subkind: node?.subkind,
    });
  }
  return node;
}

export function nodeFromMutation(mutation, id, collection = "updated") {
  const entries = mutation?.diff?.[collection];
  return Array.isArray(entries) ? entries.find((entry) => entry.id === id)?.node || null : null;
}
