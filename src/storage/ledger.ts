import { asCaughtError } from "../contracts/errors.ts";
// Durable, project-local revision fence bootstrap. The API intentionally does
// not wire itself into mutation callers; callers must migrate to fenced commits

import fs from "node:fs/promises";
import path from "node:path";
import { stateFile, stateFileForProjectId } from "./state.ts";
import { withLock, withCurrentProjectLock, withProjectIdLock, assertActiveLockContext, getActiveLockContext } from "./lock.ts";
import { ClimierError } from "../contracts/errors.ts";
import type { ProjectState } from "../contracts/domain.ts";
import {
  assertValidLedger,
  recoverUnderActiveLock as recoverUnderActiveLockProtocol,
} from "./ledger/recovery.ts";
import { assertFencedState, readJson } from "./ledger/stages.ts";
import { bootstrapInitialUnderLock, bootstrapLocked, fileExists, finishPendingBootstrap } from "./ledger/bootstrap.ts";
import type { BootstrapLedger } from "./ledger/bootstrap.ts";
import { cleanOrphanCommitStages, commitFencedStateUnderLock as commitProtocol, finishPendingCommit } from "./ledger/commit.ts";
import { replaceUnderActiveLock } from "./ledger/replace.ts";

export type LockOptions = { timeoutMs?: number; retryEveryMs?: number };
export type LedgerOptions = LockOptions & {
  projectDir?: string;
  lockOptions?: LockOptions;
  [key: string]: unknown;
};

type LockContext = object;
type LedgerState = ProjectState & Record<string, unknown>;

export function ledgerFile(projectDir: string): string {
  return path.join(path.dirname(stateFile(projectDir)), "revision-ledger.json");
}

/** Ledger path for a project known only by its id (the storage dir name). */
export function ledgerFileForProjectId(projectId: string): string {
  return path.join(path.dirname(stateFileForProjectId(projectId)), "revision-ledger.json");
}

function runRecoveryProtocol(lockContext: LockContext, candidate: unknown, opts: LedgerOptions): unknown {
  return recoverUnderActiveLockProtocol(lockContext, candidate, opts, {
    finishPendingBootstrap,
    finishPendingCommit,
  });
}


export async function recoverFencedStateUnderLock(lockContext: LockContext, candidate: unknown, opts: LedgerOptions = {}): Promise<unknown> {
  assertActiveLockContext(lockContext, opts.projectDir);
  return runRecoveryProtocol(lockContext, candidate, opts);
}

/** Replace a valid fenced state with an explicitly authorized restore candidate under the active lock. */
export async function replaceFencedStateUnderLock(lockContext: LockContext, candidate: unknown, opts: LedgerOptions = {}): Promise<unknown> {
  assertActiveLockContext(lockContext, opts.projectDir);
  return replaceUnderActiveLock(lockContext, candidate, opts);
}

/**
 * Bootstrap a project's monotonic revision ledger and migrate its initial state
 * under the canonical project lock. The optional fault points are for storage
 * crash-recovery tests and are not used by production callers.
 */
export async function bootstrapFencedState(projectDir: string, opts: LedgerOptions = {}): Promise<unknown> {
  return withLock(projectDir, () => bootstrapLocked(projectDir, opts, { finishPendingCommit, cleanOrphanCommitStages }), opts.lockOptions);
}

/** Create a new fenced project while the caller holds its project lock. */
export async function bootstrapFencedStateUnderLock(lockContext: LockContext, initialState: unknown, opts: LedgerOptions = {}): Promise<unknown> {
  return bootstrapInitialUnderLock(lockContext, initialState, opts);
}

async function readValidatedLedger(ledgerPath: string): Promise<BootstrapLedger> {
  let ledger;
  try {
    ledger = readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger") as BootstrapLedger;
  } catch (rawCaughtValue: unknown) {
  {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") {
      throw new ClimierError("CLIMIER_LEDGER_STATE_MISMATCH", "ledger: revision ledger disappeared while holding project lock");
    }
    throw error;

  }}
  assertValidLedger(ledger);
  return ledger;
}

function finishBootstrapWithoutState(ledger, statePath, ledgerPath) {
  if (ledger.bootstrap_pending) {
    return finishPendingBootstrap({ statePath, ledgerPath, ledger });
  }
  throw new ClimierError("CLIMIER_LEDGER_STATE_MISMATCH", "ledger: revision ledger exists without state and no exact bootstrap is pending");
}

async function finishLedgerRead(lockContext: LockContext, ledger: BootstrapLedger, paths: { statePath: string; ledgerPath: string }, opts: LedgerOptions): Promise<unknown> {
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
    throw new ClimierError("CLIMIER_INCOMPATIBLE_VERSION", "ledger: state is not canonical version 1; run climier migrate");
  }
  await cleanOrphanCommitStages(statePath);
  const state = parsedState;
  assertFencedState(state, ledger);
  return state;
}


export async function readFencedStateUnderLock(lockContext: LockContext, opts: LedgerOptions = {}): Promise<unknown> {
  assertActiveLockContext(lockContext, opts.projectDir);
  const { statePath } = getActiveLockContext(lockContext);
  const ledgerPath = path.join(path.dirname(statePath), "revision-ledger.json");
  const [hasState, hasLedger] = await Promise.all([fileExists(statePath), fileExists(ledgerPath)]);
  if (!hasState && !hasLedger) {
    return null;
  }
  if (!hasLedger) {
    throw new ClimierError("CLIMIER_LEDGER_MISSING", `ledger: canonical state at ${statePath} has no revision ledger`);
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
export async function readFencedState(projectDir: string, opts: LedgerOptions = {}): Promise<unknown> {
  return withCurrentProjectLock(projectDir, (lockContext) => readFencedStateUnderLock(lockContext, opts), opts.lockOptions);
}

/**
 * Read a project's canonical state by id, without a project root. Used by
 * read-only surfaces that enumerate the local storage (the loopback UI
 * catalog). Returns null when the project has neither state nor ledger, and
 * never creates the project directory.
 */
export async function readStateByProjectId(projectId) {
  const statePath = stateFileForProjectId(projectId);
  const ledgerPath = ledgerFileForProjectId(projectId);
  const [hasState, hasLedger] = await Promise.all([fileExists(statePath), fileExists(ledgerPath)]);
  if (!hasState && !hasLedger) { return null; }
  return withProjectIdLock(projectId, (lockContext) => readFencedStateUnderLock(lockContext));
}

/** Commit a candidate under the active lock, preserving the public facade. */
export async function commitFencedStateUnderLock(lockContext, candidate, opts = {}) {
  return commitProtocol(lockContext, candidate, opts);
}
