import { asCaughtError } from "../contracts/errors.ts";
import fs from "node:fs/promises";
import { validateStateInvariants } from "../contracts/state-invariants.ts";
import { prepareLogEntry } from "./log.ts";
import { withLock } from "./lock.ts";
import { ledgerFile, bootstrapFencedStateUnderLock, readFencedStateUnderLock, replaceFencedStateUnderLock } from "./ledger.ts";
import { STATE_SCHEMA_VERSION, stateFile } from "./state.ts";

export const TRANSFER_PAYLOAD_VERSION = STATE_SCHEMA_VERSION;

type TransferNode = Record<string, unknown> & { revision?: number };
type TransferState = Record<string, unknown> & {
  version: number;
  fence_generation: number;
  revision: number;
  nodes: Record<string, TransferNode>;
  edges: unknown[];
  initiatives: Record<string, unknown>;
  log: unknown[];
};
type TransferPayload = Omit<TransferState, "fence_generation" | "revision">;
type TransferOptions = { actor?: string; direction?: "push" | "pull"; expectedRevision?: number; force?: boolean };

function transferError(code, message, details?: Record<string, unknown>) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) {error.details = details;}
  return error;
}

function assertTransferableSource(state: unknown): asserts state is TransferState {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw transferError("CLIMIER_TRANSFER_INVALID_SOURCE", "transfer: source project has no valid state");
  }
  const value = state as Record<string, unknown>;
  if (value.version !== STATE_SCHEMA_VERSION || !Number.isInteger(value.fence_generation)) {
    throw transferError("CLIMIER_TRANSFER_INVALID_SOURCE", "transfer: source state is not canonical version 1");
  }
  validateStateInvariants(value, "transfer.source");
}

function transferPayload(state: TransferState): TransferPayload {
  const cloned = structuredClone(state);
  const { fence_generation: _fenceGeneration, revision: _revision, ...applicationState } = cloned;
  applicationState.nodes = Object.fromEntries(Object.entries(applicationState.nodes as Record<string, unknown>).map(([id, node]) => {
    const { revision: _nodeRevision, ...applicationNode } = node as Record<string, unknown>;
    return [id, applicationNode];
  }));
  return applicationState;
}

function validateTransferPayload(payload: unknown): asserts payload is TransferPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw transferError("CLIMIER_TRANSFER_INVALID_PAYLOAD", "transfer: payload is not a complete application snapshot");
  }
  const value = payload as Record<string, unknown>;
  if (value.version !== TRANSFER_PAYLOAD_VERSION
      || Object.hasOwn(value, "revision") || Object.hasOwn(value, "fence_generation")
      || !value.nodes || typeof value.nodes !== "object" || Array.isArray(value.nodes)
      || !Array.isArray(value.edges)
      || !value.initiatives || typeof value.initiatives !== "object" || Array.isArray(value.initiatives)
      || !Array.isArray(value.log)) {
    throw transferError("CLIMIER_TRANSFER_INVALID_PAYLOAD", "transfer: payload is not a complete application snapshot");
  }
  const nodes = Object.fromEntries(Object.entries(value.nodes as Record<string, TransferNode>).map(([id, node]) => {
    if (!node || typeof node !== "object" || Array.isArray(node) || Object.hasOwn(node, "revision")) {
      throw transferError("CLIMIER_TRANSFER_INVALID_PAYLOAD", `transfer: payload node ${id} is invalid or contains a local revision`);
    }
    return [id, { ...node, revision: 0 }];
  }));
  validateStateInvariants({
    ...value,
    fence_generation: 1,
    revision: 0,
    nodes,
  }, "transfer.payload");
}

function isPristine(state: TransferState): boolean {
  const knownFields = new Set([
    "version", "fence_generation", "revision", "nodes", "edges", "initiatives", "log", "plugins",
  ]);
  const plugins = state.plugins;
  const hasPluginData = Object.hasOwn(state, "plugins")
    && (!plugins || typeof plugins !== "object" || Array.isArray(plugins) || Object.keys(plugins).length > 0);
  const hasUnknownApplicationData = Object.keys(state).some((field) => !knownFields.has(field));
  return Object.keys(state.nodes).length === 0
    && state.edges.length === 0
    && Object.keys(state.initiatives).length === 0
    && state.log.length === 0
    && !hasPluginData
    && !hasUnknownApplicationData;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (rawCaughtValue: unknown) {
  {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;

  }}
}

