// Durable, project-local revision fence bootstrap. The API intentionally does
// not wire itself into mutation callers; callers must migrate to fenced commits
// before writing state v5.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { stateFile, migrateState, FENCED_STATE_VERSION } from "./state.mjs";
import { withLock } from "./lock.mjs";
import { validateStateInvariants } from "../contracts/state-invariants.mjs";

const LEDGER_VERSION = 1;
const SOURCE_VERSIONS = new Set([2, 3, 4]);
const injectedFault = "injected failure";

export function ledgerFile(projectDir) {
  return path.join(path.dirname(stateFile(projectDir)), "revision-ledger.json");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function maxNodeRevision(state) {
  let max = 0;
  for (const node of Object.values(state.nodes || {})) {
    if (Number.isInteger(node?.revision) && node.revision > max) max = node.revision;
  }
  return max;
}

function readJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    const error = new Error(`ledger: ${label} is corrupt or not valid JSON: ${cause.message}`, { cause });
    error.code = "CLIMIER_CORRUPT_LEDGER";
    throw error;
  }
}

async function durableReplace(file, raw) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(raw, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
  const dirHandle = await fs.open(dir, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

async function persistLedger(file, ledger) {
  await durableReplace(file, `${JSON.stringify(ledger, null, 2)}\n`);
}

function assertValidLedger(ledger) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)
      || ledger.version !== LEDGER_VERSION
      || !Number.isInteger(ledger.fence_generation) || ledger.fence_generation < 1
      || !Number.isInteger(ledger.high_water_revision) || ledger.high_water_revision < 1
      || !(ledger.migration_pending === null || (ledger.migration_pending && typeof ledger.migration_pending === "object"))) {
    const error = new Error("ledger: invalid ledger schema");
    error.code = "CLIMIER_INVALID_LEDGER";
    throw error;
  }
  if (ledger.migration_pending !== null) {
    const pending = ledger.migration_pending;
    if (typeof pending.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pending.source_sha256)
        || typeof pending.destination_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pending.destination_sha256)
        || !Number.isInteger(pending.source_high_water_revision)
        || !Number.isInteger(pending.fence_revision)
        || !Number.isInteger(pending.fence_generation)
        || !Number.isInteger(pending.source_version)) {
      const error = new Error("ledger: invalid migration_pending record");
      error.code = "CLIMIER_INVALID_LEDGER";
      throw error;
    }
  }
}

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

function assertFencedState(state, ledger) {
  if (!state || state.version !== FENCED_STATE_VERSION
      || state.fence_generation !== ledger.fence_generation
      || !Number.isInteger(state.revision) || state.revision !== ledger.high_water_revision
      || maxNodeRevision(state) > ledger.high_water_revision) {
    const error = new Error("ledger: state and revision ledger are inconsistent or indicate legacy downgrade");
    error.code = "CLIMIER_LEDGER_STATE_MISMATCH";
    throw error;
  }
  validateStateInvariants(state, "ledger.read");
}

function fault(opts, point) {
  if (opts.faultAt === point) throw new Error(`${injectedFault} at ${point}`);
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

async function bootstrapLocked(projectDir, opts) {
  const statePath = stateFile(projectDir);
  const ledgerPath = ledgerFile(projectDir);
  await fs.mkdir(path.dirname(statePath), { recursive: true });

  let rawState;
  try {
    rawState = await fs.readFile(statePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const state = {
      version: 4,
      nodes: {},
      edges: [],
      initiatives: {},
      log: [],
      revision: 0,
    };
    rawState = `${JSON.stringify(state, null, 2)}\n`;
    await durableReplace(statePath, rawState);
  }

  let ledger = null;
  try {
    ledger = readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (ledger) {
    assertValidLedger(ledger);
    const state = readJson(rawState, "state");
    if (ledger.migration_pending) {
      return finishPendingMigration({ statePath, ledgerPath, ledger, rawState });
    }
    if (state.version !== FENCED_STATE_VERSION) {
      const error = new Error("ledger: fenced project is missing v5 state marker; refusing legacy downgrade");
      error.code = "CLIMIER_LEDGER_STATE_MISMATCH";
      throw error;
    }
    assertFencedState(state, ledger);
    return state;
  }

  const source = readJson(rawState, "source state");
  if (source.version === FENCED_STATE_VERSION) {
    const error = new Error("ledger: revision ledger is missing for fenced state; refusing reconstruction");
    error.code = "CLIMIER_LEDGER_MISSING";
    throw error;
  }
  const { destination, destinationRaw, highWater, fence } = fencedDestination(source);
  const pending = {
    source_version: source.version,
    source_high_water_revision: highWater,
    fence_revision: fence,
    fence_generation: 1,
    source_sha256: sha256(rawState),
    destination_sha256: sha256(destinationRaw),
  };
  ledger = {
    version: LEDGER_VERSION,
    fence_generation: 1,
    high_water_revision: fence,
    migration_pending: pending,
  };
  fault(opts, "before-pending");
  await persistLedger(ledgerPath, ledger);
  fault(opts, "after-pending");
  await durableReplace(statePath, destinationRaw);
  fault(opts, "after-state-rename");
  return finishPendingMigration({ statePath, ledgerPath, ledger, rawState: destinationRaw });
}

/**
 * Bootstrap a project's monotonic revision ledger and migrate its initial state
 * under the canonical project lock. The optional fault points are for storage
 * crash-recovery tests and are not used by production callers.
 */
export async function bootstrapFencedState(projectDir, opts = {}) {
  return withLock(projectDir, () => bootstrapLocked(projectDir, opts), opts.lockOptions);
}

/** Read a v5 state only when its durable project ledger agrees with it. */
export async function readFencedState(projectDir, opts = {}) {
  return withLock(projectDir, async () => {
    const statePath = stateFile(projectDir);
    const ledgerPath = ledgerFile(projectDir);
    let ledger;
    try {
      ledger = readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger");
    } catch (error) {
      if (error.code === "ENOENT") {
        const missing = new Error("ledger: revision ledger is missing for fenced state; refusing reconstruction");
        missing.code = "CLIMIER_LEDGER_MISSING";
        throw missing;
      }
      throw error;
    }
    assertValidLedger(ledger);
    const rawState = await fs.readFile(statePath, "utf8");
    if (ledger.migration_pending) {
      return finishPendingMigration({ statePath, ledgerPath, ledger, rawState });
    }
    const state = readJson(rawState, "fenced state");
    assertFencedState(state, ledger);
    return state;
  }, opts.lockOptions);
}
