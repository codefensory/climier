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

export async function routeRemoteOperation({
  backendClient,
  actor,
  operation,
  input,
  command,
  targetId,
  preReadTarget = targetId !== undefined,
  acceptsTarget,
  rejectTarget,
  selectOperation,
  revision,
  prepareInput,
  validate,
  collection = "updated",
  useTargetFallback = false,
  fallbackToResult = true,
}) {
  if (!isRemoteBackend(backendClient)) return null;
  requireOperationBridge(backendClient, command);

  let target = null;
  if (preReadTarget) {
    target = await readRemoteNode(
      backendClient,
      targetId,
      command,
      acceptsTarget,
    ).catch((error) => {
      if (error?.code !== "REMOTE_UNSUPPORTED_OPERATION" || !rejectTarget) throw error;
      return rejectTarget(error, targetId);
    });
  }

  const selectedOperation = selectOperation ? selectOperation(target) : operation;
  const remoteInput = { ...input };
  delete remoteInput.actor;
  if (revision && remoteInput[revision.field] === undefined) {
    const value = Number.isInteger(target?.revision) ? target.revision : revision.fallback;
    remoteInput[revision.field] = revision.map ? { [targetId]: value } : value;
  }
  if (prepareInput) prepareInput(remoteInput, target);
  if (validate) validate(remoteInput, target);

  const mutation = await createOperationBridge({ backendClient }).executeOperation({
    actor,
    operation: selectedOperation,
    input: remoteInput,
  });
  return {
    mutation,
    target,
    operation: selectedOperation,
    node: locateRemoteNode(mutation, targetId, collection, useTargetFallback ? target : null, fallbackToResult),
  };
}

export async function executeRemoteDomain({ backendClient, actor, operation, input, command }) {
  const gateRevision = ["gate.resolve", "gate.reopen", "gate.cancel"].includes(operation) && input.id && input.if_revisions === undefined;
  const noteRevision = operation === "note.add" && input.id && input.if_revision === undefined;
  const hasGateCreateRestriction = operation === "gate.create" && input.resolution_mode !== undefined;
  const hasKnowledgeCreateRestriction = operation === "knowledge.create" && input.derived_from !== undefined;

  const routed = await routeRemoteOperation({
    backendClient,
    actor,
    operation,
    input,
    command,
    targetId: gateRevision || noteRevision ? input.id : undefined,
    acceptsTarget: gateRevision
      ? (node) => node.kind === "resolvable" && node.subkind === "gate"
      : () => true,
    revision: gateRevision
      ? { field: "if_revisions", map: true, fallback: 1 }
      : noteRevision
        ? { field: "if_revision", fallback: 1 }
        : null,
    prepareInput: (remoteInput) => {
      if (operation === "knowledge.create" && remoteInput.refs === undefined) remoteInput.refs = [];
    },
    validate: () => {
      if (hasGateCreateRestriction) {
        throwV2("REMOTE_UNSUPPORTED_OPERATION", `${command}: remote gate.create does not support resolution_mode`, { command, field: "resolution_mode" });
      }
      if (hasKnowledgeCreateRestriction) {
        throwV2("REMOTE_UNSUPPORTED_OPERATION", `${command}: remote knowledge.create does not support derived_from`, { command, field: "derived_from" });
      }
    },
  });
  return routed?.mutation ?? null;
}

export function locateRemoteNode(mutation, id, collection = "updated", target = null, fallbackToResult = true) {
  const entries = mutation?.diff?.[collection];
  const fromDiff = Array.isArray(entries) ? entries.find((entry) => entry.id === id)?.node : null;
  return fromDiff || target || mutation?.node || (fallbackToResult ? mutation?.result?.node : null) || null;
}

export function nodeFromMutation(mutation, id, collection = "updated") {
  return locateRemoteNode(mutation, id, collection);
}
