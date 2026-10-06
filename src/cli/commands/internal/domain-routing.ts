import { createOperationBridge } from "../../../application/operations/index.ts";
import { asCaughtError, throwV2 } from "../../../contracts/errors.ts";
import type { CliBackendClient, CliMutation, CliNode } from "../contracts.ts";

type RouteOptions = {
  backendClient?: CliBackendClient;
  actor: string;
  operation: string;
  input: Record<string, unknown>;
  command: string;
  targetId?: string;
  preReadTarget?: boolean;
  acceptsTarget?: (node: CliNode) => boolean;
  rejectTarget?: (error: Error, targetId: string) => never;
  selectOperation?: (target: CliNode | null) => string;
  revision?: { field: string; map?: boolean; fallback: number } | null;
  prepareInput?: (input: Record<string, unknown>, target: CliNode | null) => void;
  validate?: (input: Record<string, unknown>, target: CliNode | null) => void;
  collection?: string;
  useTargetFallback?: boolean;
  fallbackToResult?: boolean;
};

export function isRemoteBackend(backendClient: CliBackendClient | undefined): backendClient is CliBackendClient & { type: "remote" } {
  return backendClient?.type === "remote";
}

function requireOperationBridge(backendClient: CliBackendClient, command: string) {
  if (typeof backendClient?.executeOperation !== "function" || typeof backendClient?.executeBatch !== "function") {
    throwV2("INVALID_OPERATION_BRIDGE" as Parameters<typeof throwV2>[0], `${command}: remote backend client does not support operation execution`);
  }
}

function requireAcceptedRemoteNode(node: CliNode | null, id: string, command: string, accepts: (node: CliNode) => boolean) {
  if (node && accepts(node)) {
    return node;
  }
  throwV2("REMOTE_UNSUPPORTED_OPERATION", `${command}: remote target is not supported by this adapter`, {
    command, id, kind: node?.kind, subkind: node?.subkind,
  });
}

export async function readRemoteNode(backendClient: CliBackendClient, id: string, command: string, accepts: (node: CliNode) => boolean = () => true): Promise<CliNode> {
  if (typeof backendClient?.readNode !== "function") {
    throwV2("INVALID_OPERATION_BRIDGE" as Parameters<typeof throwV2>[0], `${command}: remote backend client must support node reads`);
  }
  const node = (await backendClient.readNode({ id }))?.node || null;
  return requireAcceptedRemoteNode(node, id, command, accepts);
}

async function readRouteTarget(backendClient: CliBackendClient, options: Pick<RouteOptions, "targetId" | "command" | "preReadTarget" | "acceptsTarget" | "rejectTarget">) {
  const { targetId, command, preReadTarget, acceptsTarget = () => true, rejectTarget } = options;
  if (!preReadTarget) {
    return null;
  }
  try {
    return await readRemoteNode(backendClient, targetId as string, command, acceptsTarget);
  } catch (error) {
    const caught = asCaughtError(error);
    if (caught.code !== "REMOTE_UNSUPPORTED_OPERATION" || !rejectTarget) {
      throw caught;
    }
    return rejectTarget(caught, targetId as string);
  }
}

function applyRevision(remoteInput: Record<string, unknown>, target: CliNode | null, targetId: string | undefined, revision: RouteOptions["revision"]) {
  if (!revision || remoteInput[revision.field] !== undefined) {
    return;
  }
  const value = Number.isInteger(target?.revision) ? target!.revision as number : revision.fallback;
  if (revision.map) {
    remoteInput[revision.field] = { [targetId as string]: value };
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
}: RouteOptions): Promise<{ mutation: CliMutation; target: CliNode | null; operation: string; node: CliNode | null } | null> {
  if (!isRemoteBackend(backendClient)) {
    return null;
  }
  if (!isRemoteBackend(backendClient)) {
    return null;
  }
  requireOperationBridge(backendClient, command);
  const routeOptions = { targetId, command, preReadTarget, acceptsTarget: acceptsTarget ?? (() => true), rejectTarget };
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

function prepareRemoteInput(input: Record<string, unknown>, target: CliNode | null, targetId: string | undefined, options: Pick<RouteOptions, "revision" | "prepareInput" | "validate">): Record<string, unknown> {
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

async function executeRemoteMutation(backendClient: CliBackendClient, actor: string, operation: string, input: Record<string, unknown>): Promise<CliMutation> {
  return await createOperationBridge({ backendClient }).executeOperation({ actor, operation, input }) as CliMutation;
}

function buildRoutedResult(options: { mutation: CliMutation; operation: string; target: CliNode | null; targetId?: string; collection?: string; useTargetFallback?: boolean; fallbackToResult?: boolean }) {
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

function domainTargetOptions(operation: string, input: Record<string, unknown>): Pick<RouteOptions, "targetId" | "acceptsTarget" | "revision"> {
  const gateRevision = ["gate.resolve", "gate.reopen", "gate.cancel"].includes(operation)
    && input.id
    && input.if_revisions === undefined;
  if (gateRevision) {
    return {
      targetId: input.id as string,
      acceptsTarget: (node) => node.kind === "resolvable" && node.subkind === "gate",
      revision: { field: "if_revisions", map: true, fallback: 1 },
    };
  }
  if (operation === "note.add" && input.id && input.if_revision === undefined) {
    return {
      targetId: input.id as string,
      revision: { field: "if_revision", fallback: 1 },
    };
  }
  return { revision: null };
}

function validateDomainInput(command: string, operation: string, input: Record<string, unknown>) {
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

function findDiffNode(mutation: CliMutation, id: string | undefined, collection = "updated"): CliNode | null {
  const entries = mutation?.diff?.[collection];
  if (!Array.isArray(entries)) {
    return null;
  }
  return (entries as Array<{ id: string; node?: CliNode }>).find((entry) => entry.id === id)?.node || null;
}

function resultNode(mutation: CliMutation, fallbackToResult: boolean | undefined): CliNode | null {
  if (fallbackToResult) {
    return (mutation?.result?.node as CliNode | undefined) || null;
  }
  return null;
}

function directRemoteNode(mutation: CliMutation, id: string | undefined, options: { collection?: string; target?: CliNode | null }): CliNode | null {
  const { collection = "updated", target = null } = options;
  return findDiffNode(mutation, id, collection) || target || (mutation?.node as CliNode | undefined) || null;
}

export function locateRemoteNode(mutation: CliMutation, id: string | undefined, options: { collection?: string; target?: CliNode | null; fallbackToResult?: boolean } = {}): CliNode | null {
  const directNode = directRemoteNode(mutation, id, options);
  return directNode || resultNode(mutation, options.fallbackToResult !== false);
}

export function nodeFromMutation(mutation: CliMutation, id: string, collection = "updated"): CliNode | null {
  return locateRemoteNode(mutation, id, { collection });
}
