// Durable fenced-commit protocol and its pending-stage recovery.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { stateFile, FENCED_STATE_VERSION } from "../state.mjs";
import { getActiveLockContext, assertActiveLockContext } from "../lock.mjs";
import { validateStateInvariants } from "../../contracts/state-invariants.mjs";
import { assertValidLedger } from "./recovery.mjs";
import { finishPendingBootstrap } from "./bootstrap.mjs";
import { finishPendingMigration } from "./migration.mjs";
import { assertFencedState, commitStagePath, durableReplace, fault, fingerprintMismatch, maxNodeRevision, persistLedger, readJson, sha256, writeDurableStage } from "./stages.mjs";

function ledgerFile(projectDir) {
  return path.join(path.dirname(stateFile(projectDir)), "revision-ledger.json");
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
  delete ledger.last_recovery;
  // Reserve before installing state so the durable fence never moves backward.
  ledger.high_water_revision = highWater;
  await persistLedger(ledgerPath, ledger);
  fault(opts, "after-pending");
  fault(opts, "before-state-rename");
  await durableReplace(statePath, destinationRaw);
  fault(opts, "after-state-rename");
  return finishPendingCommit({ statePath, ledgerPath, ledger, rawState: destinationRaw, opts });
}

export { cleanOrphanCommitStages, finishPendingCommit };
