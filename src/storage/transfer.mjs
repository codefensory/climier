import fs from "node:fs/promises";
import { validateStateInvariants } from "../contracts/state-invariants.mjs";
import { prepareLogEntry } from "./log.mjs";
import { withLock } from "./lock.mjs";
import { ledgerFile, bootstrapFencedStateUnderLock, readFencedStateUnderLock, replaceFencedStateUnderLock } from "./ledger.mjs";
import { STATE_SCHEMA_VERSION, stateFile } from "./state.mjs";

export const TRANSFER_PAYLOAD_VERSION = STATE_SCHEMA_VERSION;

function transferError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) {error.details = details;}
  return error;
}

function assertTransferableSource(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw transferError("CLIMIER_TRANSFER_INVALID_SOURCE", "transfer: source project has no valid state");
  }
  if (state.version !== STATE_SCHEMA_VERSION || !Number.isInteger(state.fence_generation)) {
    throw transferError("CLIMIER_TRANSFER_INVALID_SOURCE", "transfer: source state is not canonical version 1");
  }
  validateStateInvariants(state, "transfer.source");
}

function transferPayload(state) {
  const { fence_generation: _fenceGeneration, revision: _revision, ...applicationState } = structuredClone(state);
  applicationState.nodes = Object.fromEntries(Object.entries(applicationState.nodes).map(([id, node]) => {
    const { revision: _nodeRevision, ...applicationNode } = node;
    return [id, applicationNode];
  }));
  return applicationState;
}

function validateTransferPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || payload.version !== TRANSFER_PAYLOAD_VERSION
      || Object.hasOwn(payload, "revision") || Object.hasOwn(payload, "fence_generation")
      || !payload.nodes || typeof payload.nodes !== "object" || Array.isArray(payload.nodes)
      || !Array.isArray(payload.edges)
      || !payload.initiatives || typeof payload.initiatives !== "object" || Array.isArray(payload.initiatives)
      || !Array.isArray(payload.log)) {
    throw transferError("CLIMIER_TRANSFER_INVALID_PAYLOAD", "transfer: payload is not a complete application snapshot");
  }
  const nodes = Object.fromEntries(Object.entries(payload.nodes).map(([id, node]) => {
    if (!node || typeof node !== "object" || Array.isArray(node) || Object.hasOwn(node, "revision")) {
      throw transferError("CLIMIER_TRANSFER_INVALID_PAYLOAD", `transfer: payload node ${id} is invalid or contains a local revision`);
    }
    return [id, { ...node, revision: 0 }];
  }));
  validateStateInvariants({
    ...payload,
    fence_generation: 1,
    revision: 0,
    nodes,
  }, "transfer.payload");
}

function isPristine(state) {
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
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readCanonicalDestinationWithoutLedger(projectDir) {
  const statePath = stateFile(projectDir);
  const raw = await fs.readFile(statePath, "utf8");
  let state;
  try { state = JSON.parse(raw); }
  catch (cause) { throw transferError("CLIMIER_TRANSFER_INVALID_DESTINATION", `transfer: destination state is corrupt: ${cause.message}`); }
  if (state?.version !== STATE_SCHEMA_VERSION || !Number.isInteger(state.fence_generation)) {
    throw transferError("CLIMIER_TRANSFER_INVALID_DESTINATION", `transfer: destination state at ${statePath} is not canonical version ${STATE_SCHEMA_VERSION}; run climier migrate`);
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

function destinationState(payload, current, actor, direction) {
  const nodes = Object.fromEntries(Object.entries(payload.nodes).map(([id, node]) => [id, { ...node, revision: 0 }]));
  const replacedRevision = current?.revision ?? null;
  return {
    ...structuredClone(payload),
    revision: 0,
    fence_generation: current?.fence_generation ?? 1,
    nodes,
    log: [
      ...structuredClone(payload.log),
      prepareLogEntry({
        action: `transfer.${direction}`,
        agent: actor,
        replaced_revision: replacedRevision,
      }),
    ],
  };
}

/** Capture the application snapshot and its revision from one locked state read. */
export async function captureTransferSource(projectDir) {
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
export async function installTransferDestination(projectDir, payload, {
  actor,
  direction,
  expectedRevision,
  force = false,
} = {}) {
  validateTransferPayload(payload);
  if (typeof actor !== "string" || !actor.trim()) {throw new Error("transfer: actor is required");}
  if (direction !== "push" && direction !== "pull") {throw new Error("transfer: direction must be push or pull");}
  if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
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
    const current = await readFencedStateUnderLock(lockContext);
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
