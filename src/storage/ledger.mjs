// Durable, project-local revision fence bootstrap. The API intentionally does
// not wire itself into mutation callers; callers must migrate to fenced commits
// before writing state v5.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { stateFile, migrateState, FENCED_STATE_VERSION } from "./state.mjs";
import { withLock, withCurrentProjectLock, assertActiveLockContext, getActiveLockContext } from "./lock.mjs";
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

async function durableCreate(file, raw) {
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
  const dirHandle = await fs.open(dir, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
  try {
    await fs.link(temp, file);
  } finally {
    await fs.unlink(temp).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  const syncedDir = await fs.open(dir, "r");
  try {
    await syncedDir.sync();
  } finally {
    await syncedDir.close();
  }
}

function bootstrapStagePath(statePath, stageId) {
  return path.join(path.dirname(statePath), `.bootstrap-stage-${stageId}`);
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertValidLedger(ledger) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)
      || ledger.version !== LEDGER_VERSION
      || !Number.isInteger(ledger.fence_generation) || ledger.fence_generation < 1
      || !Number.isInteger(ledger.high_water_revision) || ledger.high_water_revision < 1
      || !(ledger.migration_pending === null || (ledger.migration_pending && typeof ledger.migration_pending === "object"))
      || !(ledger.commit_pending === undefined || ledger.commit_pending === null
        || (ledger.commit_pending && typeof ledger.commit_pending === "object"))
      || !(ledger.bootstrap_pending === undefined || ledger.bootstrap_pending === null
        || (ledger.bootstrap_pending && typeof ledger.bootstrap_pending === "object"))) {
    const error = new Error("ledger: invalid ledger schema");
    error.code = "CLIMIER_INVALID_LEDGER";
    throw error;
  }
  if ((ledger.migration_pending !== null && ledger.commit_pending != null)
      || (ledger.bootstrap_pending != null && (ledger.migration_pending !== null || ledger.commit_pending != null))) {
    const error = new Error("ledger: bootstrap, migration, and commit recovery markers cannot coexist");
    error.code = "CLIMIER_INVALID_LEDGER";
    throw error;
  }
  if (ledger.bootstrap_pending != null) {
    const pending = ledger.bootstrap_pending;
    if (typeof pending.destination_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pending.destination_sha256)
        || typeof pending.stage_id !== "string" || !/^[a-f0-9]{32}$/.test(pending.stage_id)
        || !Number.isInteger(pending.fence_generation) || pending.fence_generation !== ledger.fence_generation
        || !Number.isInteger(pending.high_water_revision) || pending.high_water_revision !== ledger.high_water_revision) {
      const error = new Error("ledger: invalid bootstrap_pending record");
      error.code = "CLIMIER_INVALID_LEDGER";
      throw error;
    }
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
  if (ledger.commit_pending != null) {
    const pending = ledger.commit_pending;
    if (typeof pending.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pending.source_sha256)
        || typeof pending.destination_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pending.destination_sha256)
        || typeof pending.stage_id !== "string" || !/^[a-f0-9]{32}$/.test(pending.stage_id)
        || !Number.isInteger(pending.source_high_water_revision) || pending.source_high_water_revision < 1
        || !Number.isInteger(pending.high_water_revision) || pending.high_water_revision !== ledger.high_water_revision
        || pending.high_water_revision < pending.source_high_water_revision
        || !Number.isInteger(pending.fence_generation) || pending.fence_generation !== ledger.fence_generation) {
      const error = new Error("ledger: invalid commit_pending record");
      error.code = "CLIMIER_INVALID_LEDGER";
      throw error;
    }
  }
}

