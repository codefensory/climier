// Durable recovery protocol for fenced project state.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FENCED_STATE_VERSION, migrateState } from "../state.mjs";
import { getActiveLockContext } from "../lock.mjs";
import { validateStateInvariants } from "../../contracts/state-invariants.mjs";
import {
  assertFencedState,
  cleanOrphanRecoveryStages,
  durableReplace,
  fault,
  fingerprintMismatch,
  maxNodeRevision,
  persistLedger,
  readJson,
  recoveryStagePath,
  sha256,
  syncDirectory,
  writeDurableStage,
} from "./stages.mjs";

export const LEDGER_VERSION = 1;
export const SOURCE_VERSIONS = new Set([2, 3, 4]);
export const RECOVERY_VERSIONS = new Set([2, 3, 4, FENCED_STATE_VERSION]);

function validRecoveryInputFingerprint(pending) {
  if (pending.input_sha256 === null) {
    return pending.candidate_supplied !== true;
  }
  return typeof pending.input_sha256 === "string" && /^[a-f0-9]{64}$/.test(pending.input_sha256);
}

export function assertValidLedger(ledger) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)
      || ledger.version !== LEDGER_VERSION
      || !Number.isInteger(ledger.fence_generation) || ledger.fence_generation < 1
      || !Number.isInteger(ledger.high_water_revision) || ledger.high_water_revision < 1
      || !(ledger.migration_pending === null || (ledger.migration_pending && typeof ledger.migration_pending === "object"))
      || !(ledger.commit_pending === undefined || ledger.commit_pending === null
        || (ledger.commit_pending && typeof ledger.commit_pending === "object"))
      || !(ledger.bootstrap_pending === undefined || ledger.bootstrap_pending === null
        || (ledger.bootstrap_pending && typeof ledger.bootstrap_pending === "object"))
      || !(ledger.recovery_pending === undefined || ledger.recovery_pending === null
        || (ledger.recovery_pending && typeof ledger.recovery_pending === "object"))
      || !(ledger.replace_pending === undefined || ledger.replace_pending === null
        || (ledger.replace_pending && typeof ledger.replace_pending === "object"))
      || !(ledger.last_recovery === undefined || ledger.last_recovery === null
        || (ledger.last_recovery && typeof ledger.last_recovery === "object"))
      || !(ledger.last_replace === undefined || ledger.last_replace === null
        || (ledger.last_replace && typeof ledger.last_replace === "object"))) {
    const error = new Error("ledger: invalid ledger schema");
    error.code = "CLIMIER_INVALID_LEDGER";
    throw error;
  }
  if ((ledger.migration_pending !== null && ledger.commit_pending != null)
      || (ledger.bootstrap_pending != null && (ledger.migration_pending !== null || ledger.commit_pending != null || ledger.recovery_pending != null || ledger.replace_pending != null))
      || (ledger.recovery_pending != null && (ledger.migration_pending !== null || ledger.commit_pending != null || ledger.bootstrap_pending != null || ledger.replace_pending != null))
      || (ledger.replace_pending != null && (ledger.migration_pending !== null || ledger.commit_pending != null || ledger.bootstrap_pending != null || ledger.recovery_pending != null))) {
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
  if (ledger.recovery_pending != null) {
    const pending = ledger.recovery_pending;
    if (typeof pending.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pending.source_sha256)
        || typeof pending.destination_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pending.destination_sha256)
        || !validRecoveryInputFingerprint(pending)
        || !(pending.candidate_supplied === undefined || typeof pending.candidate_supplied === "boolean")
        || typeof pending.stage_id !== "string" || !/^[a-f0-9]{32}$/.test(pending.stage_id)
        || !Number.isInteger(pending.source_high_water_revision) || pending.source_high_water_revision < 1
        || !Number.isInteger(pending.high_water_revision) || pending.high_water_revision !== ledger.high_water_revision
        || pending.high_water_revision <= pending.source_high_water_revision
        || !Number.isInteger(pending.fence_generation) || pending.fence_generation !== ledger.fence_generation
        || !SOURCE_VERSIONS.has(pending.source_version)
        || !(pending.corrupt_source === undefined || pending.corrupt_source === true)) {
      const error = new Error("ledger: invalid recovery_pending record");
      error.code = "CLIMIER_INVALID_LEDGER";
      throw error;
    }
  }
  if (ledger.replace_pending != null) {
    const pending = ledger.replace_pending;
    if (typeof pending.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pending.source_sha256)
        || typeof pending.destination_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pending.destination_sha256)
        || typeof pending.input_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pending.input_sha256)
        || typeof pending.stage_id !== "string" || !/^[a-f0-9]{32}$/.test(pending.stage_id)
        || !Number.isInteger(pending.source_high_water_revision) || pending.source_high_water_revision < 1
        || !Number.isInteger(pending.high_water_revision) || pending.high_water_revision !== ledger.high_water_revision
        || pending.high_water_revision <= pending.source_high_water_revision
        || !Number.isInteger(pending.fence_generation) || pending.fence_generation !== ledger.fence_generation
        || !RECOVERY_VERSIONS.has(pending.input_version)) {
      const error = new Error("ledger: invalid replace_pending record");
      error.code = "CLIMIER_INVALID_LEDGER";
      throw error;
    }
  }
}