async function readCanonicalDestinationWithoutLedger(projectDir) {
  const statePath = stateFile(projectDir);
  const raw = await fs.readFile(statePath, "utf8");
  let state;
  try { state = JSON.parse(raw); }
  catch (rawCaughtValue: unknown) {
  {
    const cause = asCaughtError(rawCaughtValue); throw transferError("CLIMIER_TRANSFER_INVALID_DESTINATION", `transfer: destination state is corrupt: ${cause.message}`);
  }}
  if (state?.version !== STATE_SCHEMA_VERSION || !Number.isInteger(state.fence_generation)) {
    throw transferError("CLIMIER_TRANSFER_INVALID_DESTINATION", `transfer: destination state at ${statePath} is not canonical version ${STATE_SCHEMA_VERSION}; restore a verified backup or contact the maintainer.`);
  }
  validateStateInvariants(state, "transfer.destination");
  return state;
}

function assertExpectedRevision(current, expectedRevision) {
  if (current?.revision !== expectedRevision) {
    throw transferError("CLIMIER_TRANSFER_REVISION_MISMATCH", "transfer: destination revision does not match expected revision", {
      expected_revision: expectedRevision,
      current_revision: current?.revision ?? null,
    });
  }
}

function destinationState(payload: TransferPayload, current: TransferState | null, actor: string, direction: "push" | "pull"): TransferState {
  const nodes = Object.fromEntries(Object.entries(payload.nodes as Record<string, TransferNode>).map(([id, node]) => [id, { ...node, revision: 0 }]));
  const replacedRevision = current?.revision ?? null;
  const clonedPayload = structuredClone(payload) as TransferPayload;
  return {
    ...clonedPayload,
    version: clonedPayload.version as number,
    edges: clonedPayload.edges as unknown[],
    initiatives: clonedPayload.initiatives as Record<string, unknown>,
    revision: 0,
    fence_generation: current?.fence_generation ?? 1,
    nodes,
    log: [
      ...(structuredClone(payload.log) as unknown[]),
      prepareLogEntry({
        action: `transfer.${direction}`,
        agent: actor,
        replaced_revision: replacedRevision,
      }),
    ],
  };
}

/** Capture the application snapshot and its revision from one locked state read. */
export async function captureTransferSource(projectDir: string): Promise<{ payload: TransferPayload; revision: number }> {
  return withLock(projectDir, async (lockContext) => {
    const state = await readFencedStateUnderLock(lockContext);
    if (!state) {
      throw transferError("CLIMIER_TRANSFER_INVALID_SOURCE", "transfer: source project has no state");
    }
    assertTransferableSource(state);
    return { payload: transferPayload(state), revision: state.revision };
  });
}

/** Install a validated snapshot with an optional destination CAS under one lock. */
export async function installTransferDestination(projectDir: string, payload: unknown, {
  actor,
  direction,
  expectedRevision,
  force = false,
}: TransferOptions = {}): Promise<unknown> {
  validateTransferPayload(payload);
  if (typeof actor !== "string" || !actor.trim()) {throw new Error("transfer: actor is required");}
  if (direction !== "push" && direction !== "pull") {throw new Error("transfer: direction must be push or pull");}
  if (expectedRevision !== undefined && (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0)) {
    throw new Error("transfer: expectedRevision must be a non-negative integer");
  }
  if (typeof force !== "boolean") {throw new Error("transfer: force must be boolean");}

  return withLock(projectDir, async (lockContext) => {
    const statePath = stateFile(projectDir);
    const hasState = await exists(statePath);
    const hasLedger = await exists(ledgerFile(projectDir));
    if (!hasState && !hasLedger) {
      if (expectedRevision !== undefined && !force) {assertExpectedRevision(null, expectedRevision);}
      return bootstrapFencedStateUnderLock(lockContext, destinationState(payload, null, actor, direction));
    }
    if (hasState && !hasLedger) {
      await readCanonicalDestinationWithoutLedger(projectDir);
    }
    const current = await readFencedStateUnderLock(lockContext) as TransferState | null;
    if (!current) {
      throw transferError("CLIMIER_TRANSFER_INVALID_DESTINATION", "transfer: destination ledger exists without state");
    }
    if (!force) {
      if (expectedRevision !== undefined) {
        assertExpectedRevision(current, expectedRevision);
      } else if (!isPristine(current)) {
        throw transferError("CLIMIER_TRANSFER_DESTINATION_NOT_PRISTINE", "transfer: destination is not pristine; an expected revision or explicit force is required");
      }
    }
    return replaceFencedStateUnderLock(lockContext, destinationState(payload, current, actor, direction));
  });
}
