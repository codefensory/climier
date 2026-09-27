// Durable, project-local revision fence bootstrap. The API intentionally does
// not wire itself into mutation callers; callers must migrate to fenced commits
// before writing state v5.
import fs from "node:fs/promises";
import path from "node:path";
import { stateFile, migrateState, FENCED_STATE_VERSION } from "./state.mjs";
import { withLock, withCurrentProjectLock, assertActiveLockContext, getActiveLockContext } from "./lock.mjs";
import { validateStateInvariants } from "../contracts/state-invariants.mjs";
import {
  assertValidLedger,
  recoverUnderActiveLock as recoverUnderActiveLockProtocol,
  RECOVERY_VERSIONS,
  SOURCE_VERSIONS,
} from "./ledger/recovery.mjs";
import {
  assertFencedState,
  durableReplace,
  fault,
  fingerprintMismatch,
  maxNodeRevision,
  readJson,
  sha256,
  syncDirectory,
} from "./ledger/stages.mjs";

import { bootstrapInitialUnderLock, bootstrapLocked, fileExists, finishPendingBootstrap } from "./ledger/bootstrap.mjs";
import { cleanOrphanCommitStages, commitFencedStateUnderLock as commitProtocol, finishPendingCommit } from "./ledger/commit.mjs";
import { finishPendingMigration } from "./ledger/migration.mjs";

export function ledgerFile(projectDir) {
  return path.join(path.dirname(stateFile(projectDir)), "revision-ledger.json");
}

function replaceDestination(candidate, ledger) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || !RECOVERY_VERSIONS.has(candidate.version)) {
    const error = new Error(`ledger.replace: unsupported replacement state version ${candidate?.version}`);
    error.code = "CLIMIER_UNSUPPORTED_SOURCE_VERSION";
    throw error;
  }
  if (candidate.version === FENCED_STATE_VERSION && !Number.isInteger(candidate.fence_generation)) {
    const error = new Error("ledger.replace: v5 replacement candidate must include fence_generation");
    error.code = "CLIMIER_LEDGER_STATE_MISMATCH";
    throw error;
  }
  const migrated = migrateState(candidate);
  const compatible = {
    ...migrated,
    nodes: Object.fromEntries(Object.entries(migrated.nodes || {}).map(([id, node]) => [id, { ...node }])),
  };
  if (compatible.version === FENCED_STATE_VERSION) compatible.version = 4;
  delete compatible.fence_generation;
  validateStateInvariants(compatible, "ledger.replace.candidate");
  const highWater = Math.max(
    ledger.high_water_revision,
    Number.isInteger(compatible.revision) && compatible.revision >= 0 ? compatible.revision : 0,
    maxNodeRevision(compatible),
  ) + 1;
  const destination = {
    ...compatible,
    version: FENCED_STATE_VERSION,
    revision: highWater,
    fence_generation: ledger.fence_generation,
    nodes: Object.fromEntries(Object.entries(compatible.nodes).map(([id, node]) => [id, { ...node, revision: highWater }])),
  };
  validateStateInvariants(destination, "ledger.replace.destination");
  return { destination, destinationRaw: `${JSON.stringify(destination, null, 2)}\n`, highWater };
}

function replaceStagePath(statePath, stageId) {
  return path.join(path.dirname(statePath), `.replace-stage-${stageId}`);
}

