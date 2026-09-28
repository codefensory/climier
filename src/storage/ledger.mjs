// Durable, project-local revision fence bootstrap. The API intentionally does
// not wire itself into mutation callers; callers must migrate to fenced commits
// before writing state v5.
import fs from "node:fs/promises";
import path from "node:path";
import { stateFile } from "./state.mjs";
import { withLock, withCurrentProjectLock, assertActiveLockContext, getActiveLockContext } from "./lock.mjs";
import {
  assertValidLedger,
  recoverUnderActiveLock as recoverUnderActiveLockProtocol,
} from "./ledger/recovery.mjs";
import { assertFencedState, readJson } from "./ledger/stages.mjs";
import { bootstrapInitialUnderLock, bootstrapLocked, fileExists, finishPendingBootstrap } from "./ledger/bootstrap.mjs";
import { cleanOrphanCommitStages, commitFencedStateUnderLock as commitProtocol, finishPendingCommit } from "./ledger/commit.mjs";
import { replaceUnderActiveLock } from "./ledger/replace.mjs";

export function ledgerFile(projectDir) {
  return path.join(path.dirname(stateFile(projectDir)), "revision-ledger.json");
}

function runRecoveryProtocol(lockContext, candidate, opts) {
  return recoverUnderActiveLockProtocol(lockContext, candidate, opts, {
    finishPendingBootstrap,
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

async function readValidatedLedger(ledgerPath) {
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
  return ledger;
}

function finishBootstrapWithoutState(ledger, statePath, ledgerPath) {
  if (ledger.bootstrap_pending) {
    return finishPendingBootstrap({ statePath, ledgerPath, ledger });
  }
  const missing = new Error("ledger: revision ledger exists without state and no exact bootstrap is pending");
  missing.code = "CLIMIER_LEDGER_STATE_MISMATCH";
  throw missing;
}

async function finishLedgerRead(lockContext, ledger, paths, opts) {
  const { statePath, ledgerPath } = paths;
  const rawState = await fs.readFile(statePath, "utf8");
  const parsedState = readJson(rawState, "fenced state");
  if (ledger.replace_pending) {
    return replaceUnderActiveLock(lockContext, undefined, opts);
  }
  if (ledger.recovery_pending || ledger.last_recovery) {
    return runRecoveryProtocol(lockContext, undefined, opts);
  }
  if (ledger.commit_pending) {
    return finishPendingCommit({ statePath, ledgerPath, ledger, rawState, opts });
  }
  if (!ledger.commit_pending && !ledger.bootstrap_pending && !ledger.recovery_pending && !ledger.replace_pending && parsedState.version !== 1) {
    const incompatible = new Error("ledger: state is not canonical version 1; run climier migrate");
    incompatible.code = "CLIMIER_INCOMPATIBLE_VERSION";
    throw incompatible;
  }
  await cleanOrphanCommitStages(statePath);
  const state = parsedState;
  assertFencedState(state, ledger);
  return state;
}

/** Read and recover a v5 state while the caller holds its project lock. */
export async function readFencedStateUnderLock(lockContext, opts = {}) {
  assertActiveLockContext(lockContext, opts.projectDir);
  const { projectDir, statePath } = getActiveLockContext(lockContext);
  const ledgerPath = ledgerFile(projectDir);
  const [hasState, hasLedger] = await Promise.all([fileExists(statePath), fileExists(ledgerPath)]);
  if (!hasState && !hasLedger) {
    return null;
  }
  if (!hasLedger) {
    const error = new Error(`ledger: canonical state at ${statePath} has no revision ledger`);
    error.code = "CLIMIER_LEDGER_MISSING";
    throw error;
  }
  const ledger = await readValidatedLedger(ledgerPath);
  if (!hasState) {
    return finishBootstrapWithoutState(ledger, statePath, ledgerPath);
  }
  if (ledger.bootstrap_pending) {
    return finishPendingBootstrap({ statePath, ledgerPath, ledger });
  }
  return finishLedgerRead(lockContext, ledger, { statePath, ledgerPath }, opts);
}

/** Read a v5 state only when its durable project ledger agrees with it. */
export async function readFencedState(projectDir, opts = {}) {
  return withCurrentProjectLock(projectDir, (lockContext) => readFencedStateUnderLock(lockContext, opts), opts.lockOptions);
}

/** Commit a candidate under the active lock, preserving the public facade. */
export async function commitFencedStateUnderLock(lockContext, candidate, opts = {}) {
  return commitProtocol(lockContext, candidate, opts);
}