function recoveryDestination(candidate, ledger) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || !RECOVERY_VERSIONS.has(candidate.version)) {
    const error = new Error(`ledger.recover: unsupported recovery state version ${candidate?.version}`);
    error.code = "CLIMIER_UNSUPPORTED_SOURCE_VERSION";
    throw error;
  }
  const migrated = migrateState(candidate);
  const compatible = {
    ...migrated,
    nodes: Object.fromEntries(Object.entries(migrated.nodes || {}).map(([id, node]) => [id, { ...node }])),
  };
  if (compatible.version === FENCED_STATE_VERSION) compatible.version = 4;
  delete compatible.fence_generation;
  validateStateInvariants(compatible, "ledger.recover.candidate");
  const highWater = Math.max(
    ledger.high_water_revision,
    Number.isInteger(compatible.revision) && compatible.revision >= 0 ? compatible.revision : 0,
    maxNodeRevision(compatible),
  );
  const fence = highWater + 1;
  const destination = {
    ...compatible,
    version: FENCED_STATE_VERSION,
    revision: fence,
    fence_generation: ledger.fence_generation,
    nodes: Object.fromEntries(Object.entries(compatible.nodes).map(([id, node]) => [id, { ...node, revision: fence }])),
  };
  validateStateInvariants(destination, "ledger.recover.destination");
  return { destination, destinationRaw: `${JSON.stringify(destination, null, 2)}\n`, highWater: fence, fence };
}

