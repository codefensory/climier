import { asCaughtError } from "../../contracts/errors.ts";
// Durable recovery protocol for fenced project state.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ClimierError } from "../../contracts/errors.ts";
import { STATE_SCHEMA_VERSION } from "../state.ts";
import { getActiveLockContext } from "../lock.ts";
import { validateStateInvariants } from "../../contracts/state-invariants.ts";
import {
  assertFencedState, cleanOrphanRecoveryStages, durableReplace, fault, fingerprintMismatch, maxNodeRevision,
  persistLedger, readJson, recoveryStagePath, sha256, syncDirectory, writeDurableStage,
} from "./stages.ts";

export const LEDGER_VERSION = 1;
export const SOURCE_VERSIONS = new Set([2, 3, 4]);
export const RECOVERY_VERSIONS = new Set([STATE_SCHEMA_VERSION, ...SOURCE_VERSIONS]);

type JsonRecord = Record<string, unknown>;
type RecoveryCandidate = JsonRecord & {
  version: number;
  revision?: number;
  fence_generation?: number;
  nodes?: Record<string, JsonRecord>;
};

const isPresent = (value: unknown): boolean => value !== null && value !== undefined;
const isObject = (value: unknown): value is JsonRecord => value !== null && typeof value === "object";
const isOptionalObject = (value) => value === undefined || value === null || isObject(value);
const isSha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isStageId = (value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const all = (checks) => checks.every(Boolean);

function invalidLedger(message = "ledger: invalid ledger schema"): never {
  throw new ClimierError("CLIMIER_INVALID_LEDGER", message);
}

function validLedgerCore(ledger) {
  return isObject(ledger) && !Array.isArray(ledger) && ledger.version === LEDGER_VERSION
    && Number.isInteger(ledger.fence_generation) && typeof ledger.fence_generation === "number" && ledger.fence_generation >= 1
    && Number.isInteger(ledger.high_water_revision) && typeof ledger.high_water_revision === "number" && ledger.high_water_revision >= 1;
}

function validLedgerOptionalFields(ledger) {
  return all([isOptionalObject(ledger.migration_pending), isOptionalObject(ledger.last_migration), isOptionalObject(ledger.commit_pending), isOptionalObject(ledger.bootstrap_pending),
      isOptionalObject(ledger.recovery_pending), isOptionalObject(ledger.replace_pending),
      isOptionalObject(ledger.last_recovery), isOptionalObject(ledger.last_replace)]);
}

function validLedgerHeader(ledger) {
  return validLedgerCore(ledger) && validLedgerOptionalFields(ledger);
}

function validPendingCombination(ledger) {
  const { commit_pending: commit, bootstrap_pending: bootstrap,
    recovery_pending: recovery, replace_pending: replace } = ledger;
  return [[bootstrap, commit, recovery, replace], [recovery, commit, bootstrap, replace],
    [replace, commit, bootstrap, recovery]].every((group) => group.filter(isPresent).length < 2);
}

function validBootstrapPending(pending, ledger) {
  return all([isSha256(pending.destination_sha256), isStageId(pending.stage_id), Number.isInteger(pending.fence_generation),
    pending.fence_generation === ledger.fence_generation, Number.isInteger(pending.high_water_revision),
    pending.high_water_revision === ledger.high_water_revision]);
}

function validCommitPending(pending, ledger) {
  return all([isSha256(pending.source_sha256), isSha256(pending.destination_sha256), isStageId(pending.stage_id),
    Number.isInteger(pending.source_high_water_revision) && pending.source_high_water_revision >= 1,
    Number.isInteger(pending.high_water_revision) && pending.high_water_revision === ledger.high_water_revision,
    pending.high_water_revision >= pending.source_high_water_revision, Number.isInteger(pending.fence_generation),
    pending.fence_generation === ledger.fence_generation]);
}

function validRecoveryPending(pending, ledger) {
  const validInput = pending.input_sha256 === null ? pending.candidate_supplied !== true : isSha256(pending.input_sha256);
    const validSource = pending.source_version === STATE_SCHEMA_VERSION
      && (pending.corrupt_source === undefined || pending.corrupt_source === true);
  const validRevision = pending.high_water_revision === ledger.high_water_revision
    && pending.high_water_revision > pending.source_high_water_revision;
  return all([isSha256(pending.source_sha256), isSha256(pending.destination_sha256), validInput,
    pending.candidate_supplied === undefined || typeof pending.candidate_supplied === "boolean", isStageId(pending.stage_id),
    Number.isInteger(pending.source_high_water_revision) && pending.source_high_water_revision >= 1,
    Number.isInteger(pending.high_water_revision), validRevision, Number.isInteger(pending.fence_generation),
    pending.fence_generation === ledger.fence_generation, validSource]);
}

function validReplacePending(pending, ledger) {
  const validRevision = pending.high_water_revision === ledger.high_water_revision
    && pending.high_water_revision > pending.source_high_water_revision;
  return all([isSha256(pending.source_sha256), isSha256(pending.destination_sha256), isSha256(pending.input_sha256),
    isStageId(pending.stage_id), Number.isInteger(pending.source_high_water_revision) && pending.source_high_water_revision >= 1,
    Number.isInteger(pending.high_water_revision), validRevision, Number.isInteger(pending.fence_generation),
    pending.fence_generation === ledger.fence_generation, RECOVERY_VERSIONS.has(pending.input_version)]);
}

function assertPendingRecord(pending, valid, message) {
  if (isPresent(pending) && !valid(pending)) { invalidLedger(message); }
}

export function assertValidLedger(ledger) {
  if (!validLedgerHeader(ledger)) { invalidLedger(); }
  if (!validPendingCombination(ledger)) {
    invalidLedger("ledger: bootstrap, recovery, replace, and commit markers cannot coexist");
  }
  assertPendingRecord(ledger.bootstrap_pending, (pending) => validBootstrapPending(pending, ledger), "ledger: invalid bootstrap_pending record");
  assertPendingRecord(ledger.commit_pending, (pending) => validCommitPending(pending, ledger), "ledger: invalid commit_pending record");
  assertPendingRecord(ledger.recovery_pending, (pending) => validRecoveryPending(pending, ledger), "ledger: invalid recovery_pending record");
  assertPendingRecord(ledger.replace_pending, (pending) => validReplacePending(pending, ledger), "ledger: invalid replace_pending record");
}

function assertSupportedRecoveryCandidate(candidate: unknown): asserts candidate is RecoveryCandidate {
  if (isObject(candidate) && !Array.isArray(candidate)
      && typeof candidate.version === "number" && RECOVERY_VERSIONS.has(candidate.version)) { return; }
  throw new ClimierError("CLIMIER_UNSUPPORTED_SOURCE_VERSION", `ledger.recover: unsupported recovery state version ${isObject(candidate) ? candidate.version : undefined}`);
}

function recoveryDestination(candidate, ledger) {
  assertSupportedRecoveryCandidate(candidate);
  const compatible = {
    ...candidate,
    nodes: Object.fromEntries(Object.entries(candidate.nodes || {}).map(([id, node]) => [id, { ...node }])),
  };
  validateStateInvariants(compatible, "ledger.recover.candidate");
  const highWater = Math.max(
    ledger.high_water_revision,
    typeof compatible.revision === "number" && Number.isInteger(compatible.revision) && compatible.revision >= 0 ? compatible.revision : 0,
    maxNodeRevision(compatible),
  );
  const fence = highWater + 1;
  const destination = {
    ...compatible,
    version: STATE_SCHEMA_VERSION,
    revision: fence,
    fence_generation: ledger.fence_generation,
    nodes: Object.fromEntries(Object.entries(compatible.nodes).map(([id, node]) => [id, { ...node, revision: fence }])),
  };
  validateStateInvariants(destination, "ledger.recover.destination");
  return { destination, destinationRaw: `${JSON.stringify(destination, null, 2)}\n`, highWater: fence, fence };
}

async function readPendingRecoveryStage(stagePath, pending) {
  let stageRaw;
  try {
    stageRaw = await fs.readFile(stagePath, "utf8");
  } catch (rawCaughtValue: unknown) {
  {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") {
      throw fingerprintMismatch("recovery stage is missing; explicit recovery is required");
    }
    throw error;

  }}
  if (sha256(stageRaw) !== pending.destination_sha256) {
    throw fingerprintMismatch("recovery stage does not match the pending destination fingerprint");
  }
  const staged = readJson(stageRaw, "recovery stage");
  if (staged.version !== STATE_SCHEMA_VERSION
      || staged.fence_generation !== pending.fence_generation
      || staged.revision !== pending.high_water_revision) {
    throw fingerprintMismatch("recovery stage does not match the pending generation or high-water revision");
  }
  validateStateInvariants(staged, "ledger.recover.stage");
  return stageRaw;
}