function fencedInitialState(initialState) {
  if (!initialState || typeof initialState !== "object" || Array.isArray(initialState)
      || !SOURCE_VERSIONS.has(initialState.version)) {
    const error = new Error(`ledger.bootstrap: unsupported initial state version ${initialState?.version}`);
    error.code = "CLIMIER_UNSUPPORTED_SOURCE_VERSION";
    throw error;
  }
  const migrated = migrateState(initialState);
  const compatible = {
    ...migrated,
    nodes: Object.fromEntries(Object.entries(migrated.nodes || {}).map(([id, node]) => [id, { ...node }])),
  };
  validateStateInvariants(compatible, "ledger.bootstrap.initial");
  const highWater = Math.max(
    Number.isInteger(compatible.revision) && compatible.revision >= 0 ? compatible.revision : 0,
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
  validateStateInvariants(destination, "ledger.bootstrap.initial.destination");
  return { destination, destinationRaw: `${JSON.stringify(destination, null, 2)}\n`, highWater: fence };
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

function commitStagePath(statePath, stageId) {
  return path.join(path.dirname(statePath), `.commit-stage-${stageId}`);
}

function fingerprintMismatch(message) {
  const error = new Error(`ledger: ${message}`);
  error.code = "CLIMIER_LEDGER_FINGERPRINT_MISMATCH";
  return error;
}

async function writeDurableStage(stagePath, destinationRaw) {
  const handle = await fs.open(stagePath, "wx", 0o600);
  try {
    await handle.writeFile(destinationRaw, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await fs.open(path.dirname(stagePath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readCommitStage(stagePath, pending) {
  let raw;
  try {
    raw = await fs.readFile(stagePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw fingerprintMismatch("commit stage is missing; explicit recovery is required");
    throw error;
  }
  if (sha256(raw) !== pending.destination_sha256) {
    throw fingerprintMismatch("commit stage does not match the pending destination fingerprint");
  }
  const destination = readJson(raw, "commit stage");
  if (destination.version !== FENCED_STATE_VERSION
      || destination.fence_generation !== pending.fence_generation
      || destination.revision !== pending.high_water_revision) {
    throw fingerprintMismatch("commit stage state does not match reserved generation or high-water revision");
  }
  validateStateInvariants(destination, "ledger.commit.stage");
  return raw;
}

async function cleanOrphanCommitStages(statePath) {
  const directory = path.dirname(statePath);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let changed = false;
  for (const entry of entries) {
    if (entry.isFile() && /^\\.commit-stage-[a-f0-9]{32}$/.test(entry.name)) {
      await fs.unlink(path.join(directory, entry.name));
      changed = true;
    }
  }
  if (changed) {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function finishPendingCommit({ statePath, ledgerPath, ledger, rawState, opts = {} }) {
  const pending = ledger.commit_pending;
  const sourceHash = sha256(rawState);
  const stagePath = commitStagePath(statePath, pending.stage_id);
  const stagedDestination = await readCommitStage(stagePath, pending);
  if (sourceHash === pending.source_sha256) {
    const source = readJson(rawState, "commit source state");
    if (source.version !== FENCED_STATE_VERSION
        || source.fence_generation !== pending.fence_generation
        || source.revision !== pending.source_high_water_revision
        || source.revision > ledger.high_water_revision) {
      throw fingerprintMismatch("commit source does not match its reserved generation or source high-water revision");
    }
    validateStateInvariants(source, "ledger.commit.source");
    if (pending.high_water_revision < ledger.high_water_revision) {
      throw fingerprintMismatch("commit reservation regressed the durable high-water revision");
    }
    fault(opts, "before-state-rename");
    await durableReplace(statePath, stagedDestination);
    rawState = stagedDestination;
    fault(opts, "after-state-rename");
  } else if (sourceHash !== pending.destination_sha256) {
    throw fingerprintMismatch("state fingerprint diverged from pending commit; explicit recovery is required");
  }

  const destination = readJson(rawState, "committed state");
  if (destination.fence_generation !== pending.fence_generation
      || destination.revision !== pending.high_water_revision
      || sha256(rawState) !== pending.destination_sha256) {
    throw fingerprintMismatch("installed destination does not match pending commit");
  }
  assertFencedState(destination, {
    fence_generation: pending.fence_generation,
    high_water_revision: pending.high_water_revision,
  });
  ledger.high_water_revision = pending.high_water_revision;
  ledger.commit_pending = null;
  fault(opts, "before-ledger-clear");
  await persistLedger(ledgerPath, ledger);
  fault(opts, "after-ledger-clear");
  await fs.unlink(stagePath);
  const directory = await fs.open(path.dirname(stagePath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return destination;
}

async function finishPendingBootstrap({ statePath, ledgerPath, ledger, expectedDestinationRaw }) {
  const pending = ledger.bootstrap_pending;
  if (!pending) return null;
  if (expectedDestinationRaw && sha256(expectedDestinationRaw) !== pending.destination_sha256) {
    throw fingerprintMismatch("retry initial state does not match the pending bootstrap destination");
  }
  const stagePath = bootstrapStagePath(statePath, pending.stage_id);
  let rawState;
  try {
    rawState = await fs.readFile(statePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (rawState !== undefined) {
    if (sha256(rawState) !== pending.destination_sha256) {
      throw fingerprintMismatch("state diverged from the pending bootstrap destination");
    }
  } else {
    let staged;
    try {
      staged = await fs.readFile(stagePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") throw fingerprintMismatch("bootstrap stage is missing; explicit recovery is required");
      throw error;
    }
    if (sha256(staged) !== pending.destination_sha256) {
      throw fingerprintMismatch("bootstrap stage does not match the pending destination fingerprint");
    }
    const candidate = readJson(staged, "bootstrap stage");
    assertFencedState(candidate, ledger);
    try {
      await fs.link(stagePath, statePath);
      await syncDirectory(path.dirname(statePath));
      rawState = staged;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      rawState = await fs.readFile(statePath, "utf8");
      if (sha256(rawState) !== pending.destination_sha256) {
        throw fingerprintMismatch("state appeared with a different bootstrap destination");
      }
    }
  }
  const state = readJson(rawState, "bootstrapped state");
  assertFencedState(state, ledger);
  ledger.bootstrap_pending = null;
  await persistLedger(ledgerPath, ledger);
  await fs.unlink(stagePath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await syncDirectory(path.dirname(statePath));
  return state;
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

async function cleanOrphanBootstrapStages(statePath) {
  const directory = path.dirname(statePath);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  let changed = false;
  for (const entry of entries) {
    if (entry.isFile() && /^\\.bootstrap-stage-[a-f0-9]{32}$/.test(entry.name)) {
      await fs.unlink(path.join(directory, entry.name));
      changed = true;
    }
  }
  if (changed) await syncDirectory(directory);
}

function bootstrapExists() {
  const error = new Error("ledger.bootstrap: state or revision ledger already exists; refusing to overwrite it");
  error.code = "CLIMIER_FENCED_BOOTSTRAP_EXISTS";
  return error;
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function bootstrapInitialUnderLock(lockContext, initialState, opts = {}) {
  assertActiveLockContext(lockContext, opts.projectDir);
  const { projectDir, statePath } = getActiveLockContext(lockContext);
  const ledgerPath = ledgerFile(projectDir);
  const prepared = fencedInitialState(initialState);
  const destinationHash = sha256(prepared.destinationRaw);
  await fs.mkdir(path.dirname(statePath), { recursive: true });

  const hasState = await fileExists(statePath);
  const hasLedger = await fileExists(ledgerPath);
  if (hasLedger) {
    let ledger;
    try {
      ledger = readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger");
      assertValidLedger(ledger);
    } catch (error) {
      if (error.code === "ENOENT") throw bootstrapExists();
      if (error.code === "CLIMIER_CORRUPT_LEDGER" || error.code === "CLIMIER_INVALID_LEDGER") throw bootstrapExists();
      throw error;
    }
    if (ledger.bootstrap_pending == null) throw bootstrapExists();
    return finishPendingBootstrap({
      statePath,
      ledgerPath,
      ledger,
      expectedDestinationRaw: prepared.destinationRaw,
    });
  }
  if (hasState) throw bootstrapExists();

  await cleanOrphanBootstrapStages(statePath);
  const stageId = crypto.randomBytes(16).toString("hex");
  const stagePath = bootstrapStagePath(statePath, stageId);
  const ledger = {
    version: LEDGER_VERSION,
    fence_generation: 1,
    high_water_revision: prepared.highWater,
    migration_pending: null,
    commit_pending: null,
    bootstrap_pending: {
      destination_sha256: destinationHash,
      stage_id: stageId,
      fence_generation: 1,
      high_water_revision: prepared.highWater,
    },
  };
  await writeDurableStage(stagePath, prepared.destinationRaw);
  fault(opts, "before-pending");
  await durableCreate(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  fault(opts, "after-pending");
  try {
    await fs.link(stagePath, statePath);
  } catch (error) {
    if (error.code === "EEXIST") throw bootstrapExists();
    throw error;
  }
  await syncDirectory(path.dirname(statePath));
  fault(opts, "after-state-create");
  return finishPendingBootstrap({
    statePath,
    ledgerPath,
    ledger,
    expectedDestinationRaw: prepared.destinationRaw,
  });
}

async function bootstrapLocked(projectDir, opts) {
  const statePath = stateFile(projectDir);
  const ledgerPath = ledgerFile(projectDir);
  await fs.mkdir(path.dirname(statePath), { recursive: true });

  try {
    const existingLedger = readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger");
    assertValidLedger(existingLedger);
    if (existingLedger.bootstrap_pending) {
      return finishPendingBootstrap({ statePath, ledgerPath, ledger: existingLedger });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

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
    if (ledger.commit_pending) {
      return finishPendingCommit({ statePath, ledgerPath, ledger, rawState, opts });
    }
    await cleanOrphanCommitStages(statePath);
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
  return withLock(projectDir, (lockContext) => bootstrapLocked(projectDir, opts), opts.lockOptions);
}

/** Create a new fenced project while the caller holds its project lock. */
export async function bootstrapFencedStateUnderLock(lockContext, initialState, opts = {}) {
  return bootstrapInitialUnderLock(lockContext, initialState, opts);
}

/** Read and recover a v5 state while the caller holds its project lock. */
export async function readFencedStateUnderLock(lockContext, opts = {}) {
  assertActiveLockContext(lockContext, opts.projectDir);
  const { projectDir, statePath } = getActiveLockContext(lockContext);
  const ledgerPath = ledgerFile(projectDir);
  const [hasState, hasLedger] = await Promise.all([fileExists(statePath), fileExists(ledgerPath)]);

  if (!hasState && !hasLedger) return null;

  if (!hasLedger) {
    const rawState = await fs.readFile(statePath, "utf8");
    const state = readJson(rawState, "state");
    if (state.version === FENCED_STATE_VERSION || Number.isInteger(state.fence_generation)) {
      const missing = new Error("ledger: revision ledger is missing for fenced state; refusing reconstruction");
      missing.code = "CLIMIER_LEDGER_MISSING";
      throw missing;
    }
    // Reuse the durable source/destination fingerprint protocol. Existing state
    // reaches the migration branch; absent state never reaches its legacy
    // bootstrap behavior because it returned null above.
    if (!SOURCE_VERSIONS.has(state.version)) {
      const error = new Error(`ledger: cannot migrate unsupported state version ${state.version}`);
      error.code = "CLIMIER_UNSUPPORTED_SOURCE_VERSION";
      throw error;
    }
    return bootstrapLocked(projectDir, opts);
  }

  let ledger;
  try {
    ledger = readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger");
  } catch (error) {
    if (error.code === "ENOENT") {
      const missing = new Error("ledger: revision ledger disappeared while holding project lock");
      missing.code = "CLIMIER_LEDGER_STATE_MISMATCH";
      throw missing;
    }
    throw error;
  }
  assertValidLedger(ledger);
  if (!hasState) {
    if (ledger.bootstrap_pending) {
      return finishPendingBootstrap({ statePath, ledgerPath, ledger });
    }
    const missing = new Error("ledger: revision ledger exists without state and no exact bootstrap is pending");
    missing.code = "CLIMIER_LEDGER_STATE_MISMATCH";
    throw missing;
  }
  if (ledger.bootstrap_pending) {
    return finishPendingBootstrap({ statePath, ledgerPath, ledger });
  }
  const rawState = await fs.readFile(statePath, "utf8");
  if (ledger.migration_pending) {
    return finishPendingMigration({ statePath, ledgerPath, ledger, rawState });
  }
  if (ledger.commit_pending) {
    return finishPendingCommit({ statePath, ledgerPath, ledger, rawState, opts });
  }
  await cleanOrphanCommitStages(statePath);
  const state = readJson(rawState, "fenced state");
  assertFencedState(state, ledger);
  return state;
}

/** Read a v5 state only when its durable project ledger agrees with it. */
export async function readFencedState(projectDir, opts = {}) {
  return withCurrentProjectLock(projectDir, (lockContext) => readFencedStateUnderLock(lockContext, opts), opts.lockOptions);
}

function validateCommitCandidate(candidate, current, ledger) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("ledger.commit: candidate must be a state object");
  }
  if (candidate.version !== FENCED_STATE_VERSION) {
    throw new Error(`ledger.commit: candidate schema version must be ${FENCED_STATE_VERSION}`);
  }
  if (candidate.fence_generation !== ledger.fence_generation
      || candidate.fence_generation !== current.fence_generation) {
    throw new Error("ledger.commit: candidate fence_generation must preserve the local generation");
  }
  if (!Number.isInteger(candidate.revision) || candidate.revision <= ledger.high_water_revision) {
    throw new Error("ledger.commit: candidate state revision must advance monotonically beyond ledger high-water revision");
  }
  validateStateInvariants(candidate, "ledger.commit.candidate");
  const candidateNodeMax = maxNodeRevision(candidate);
  if (candidateNodeMax > candidate.revision) {
    throw new Error("ledger.commit: node revision cannot exceed candidate state revision");
  }
  for (const [id, node] of Object.entries(candidate.nodes)) {
    const previous = current.nodes[id];
    if (!Number.isInteger(node.revision) || node.revision < 0) {
      throw new Error(`ledger.commit: node ${id} revision must be a non-negative integer`);
    }
    if (!previous && node.revision <= current.revision) {
      throw new Error(`ledger.commit: new node ${id} revision must exceed current state revision`);
    }
    if (previous && node.revision < previous.revision) {
      throw new Error(`ledger.commit: node ${id} revision must be monotonic`);
    }
    if (previous) {
      const { revision: _previousRevision, ...previousData } = previous;
      const { revision: _candidateRevision, ...candidateData } = node;
      if (!isDeepStrictEqual(previousData, candidateData)
          && node.revision <= Math.max(previous.revision, current.revision)) {
        throw new Error(`ledger.commit: modified node ${id} revision must exceed its prior and state revisions`);
      }
    }
  }
  if (candidate.revision < ledger.high_water_revision || candidate.revision < candidateNodeMax) {
    throw new Error("ledger.commit: candidate does not reserve all state and node revisions");
  }
  return candidateNodeMax;
}

/**
 * Atomically commit a v5 state while the caller holds this project's lock.
 * This API validates the opaque lock capability and never reacquires the lock.
 */
export async function commitFencedStateUnderLock(lockContext, candidate, opts = {}) {
  assertActiveLockContext(lockContext);
  const { projectDir, statePath } = getActiveLockContext(lockContext);
  const ledgerPath = ledgerFile(projectDir);
  await fs.mkdir(path.dirname(statePath), { recursive: true });

  let ledger;
  try {
    ledger = readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger");
  } catch (error) {
    if (error.code === "ENOENT") {
      const missing = new Error("ledger: revision ledger is missing for fenced commit; refusing reconstruction");
      missing.code = "CLIMIER_LEDGER_MISSING";
      throw missing;
    }
    throw error;
  }
  assertValidLedger(ledger);
  if (ledger.bootstrap_pending) {
    await finishPendingBootstrap({ statePath, ledgerPath, ledger });
    throw new Error("ledger.commit: bootstrap recovery completed; retry against the recovered state");
  }
  if (ledger.migration_pending) {
    const raw = await fs.readFile(statePath, "utf8");
    await finishPendingMigration({ statePath, ledgerPath, ledger, rawState: raw });
    throw new Error("ledger.commit: migration recovery completed; retry against the recovered state");
  }
  const rawState = await fs.readFile(statePath, "utf8");
  if (ledger.commit_pending) {
    await finishPendingCommit({ statePath, ledgerPath, ledger, rawState, opts });
    throw new Error("ledger.commit: pending commit recovery completed; retry against the recovered state");
  }
  const current = readJson(rawState, "fenced state");
  assertFencedState(current, ledger);
  const candidateNodeMax = validateCommitCandidate(candidate, current, ledger);
  const highWater = Math.max(ledger.high_water_revision, candidate.revision, candidateNodeMax);
  const destinationRaw = `${JSON.stringify(candidate, null, 2)}\n`;
  const stageId = crypto.randomBytes(16).toString("hex");
  const stagePath = commitStagePath(statePath, stageId);
  const pending = {
    source_sha256: sha256(rawState),
    destination_sha256: sha256(destinationRaw),
    stage_id: stageId,
    source_high_water_revision: ledger.high_water_revision,
    high_water_revision: highWater,
    fence_generation: ledger.fence_generation,
  };
  fault(opts, "before-stage");
  await writeDurableStage(stagePath, destinationRaw);
  fault(opts, "after-stage");
  fault(opts, "before-pending");
  ledger.commit_pending = pending;
  // Reserve before installing state so the durable fence never moves backward.
  ledger.high_water_revision = highWater;
  await persistLedger(ledgerPath, ledger);
  fault(opts, "after-pending");
  fault(opts, "before-state-rename");
  await durableReplace(statePath, destinationRaw);
  fault(opts, "after-state-rename");
  return finishPendingCommit({ statePath, ledgerPath, ledger, rawState: destinationRaw, opts });
}