async function finishPendingRecovery({ statePath, ledgerPath, ledger, rawState, opts = {} }) {
  const pending = ledger.recovery_pending;
  const stagePath = recoveryStagePath(statePath, pending.stage_id);
  let stageRaw;
  try {
    stageRaw = await fs.readFile(stagePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw fingerprintMismatch("recovery stage is missing; explicit recovery is required");
    throw error;
  }
  if (sha256(stageRaw) !== pending.destination_sha256) {
    throw fingerprintMismatch("recovery stage does not match the pending destination fingerprint");
  }
  const staged = readJson(stageRaw, "recovery stage");
  if (staged.version !== FENCED_STATE_VERSION
      || staged.fence_generation !== pending.fence_generation
      || staged.revision !== pending.high_water_revision) {
    throw fingerprintMismatch("recovery stage does not match the pending generation or high-water revision");
  }
  validateStateInvariants(staged, "ledger.recover.stage");

  const currentHash = sha256(rawState);
  if (currentHash === pending.source_sha256) {
    if (pending.corrupt_source) {
      try {
        JSON.parse(rawState);
        throw fingerprintMismatch("recovery source is no longer corrupt");
      } catch (error) {
        if (error.code === "CLIMIER_LEDGER_FINGERPRINT_MISMATCH") throw error;
      }
    } else {
      const source = readJson(rawState, "recovery source state");
      if (!SOURCE_VERSIONS.has(source.version) || Number.isInteger(source.fence_generation)) {
        throw fingerprintMismatch("recovery source no longer matches the stale legacy state");
      }
    }
    fault(opts, "before-state-rename");
    await durableReplace(statePath, stageRaw);
    rawState = stageRaw;
    fault(opts, "after-state-rename");
  } else if (currentHash !== pending.destination_sha256) {
    throw fingerprintMismatch("state fingerprint diverged from pending recovery source and destination");
  }

  const destination = readJson(rawState, "recovered state");
  assertFencedState(destination, ledger);
  ledger.recovery_pending = null;
  ledger.last_recovery = {
    source_sha256: pending.source_sha256,
    destination_sha256: pending.destination_sha256,
    input_sha256: pending.input_sha256,
    ...(pending.candidate_supplied === undefined ? {} : { candidate_supplied: pending.candidate_supplied }),
    source_version: pending.source_version,
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

export async function recoverUnderActiveLock(lockContext, candidate, opts = {}, finalizers = {}) {
  const { finishPendingBootstrap, finishPendingMigration, finishPendingCommit } = finalizers;
  const candidateSupplied = candidate !== undefined;
  const { statePath } = getActiveLockContext(lockContext);
  const ledgerPath = path.join(path.dirname(statePath), "revision-ledger.json");
  let rawState;
  try {
    rawState = await fs.readFile(statePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      const missing = new Error("ledger.recover: state file is required for explicit recovery");
      missing.code = "CLIMIER_LEDGER_STATE_MISMATCH";
      throw missing;
    }
    throw error;
  }
  let ledger;
  try {
    ledger = readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger");
  } catch (error) {
    if (error.code === "ENOENT") {
      const missing = new Error("ledger.recover: revision ledger is required; refusing reconstruction");
      missing.code = "CLIMIER_LEDGER_MISSING";
      throw missing;
    }
    throw error;
  }
  assertValidLedger(ledger);
  if (ledger.bootstrap_pending) {
    return finishPendingBootstrap({ statePath, ledgerPath, ledger });
  }
  if (ledger.migration_pending) return finishPendingMigration({ statePath, ledgerPath, ledger, rawState });
  if (ledger.commit_pending) return finishPendingCommit({ statePath, ledgerPath, ledger, rawState, opts });
  if (ledger.recovery_pending) {
    const pending = ledger.recovery_pending;
    if (candidate !== undefined && pending.input_sha256 === null
        && pending.candidate_supplied === true) {
      throw fingerprintMismatch("retry candidate does not match the pending recovery input fingerprint");
    }
    if (pending.input_sha256 !== null && candidate !== undefined
        && pending.input_sha256 !== sha256(`${JSON.stringify(candidate, null, 2)}\n`)) {
      throw fingerprintMismatch("retry candidate does not match the pending recovery input fingerprint");
    }
    if (!candidate && sha256(rawState) === pending.destination_sha256) {
      candidate = readJson(rawState, "recovered state");
    }
    const pendingStagePath = recoveryStagePath(statePath, pending.stage_id);
    let pendingStageRaw;
    try {
      pendingStageRaw = await fs.readFile(pendingStagePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") throw fingerprintMismatch("recovery stage is missing; explicit recovery is required");
      throw error;
    }
    if (sha256(pendingStageRaw) !== pending.destination_sha256) {
      throw fingerprintMismatch("recovery stage does not match the pending destination fingerprint");
    }
    const pendingDestination = readJson(pendingStageRaw, "recovery stage");
    if (pendingDestination.version !== FENCED_STATE_VERSION
        || pendingDestination.fence_generation !== pending.fence_generation
        || pendingDestination.revision !== pending.high_water_revision) {
      throw fingerprintMismatch("recovery stage does not match the pending generation or high-water revision");
    }
    validateStateInvariants(pendingDestination, "ledger.recover.stage");
    return finishPendingRecovery({ statePath, ledgerPath, ledger, rawState, opts });
  }

  const inputRaw = `${JSON.stringify(candidate, null, 2)}\n`;
  const inputHash = candidate === undefined ? null : sha256(inputRaw);
  const sourceHash = sha256(rawState);
  if (ledger.last_recovery?.destination_sha256 === sourceHash
      && (candidate === undefined || ledger.last_recovery.input_sha256 === inputHash)) {
    const recovered = readJson(rawState, "recovered state");
    assertFencedState(recovered, ledger);
    return recovered;
  }
  let source = null;
  let corruptSource = false;
  try {
    source = readJson(rawState, "state");
  } catch (error) {
    if (error.code !== "CLIMIER_CORRUPT_LEDGER") throw error;
    corruptSource = true;
  }
  if (corruptSource) {
    if (candidate !== undefined) throw fingerprintMismatch("corrupt-source recovery does not accept a replacement candidate");
    candidate = { version: 4, nodes: {}, edges: [], initiatives: {}, log: [], revision: 0 };
  } else if (!SOURCE_VERSIONS.has(source.version) || Number.isInteger(source.fence_generation)) {
    throw fingerprintMismatch("explicit recovery accepts only an unfenced legacy source state");
  }
  candidate ??= source;
  const prepared = recoveryDestination(candidate, ledger);
  const destinationHash = sha256(prepared.destinationRaw);
  await cleanOrphanRecoveryStages(statePath);
  const stageId = crypto.randomBytes(16).toString("hex");
  const stagePath = recoveryStagePath(statePath, stageId);
  const pending = {
    source_sha256: sourceHash,
    destination_sha256: destinationHash,
    input_sha256: inputHash,
    ...(candidateSupplied ? { candidate_supplied: true } : {}),
    stage_id: stageId,
    source_version: corruptSource ? 4 : source.version,
    source_high_water_revision: ledger.high_water_revision,
    high_water_revision: prepared.highWater,
    fence_generation: ledger.fence_generation,
    ...(corruptSource ? { corrupt_source: true } : {}),
  };
  fault(opts, "before-stage");
  await writeDurableStage(stagePath, prepared.destinationRaw);
  fault(opts, "after-stage");
  fault(opts, "before-pending");
  ledger.recovery_pending = pending;
  ledger.high_water_revision = prepared.highWater;
  await persistLedger(ledgerPath, ledger);
  fault(opts, "after-pending");
  return finishPendingRecovery({ statePath, ledgerPath, ledger, rawState, opts });
}