async function finishPendingReplace({ statePath, ledgerPath, ledger, rawState, opts = {} }) {
  const pending = ledger.replace_pending;
  const stagePath = replaceStagePath(statePath, pending.stage_id);
  let stageRaw;
  try {
    stageRaw = await fs.readFile(stagePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw fingerprintMismatch("replace stage is missing; explicit recovery is required");
    throw error;
  }
  if (sha256(stageRaw) !== pending.destination_sha256) {
    throw fingerprintMismatch("replace stage does not match the pending destination fingerprint");
  }
  const staged = readJson(stageRaw, "replace stage");
  if (staged.version !== FENCED_STATE_VERSION
      || staged.fence_generation !== pending.fence_generation
      || staged.revision !== pending.high_water_revision) {
    throw fingerprintMismatch("replace stage does not match pending generation or high-water revision");
  }
  validateStateInvariants(staged, "ledger.replace.stage");
  const currentHash = sha256(rawState);
  if (currentHash === pending.source_sha256) {
    const source = readJson(rawState, "replace source state");
    if (source.version !== FENCED_STATE_VERSION
        || source.fence_generation !== pending.fence_generation
        || source.revision !== pending.source_high_water_revision) {
      throw fingerprintMismatch("replace source does not match pending generation or source high-water revision");
    }
    validateStateInvariants(source, "ledger.replace.source");
    fault(opts, "before-state-rename");
    await durableReplace(statePath, stageRaw);
    rawState = stageRaw;
    fault(opts, "after-state-rename");
  } else if (currentHash !== pending.destination_sha256) {
    throw fingerprintMismatch("state fingerprint diverged from pending replace source and destination");
  }
  const destination = readJson(rawState, "replaced state");
  if (sha256(rawState) !== pending.destination_sha256
      || destination.fence_generation !== pending.fence_generation
      || destination.revision !== pending.high_water_revision) {
    throw fingerprintMismatch("installed state does not match pending replace destination");
  }
  assertFencedState(destination, ledger);
  ledger.replace_pending = null;
  ledger.last_replace = {
    source_sha256: pending.source_sha256,
    destination_sha256: pending.destination_sha256,
    input_sha256: pending.input_sha256,
    input_version: pending.input_version,
    source_high_water_revision: pending.source_high_water_revision,
    high_water_revision: pending.high_water_revision,
    fence_generation: pending.fence_generation,
  };
  fault(opts, "before-ledger-clear");
  await persistLedger(ledgerPath, ledger);
  fault(opts, "after-ledger-clear");
  await fs.unlink(stagePath);
  await syncDirectory(path.dirname(stagePath));
  return destination;
}

async function resumePendingReplaceUnderActiveLock(lockContext, opts = {}) {
  assertActiveLockContext(lockContext, opts.projectDir);
  const { projectDir, statePath } = getActiveLockContext(lockContext);
  const ledgerPath = ledgerFile(projectDir);
  let ledger;
  try {
    ledger = readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger");
  } catch (error) {
    if (error.code === "ENOENT") {
      const missing = new Error("ledger: revision ledger is missing while replacing fenced state");
      missing.code = "CLIMIER_LEDGER_MISSING";
      throw missing;
    }
    throw error;
  }
  assertValidLedger(ledger);
  if (!ledger.replace_pending) return null;
  const rawState = await fs.readFile(statePath, "utf8");
  return finishPendingReplace({ statePath, ledgerPath, ledger, rawState, opts });
}

async function replaceUnderActiveLock(lockContext, candidate, opts = {}) {
  assertActiveLockContext(lockContext, opts.projectDir);
  const { projectDir, statePath } = getActiveLockContext(lockContext);
  const ledgerPath = ledgerFile(projectDir);
  if (candidate === undefined) {
    const resumed = await resumePendingReplaceUnderActiveLock(lockContext, opts);
    if (resumed) return resumed;
    throw fingerprintMismatch("no pending replace is available to resume");
  }
  const inputRaw = `${JSON.stringify(candidate, null, 2)}\n`;
  const inputHash = sha256(inputRaw);
  let ledger;
  try {
    ledger = readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger");
  } catch (error) {
    if (error.code === "ENOENT") {
      const missing = new Error("ledger.replace: revision ledger is required; refusing reconstruction");
      missing.code = "CLIMIER_LEDGER_MISSING";
      throw missing;
    }
    throw error;
  }
  assertValidLedger(ledger);
  let rawState;
  try {
    rawState = await fs.readFile(statePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      const missing = new Error("ledger.replace: fenced state is required");
      missing.code = "CLIMIER_LEDGER_STATE_MISMATCH";
      throw missing;
    }
    throw error;
  }
  if (ledger.replace_pending) {
    if (ledger.replace_pending.input_sha256 !== inputHash) {
      throw fingerprintMismatch("retry candidate does not match the pending replace input fingerprint");
    }
    return finishPendingReplace({ statePath, ledgerPath, ledger, rawState, opts });
  }
  if (ledger.migration_pending || ledger.commit_pending || ledger.bootstrap_pending || ledger.recovery_pending) {
    throw fingerprintMismatch("cannot replace state while another fenced operation is pending");
  }
  const source = readJson(rawState, "fenced state");
  assertFencedState(source, ledger);
  const sourceHash = sha256(rawState);
  if (ledger.last_replace?.destination_sha256 === sourceHash
      && ledger.last_replace.input_sha256 === inputHash) return source;

  const prepared = replaceDestination(candidate, ledger);
  const destinationHash = sha256(prepared.destinationRaw);
  await cleanOrphanReplaceStages(statePath);
  const stageId = crypto.randomBytes(16).toString("hex");
  const stagePath = replaceStagePath(statePath, stageId);
  const pending = {
    source_sha256: sourceHash,
    destination_sha256: destinationHash,
    input_sha256: inputHash,
    stage_id: stageId,
    input_version: candidate.version,
    source_high_water_revision: ledger.high_water_revision,
    high_water_revision: prepared.highWater,
    fence_generation: ledger.fence_generation,
  };
  fault(opts, "before-stage");
  await writeDurableStage(stagePath, prepared.destinationRaw);
  fault(opts, "after-stage");
  fault(opts, "before-pending");
  ledger.replace_pending = pending;
  delete ledger.last_recovery;
  ledger.high_water_revision = prepared.highWater;
  await persistLedger(ledgerPath, ledger);
  fault(opts, "after-pending");
  return finishPendingReplace({ statePath, ledgerPath, ledger, rawState, opts });
}

async function cleanOrphanReplaceStages(statePath) {
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
    if (entry.isFile() && /^\\.replace-stage-[a-f0-9]{32}$/.test(entry.name)) {
      await fs.unlink(path.join(directory, entry.name));
      changed = true;
    }
  }
  if (changed) await syncDirectory(directory);
}

