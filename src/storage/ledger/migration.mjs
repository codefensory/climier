// Durable migration protocol for legacy project states.
import { FENCED_STATE_VERSION, migrateState } from "../state.mjs";
import { validateStateInvariants } from "../../contracts/state-invariants.mjs";
import { SOURCE_VERSIONS } from "./recovery.mjs";
import { assertFencedState, durableReplace, maxNodeRevision, persistLedger, readJson, sha256 } from "./stages.mjs";

function fencedDestination(source) {
  if (!source || typeof source !== "object" || Array.isArray(source) || !SOURCE_VERSIONS.has(source.version)) {
    const error = new Error(`ledger: cannot bootstrap unsupported state version ${source?.version}`);
    error.code = "CLIMIER_UNSUPPORTED_SOURCE_VERSION";
    throw error;
  }
  const compatible = migrateState(source);
  if (!compatible || typeof compatible !== "object" || !compatible.nodes || typeof compatible.nodes !== "object") {
    throw new Error("ledger: source state has an invalid nodes collection");
  }
  validateStateInvariants(compatible, "ledger.bootstrap");
  const highWater = Math.max(
    Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
    maxNodeRevision(compatible),
  );
  const fence = highWater + 1;
  const destination = {
    ...compatible,
    version: FENCED_STATE_VERSION,
    revision: fence,
    fence_generation: 1,
    nodes: Object.fromEntries(Object.entries(compatible.nodes).map(([id, node]) => [id, { ...node, revision: fence }])),
  };
  validateStateInvariants(destination, "ledger.bootstrap.destination");
  const destinationRaw = `${JSON.stringify(destination, null, 2)}\n`;
  return { destination, destinationRaw, highWater, fence };
}

async function finishPendingMigration({ statePath, ledgerPath, ledger, rawState }) {
  const pending = ledger.migration_pending;
  const currentHash = sha256(rawState);
  if (currentHash === pending.source_sha256) {
    const source = readJson(rawState, "source state");
    const { destinationRaw, highWater, fence } = fencedDestination(source);
    if (sha256(destinationRaw) !== pending.destination_sha256
        || highWater !== pending.source_high_water_revision
        || fence !== pending.fence_revision
        || fence !== ledger.high_water_revision
        || source.version !== pending.source_version) {
      const error = new Error("ledger: pending migration fingerprint or reserved revision does not match source state");
      error.code = "CLIMIER_LEDGER_FINGERPRINT_MISMATCH";
      throw error;
    }
    await durableReplace(statePath, destinationRaw);
    rawState = destinationRaw;
  } else if (currentHash === pending.destination_sha256) {
    const destination = readJson(rawState, "destination state");
    if (destination.version !== FENCED_STATE_VERSION
        || destination.fence_generation !== pending.fence_generation
        || destination.revision !== pending.fence_revision
        || destination.revision !== ledger.high_water_revision) {
      const error = new Error("ledger: pending destination fingerprint does not match state");
      error.code = "CLIMIER_LEDGER_FINGERPRINT_MISMATCH";
      throw error;
    }
  } else {
    const error = new Error("ledger: state fingerprint diverged from pending migration; explicit recovery is required");
    error.code = "CLIMIER_LEDGER_FINGERPRINT_MISMATCH";
    throw error;
  }

  const completedState = readJson(rawState, "fenced state");
  assertFencedState(completedState, ledger);
  ledger.migration_pending = null;
  ledger.last_migration = {
    source_sha256: pending.source_sha256,
    destination_sha256: pending.destination_sha256,
    source_version: pending.source_version,
    high_water_revision: pending.source_high_water_revision,
    fence_revision: pending.fence_revision,
    fence_generation: pending.fence_generation,
  };
  await persistLedger(ledgerPath, ledger);
  return completedState;
}


export { fencedDestination, finishPendingMigration };