function assertCorruptRecoverySource(rawState) {
  try {
    JSON.parse(rawState);
  } catch {
    return;
  }
  throw fingerprintMismatch("recovery source is no longer corrupt");
}

function assertLegacyRecoverySource(rawState: string, _pending?: unknown): void {
  const source = readJson(rawState, "recovery source state");
  if (source.version !== STATE_SCHEMA_VERSION || !Number.isInteger(source.fence_generation)) {
    throw fingerprintMismatch("recovery source no longer matches the stale canonical state");
  }
}

function assertRecoverySourceMatches(rawState, pending) {
  if (pending.corrupt_source) {
    assertCorruptRecoverySource(rawState);
  } else {
    assertLegacyRecoverySource(rawState, pending);
  }
}

async function replaceStateFromPendingRecovery({ statePath, stageRaw, pending, rawState, opts }) {
  const currentHash = sha256(rawState);
  if (currentHash !== pending.source_sha256) {
    if (currentHash !== pending.destination_sha256) {
      throw fingerprintMismatch("state fingerprint diverged from pending recovery source and destination");
    }
    return rawState;
  }
  assertRecoverySourceMatches(rawState, pending);
  fault(opts, "before-state-rename");
  await durableReplace(statePath, stageRaw);
  fault(opts, "after-state-rename");
  return stageRaw;
}

