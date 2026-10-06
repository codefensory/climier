import { createOperationBridge } from "../../../application/operations/index.ts";
import { throwV2 } from "../../../contracts/errors.ts";

export function isRemoteBackend(backendClient) {
  return backendClient?.type === "remote";
}

function requireOperationBridge(backendClient, command) {
  if (typeof backendClient?.executeOperation !== "function" || typeof backendClient?.executeBatch !== "function") {
    throwV2("INVALID_OPERATION_BRIDGE", `${command}: remote backend client does not support operation execution`);
  }
}

function requireAcceptedRemoteNode(node, id, command, accepts) {
  if (node && accepts(node)) {
    return node;
  }
  throwV2("REMOTE_UNSUPPORTED_OPERATION", `${command}: remote target is not supported by this adapter`, {
    command, id, kind: node?.kind, subkind: node?.subkind,
  });
}

export async function readRemoteNode(backendClient, id, command, accepts = () => true) {
  if (typeof backendClient?.readNode !== "function") {
    throwV2("INVALID_OPERATION_BRIDGE", `${command}: remote backend client must support node reads`);
  }
  const node = (await backendClient.readNode({ id }))?.node || null;
  return requireAcceptedRemoteNode(node, id, command, accepts);
}

async function readRouteTarget(backendClient, options) {
  const { targetId, command, preReadTarget, acceptsTarget, rejectTarget } = options;
  if (!preReadTarget) {
    return null;
  }
  try {
    return await readRemoteNode(backendClient, targetId, command, acceptsTarget);
  } catch (error) {
    if (error?.code !== "REMOTE_UNSUPPORTED_OPERATION" || !rejectTarget) {
      throw error;
    }
    return rejectTarget(error, targetId);
  }
}

function applyRevision(remoteInput, target, targetId, revision) {
  if (!revision || remoteInput[revision.field] !== undefined) {
    return;
  }
  const value = Number.isInteger(target?.revision) ? target.revision : revision.fallback;
  if (revision.map) {
    remoteInput[revision.field] = { [targetId]: value };
    return;
  }
  remoteInput[revision.field] = value;
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
  if (!isRemoteBackend(backendClient)) {
    return null;
  }
  requireOperationBridge(backendClient, command);
  const routeOptions = { targetId, command, preReadTarget, acceptsTarget, rejectTarget };
  const target = await readRouteTarget(backendClient, routeOptions);
  const selectedOperation = selectOperation ? selectOperation(target) : operation;
  const inputOptions = { revision, prepareInput, validate };
  const remoteInput = prepareRemoteInput(input, target, targetId, inputOptions);
  const mutation = await executeRemoteMutation(backendClient, actor, selectedOperation, remoteInput);
  return buildRoutedResult({
    mutation, operation: selectedOperation, target, targetId,
    collection, useTargetFallback, fallbackToResult,
  });
}

function prepareRemoteInput(input, target, targetId, options) {
  const { revision, prepareInput, validate } = options;
  const remoteInput = { ...input };
  delete remoteInput.actor;
  applyRevision(remoteInput, target, targetId, revision);
  if (prepareInput) {
    prepareInput(remoteInput, target);
  }
  if (validate) {
    validate(remoteInput, target);
  }
  return remoteInput;
}

async function executeRemoteMutation(backendClient, actor, operation, input) {
  return createOperationBridge({ backendClient }).executeOperation({ actor, operation, input });
}

function buildRoutedResult(options) {
  const { mutation, operation, target, targetId, collection, useTargetFallback, fallbackToResult } = options;
  return {
    mutation,
    target,
    operation,
    node: locateRemoteNode(mutation, targetId, {
      collection,
      target: useTargetFallback ? target : null,
      fallbackToResult,
    }),
  };
}

function domainTargetOptions(operation, input) {
  const gateRevision = ["gate.resolve", "gate.reopen", "gate.cancel"].includes(operation)
    && input.id
    && input.if_revisions === undefined;
  if (gateRevision) {
    return {
      targetId: input.id,
      acceptsTarget: (node) => node.kind === "resolvable" && node.subkind === "gate",
      revision: { field: "if_revisions", map: true, fallback: 1 },
    };
  }
  if (operation === "note.add" && input.id && input.if_revision === undefined) {
    return {
      targetId: input.id,
      revision: { field: "if_revision", fallback: 1 },
    };
  }
  return { revision: null };
}

function validateDomainInput(command, operation, input) {
  if (operation === "gate.create" && input.resolution_mode !== undefined) {
    throwV2("REMOTE_UNSUPPORTED_OPERATION", `${command}: remote gate.create does not support resolution_mode`, { command, field: "resolution_mode" });
  }
  if (operation === "knowledge.create" && input.derived_from !== undefined) {
    throwV2("REMOTE_UNSUPPORTED_OPERATION", `${command}: remote knowledge.create does not support derived_from`, { command, field: "derived_from" });
  }
}

export async function executeRemoteDomain({ backendClient, actor, operation, input, command }) {
  const targetOptions = domainTargetOptions(operation, input);
  const routed = await routeRemoteOperation({
    backendClient,
    actor,
    operation,
    input,
    command,
    ...targetOptions,
    prepareInput: (remoteInput) => {
      if (operation === "knowledge.create" && remoteInput.refs === undefined) {
        remoteInput.refs = [];
      }
    },
    validate: () => validateDomainInput(command, operation, input),
  });
  return routed?.mutation ?? null;
}

function findDiffNode(mutation, id, collection) {
  const entries = mutation?.diff?.[collection];
  if (!Array.isArray(entries)) {
    return null;
  }
  return entries.find((entry) => entry.id === id)?.node || null;
}

function resultNode(mutation, fallbackToResult) {
  if (fallbackToResult) {
    return mutation?.result?.node || null;
  }
  return null;
}

function directRemoteNode(mutation, id, options) {
  const { collection = "updated", target = null } = options;
  return findDiffNode(mutation, id, collection) || target || mutation?.node || null;
}

export function locateRemoteNode(mutation, id, options = {}) {
  const directNode = directRemoteNode(mutation, id, options);
  return directNode || resultNode(mutation, options.fallbackToResult !== false);
}

export function nodeFromMutation(mutation, id, collection = "updated") {
  return locateRemoteNode(mutation, id, { collection });
}