function runRecoveryProtocol(lockContext, candidate, opts) {
  return recoverUnderActiveLockProtocol(lockContext, candidate, opts, {
    finishPendingBootstrap,
    finishPendingMigration,
    finishPendingCommit,
  });
}

/** Rebase an explicit legacy recovery payload under an already-active project lock. */
export async function recoverFencedStateUnderLock(lockContext, candidate, opts = {}) {
  assertActiveLockContext(lockContext, opts.projectDir);
  return runRecoveryProtocol(lockContext, candidate, opts);
}

/** Replace a valid fenced state with an explicitly authorized restore candidate under the active lock. */
export async function replaceFencedStateUnderLock(lockContext, candidate, opts = {}) {
  assertActiveLockContext(lockContext, opts.projectDir);
  return replaceUnderActiveLock(lockContext, candidate, opts);
}

/**
 * Bootstrap a project's monotonic revision ledger and migrate its initial state
 * under the canonical project lock. The optional fault points are for storage
 * crash-recovery tests and are not used by production callers.
 */
export async function bootstrapFencedState(projectDir, opts = {}) {
  return withLock(projectDir, (lockContext) => bootstrapLocked(projectDir, opts, { finishPendingCommit, cleanOrphanCommitStages }), opts.lockOptions);
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
    return bootstrapLocked(projectDir, opts, { finishPendingCommit, cleanOrphanCommitStages });
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
  if (ledger.replace_pending) {
    return replaceUnderActiveLock(lockContext, undefined, opts);
  }
  if (ledger.recovery_pending || ledger.last_recovery) {
    return runRecoveryProtocol(lockContext, undefined, opts);
  }
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


/** Commit a candidate under the active lock, preserving the public facade. */
export async function commitFencedStateUnderLock(lockContext, candidate, opts = {}) {
  return commitProtocol(lockContext, candidate, opts);
}