async function finishPendingRecovery({ statePath, ledgerPath, ledger, rawState, opts = {} }) {
  const pending = ledger.recovery_pending;
  const stagePath = recoveryStagePath(statePath, pending.stage_id);
  const stageRaw = await readPendingRecoveryStage(stagePath, pending);
  rawState = await replaceStateFromPendingRecovery({ statePath, stageRaw, pending, rawState, opts });
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

async function readRecoveryFiles(statePath) {
  let rawState;
  try {
    rawState = await fs.readFile(statePath, "utf8");
  } catch (rawCaughtValue: unknown) {
  {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") {
      throw new ClimierError("CLIMIER_LEDGER_STATE_MISMATCH", "ledger.recover: state file is required for explicit recovery");
    }
    throw error;

  }}
  const ledgerPath = path.join(path.dirname(statePath), "revision-ledger.json");
  let ledger;
  try {
    ledger = readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger");
  } catch (rawCaughtValue: unknown) {
  {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") {
      throw new ClimierError("CLIMIER_LEDGER_MISSING", "ledger.recover: revision ledger is required; refusing reconstruction");
    }
    throw error;

  }}
  assertValidLedger(ledger);
  return { rawState, ledger, ledgerPath };
}

function recoveryInputHash(candidate) {
  return sha256(`${JSON.stringify(candidate, null, 2)}\n`);
}

function validRecoveryRetryInput(candidate, pending) {
  if (candidate === undefined) { return true; }
  if (pending.input_sha256 === null) { return pending.candidate_supplied !== true; }
  return pending.input_sha256 === recoveryInputHash(candidate);
}

async function assertRecoveryRetryInput(candidate, pending) {
  if (!validRecoveryRetryInput(candidate, pending)) {
    throw fingerprintMismatch("retry candidate does not match the pending recovery input fingerprint");
  }
}

