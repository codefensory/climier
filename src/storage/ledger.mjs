// Durable, project-local revision fence bootstrap. The API intentionally does
// not wire itself into mutation callers; callers must migrate to fenced commits
// before writing state v5.
import fs from "node:fs/promises";
import path from "node:path";
import { stateFile, FENCED_STATE_VERSION } from "./state.mjs";
import { withLock, withCurrentProjectLock, assertActiveLockContext, getActiveLockContext } from "./lock.mjs";
import {
  assertValidLedger,
  recoverUnderActiveLock as recoverUnderActiveLockProtocol,
  SOURCE_VERSIONS,
} from "./ledger/recovery.mjs";
import { assertFencedState, readJson } from "./ledger/stages.mjs";
import { bootstrapInitialUnderLock, bootstrapLocked, fileExists, finishPendingBootstrap } from "./ledger/bootstrap.mjs";
import { cleanOrphanCommitStages, commitFencedStateUnderLock as commitProtocol, finishPendingCommit } from "./ledger/commit.mjs";
import { finishPendingMigration } from "./ledger/migration.mjs";
import { replaceUnderActiveLock } from "./ledger/replace.mjs";

export function ledgerFile(projectDir) {
  return path.join(path.dirname(stateFile(projectDir)), "revision-ledger.json");
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
  return withLock(projectDir, () => bootstrapLocked(projectDir, opts, { finishPendingCommit, cleanOrphanCommitStages }), opts.lockOptions);
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
