import fs from "node:fs/promises";
import { validateStateInvariants } from "../contracts/state-invariants.mjs";
import { withLock } from "./lock.mjs";
import { ledgerFile, bootstrapFencedStateUnderLock, readFencedStateUnderLock, replaceFencedStateUnderLock } from "./ledger.mjs";
import { migrateState, stateFile } from "./state.mjs";

function transferError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nonEmptyObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

function hasPluginData(state) {
  if (nonEmptyObject(state.plugins)) return true;
  return Object.values(state.nodes || {}).some((node) => nonEmptyObject(node?.plugins));
}

function assertTransferableSource(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw transferError("CLIMIER_TRANSFER_INVALID_SOURCE", "transfer: source project has no valid state");
  }
  validateStateInvariants(state, "transfer.source");
  if (hasPluginData(state)
      || Object.values(state.nodes).some((node) => node?.status === "in_progress"
        || (node?.claim !== undefined && node.claim !== null && node.claim !== false && node.claim !== ""))) {
    throw transferError("CLIMIER_TRANSFER_INVALID_SOURCE", "transfer: source has active claims, in-progress work, or plugin data");
  }
}

function transferPayload(state) {
  const nodes = Object.fromEntries(Object.entries(state.nodes).map(([id, node]) => {
    const { revision: _revision, plugins: _plugins, ...transferNode } = node;
    return [id, transferNode];
  }));
  return {
    version: 4,
    revision: 0,
    nodes,
    edges: structuredClone(state.edges),
    initiatives: structuredClone(state.initiatives),
    log: structuredClone(state.log),
  };
}

function isPristine(state) {
  return Object.keys(state.nodes).length === 0
    && state.edges.length === 0
    && Object.keys(state.initiatives).length === 0
    && state.log.length === 0;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readLegacyDestinationWithoutMigration(lockContext, projectDir) {
  const statePath = stateFile(projectDir);
  const raw = await fs.readFile(statePath, "utf8");
  let state;
  try {
    state = JSON.parse(raw);
  } catch (cause) {
    throw transferError("CLIMIER_TRANSFER_INVALID_DESTINATION", `transfer: destination state is corrupt: ${cause.message}`);
  }
  const migrated = migrateState(state);
  validateStateInvariants(migrated, "transfer.destination");
  return migrated;
}

/** Capture and validate a complete source snapshot while holding its own lock. */
export async function captureTransferSource(projectDir) {
  return withLock(projectDir, async (lockContext) => {
    const state = await readFencedStateUnderLock(lockContext);
    if (!state) throw transferError("CLIMIER_TRANSFER_INVALID_SOURCE", "transfer: source project has no state");
    assertTransferableSource(state);
    return transferPayload(state);
  });
}

/** Install a snapshot with create-only or absolute-overwrite semantics under the destination lock. */
export async function installTransferDestination(projectDir, payload, { overwrite = false } = {}) {
  return withLock(projectDir, async (lockContext) => {
    const statePath = stateFile(projectDir);
    const revisionLedger = ledgerFile(projectDir);
    const hasState = await exists(statePath);
    const hasLedger = await exists(revisionLedger);
    let current = null;

    if (!hasState && !hasLedger) {
      return bootstrapFencedStateUnderLock(lockContext, payload);
    }

    if (hasState && !hasLedger) {
      const rawState = await fs.readFile(statePath, "utf8");
      let unmigrated;
      try {
        unmigrated = JSON.parse(rawState);
      } catch (cause) {
        throw transferError("CLIMIER_TRANSFER_INVALID_DESTINATION", `transfer: destination state is corrupt: ${cause.message}`);
      }
      if (unmigrated.version !== 5) {
        current = await readLegacyDestinationWithoutMigration(lockContext, projectDir);
        if (hasPluginData(current)) throw transferError("CLIMIER_TRANSFER_PLUGIN_DATA", "transfer: destination plugin data cannot be overwritten");
        if (!overwrite && !isPristine(current)) {
          throw transferError("CLIMIER_TRANSFER_DESTINATION_NOT_PRISTINE", "transfer: destination is not pristine; explicit overwrite is required");
        }
      }
    }

    current = await readFencedStateUnderLock(lockContext);
    if (!current) throw transferError("CLIMIER_TRANSFER_INVALID_DESTINATION", "transfer: destination ledger exists without state");
    if (hasPluginData(current)) throw transferError("CLIMIER_TRANSFER_PLUGIN_DATA", "transfer: destination plugin data cannot be overwritten");
    if (!overwrite && !isPristine(current)) {
      throw transferError("CLIMIER_TRANSFER_DESTINATION_NOT_PRISTINE", "transfer: destination is not pristine; explicit overwrite is required");
    }
    return replaceFencedStateUnderLock(lockContext, payload);
  });
}

export { hasPluginData as transferHasPluginData };