async function resumePendingRecovery({ statePath, ledgerPath, ledger, rawState, candidate, opts }) {
  const pending = ledger.recovery_pending;
  await assertRecoveryRetryInput(candidate, pending);
  if (!candidate && sha256(rawState) === pending.destination_sha256) {
    candidate = readJson(rawState, "recovered state");
  }
  await readPendingRecoveryStage(recoveryStagePath(statePath, pending.stage_id), pending);
  return finishPendingRecovery({ statePath, ledgerPath, ledger, rawState, opts });
}

async function resumeOtherPending({ statePath, ledgerPath, ledger, rawState, opts, finalizers }) {
  const { finishPendingBootstrap, finishPendingCommit } = finalizers;
  if (ledger.bootstrap_pending) {
    return finishPendingBootstrap({ statePath, ledgerPath, ledger });
  }
  if (ledger.commit_pending) {
    return finishPendingCommit({ statePath, ledgerPath, ledger, rawState, opts });
  }
  return null;
}

function alreadyRecovered(rawState, candidate, ledger) {
  const sourceHash = sha256(rawState);
  const inputHash = candidate === undefined ? null : sha256(`${JSON.stringify(candidate, null, 2)}\n`);
  if (ledger.last_recovery?.destination_sha256 !== sourceHash
      || (candidate !== undefined && ledger.last_recovery.input_sha256 !== inputHash)) { return null; }
  const recovered = readJson(rawState, "recovered state");
  assertFencedState(recovered, ledger);
  return recovered;
}

function assertNoCandidateForCorruptSource(candidate) {
  if (candidate !== undefined) {
    throw fingerprintMismatch("corrupt-source recovery does not accept a replacement candidate");
  }
}

function recoverySource(rawState, candidate, ledger) {
  let source: Record<string, unknown> | null = null;
  let corruptSource = false;
  try {
    source = readJson(rawState, "state");
  } catch (rawCaughtValue: unknown) {
  {
    const error = asCaughtError(rawCaughtValue);
    if (error.code !== "CLIMIER_CORRUPT_LEDGER") { throw error; }
    corruptSource = true;

  }}
  if (corruptSource) {
    assertNoCandidateForCorruptSource(candidate);
    candidate = { version: STATE_SCHEMA_VERSION, fence_generation: ledger.fence_generation, nodes: {}, edges: [], initiatives: {}, log: [], revision: 0 };
  } else if (!source || source.version !== STATE_SCHEMA_VERSION || !Number.isInteger(source.fence_generation)) {
    throw fingerprintMismatch("explicit recovery accepts only a canonical version 1 source state");
  }
  return { source, candidate: candidate ?? source, corruptSource };
}

async function stageRecovery({ statePath, ledgerPath, ledger, rawState, source, candidate, candidateSupplied, corruptSource, opts }) {
  const inputRaw = `${JSON.stringify(candidateSupplied ? candidate : undefined, null, 2)}\n`;
  const inputHash = candidateSupplied ? sha256(inputRaw) : null;
  const sourceHash = sha256(rawState);
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
    source_version: corruptSource ? STATE_SCHEMA_VERSION : source.version,
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

export async function recoverUnderActiveLock(lockContext, candidate, opts = {}, finalizers = {}) {
  const candidateSupplied = candidate !== undefined;
  const { statePath } = getActiveLockContext(lockContext);
  const { rawState, ledger, ledgerPath } = await readRecoveryFiles(statePath);
  const pendingResult = await resumeOtherPending({ statePath, ledgerPath, ledger, rawState, opts, finalizers });
  if (pendingResult !== null) { return pendingResult; }
  if (ledger.recovery_pending) {
    return resumePendingRecovery({ statePath, ledgerPath, ledger, rawState, candidate, opts });
  }
  const recovered = alreadyRecovered(rawState, candidate, ledger);
  if (recovered !== null) { return recovered; }
  const source = recoverySource(rawState, candidate, ledger);
  return stageRecovery({ statePath, ledgerPath, ledger, rawState, ...source, candidateSupplied, opts });
}
