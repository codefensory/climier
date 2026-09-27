// Durable fenced-commit protocol and its pending-stage recovery.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isFencedStateVersion } from "../state.mjs";
import { getActiveLockContext, assertActiveLockContext } from "../lock.mjs";
import { validateStateInvariants } from "../../contracts/state-invariants.mjs";
import { assertValidLedger } from "./recovery.mjs";
import { finishPendingBootstrap } from "./bootstrap.mjs";
import { finishPendingMigration } from "./migration.mjs";
import { assertFencedMigrationSource, assertSchemaMigrationDestination, assertSchemaMigratedState, assertFencedState, hasFencedSchemaMigrationEntry, isSchemaMigratedState, commitStagePath, durableReplace, fault, fingerprintMismatch, maxNodeRevision, persistLedger, readJson, sha256, writeDurableStage } from "./stages.mjs";

function ledgerFile(statePath) {
  return path.join(path.dirname(statePath), "revision-ledger.json");
}

async function readCommitStage(stagePath, pending) {
  let raw;
  try {
    raw = await fs.readFile(stagePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw fingerprintMismatch("commit stage is missing; explicit recovery is required");
    }
    throw error;
  }
  if (sha256(raw) !== pending.destination_sha256) {
    throw fingerprintMismatch("commit stage does not match the pending destination fingerprint");
  }
  const destination = readJson(raw, "commit stage");
  const expectedRevision = pending.high_water_revision;
  if ((!isFencedStateVersion(destination.version) && (!pending.schema_only_migration
      || !isSchemaMigratedState(destination, { fence_generation: pending.fence_generation, high_water_revision: pending.high_water_revision })))
      || !Number.isInteger(destination.fence_generation)
      || destination.fence_generation !== pending.fence_generation
      || destination.revision !== expectedRevision) {
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

function assertCommitSource(rawState, pending, ledger) {
  const source = readJson(rawState, "commit source state");
  if (pending.schema_only_migration) {
    try {
      assertFencedMigrationSource(source, { ...ledger, high_water_revision: pending.source_high_water_revision });
    } catch (cause) {
      throw fingerprintMismatch(`schema-only migration source is invalid: ${cause.message}`);
    }
    if (pending.high_water_revision !== pending.source_high_water_revision + 1
        || ledger.high_water_revision !== pending.high_water_revision) {
      throw fingerprintMismatch("schema-only migration reservation does not advance exactly one state revision");
    }
    return;
  }
  if (!isFencedStateVersion(source.version)
      || source.fence_generation !== pending.fence_generation
      || source.revision !== pending.source_high_water_revision
      || source.revision > ledger.high_water_revision) {
    throw fingerprintMismatch("commit source does not match its reserved generation or source high-water revision");
  }
  validateStateInvariants(source, "ledger.commit.source");
  if (pending.high_water_revision < ledger.high_water_revision) {
    throw fingerprintMismatch("commit reservation regressed the durable high-water revision");
  }
}

async function installPendingCommitSource({ statePath, rawState, pending, ledger, opts, stagedDestination }) {
  assertCommitSource(rawState, pending, ledger);
  fault(opts, "before-state-rename");
  await durableReplace(statePath, stagedDestination);
  fault(opts, "after-state-rename");
  return stagedDestination;
}

function assertInstalledCommit(rawState, pending) {
  const destination = readJson(rawState, "committed state");
  const expectedRevision = pending.high_water_revision;
  if (destination.fence_generation !== pending.fence_generation
      || destination.revision !== expectedRevision
      || sha256(rawState) !== pending.destination_sha256) {
    throw fingerprintMismatch("installed destination does not match pending commit");
  }
  if (pending.schema_only_migration) {
    assertSchemaMigratedState(destination, { fence_generation: pending.fence_generation, high_water_revision: pending.high_water_revision }, expectedRevision);
  } else {
    assertFencedState(destination, {
      fence_generation: pending.fence_generation,
      high_water_revision: pending.high_water_revision,
    });
  }
  return destination;
}

async function clearPendingCommit({ stagePath, ledgerPath, ledger, pending, opts }) {
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
}

async function finishPendingCommit({ statePath, ledgerPath, ledger, rawState, opts = {} }) {
  const pending = ledger.commit_pending;
  const stagePath = commitStagePath(statePath, pending.stage_id);
  const stagedDestination = await readCommitStage(stagePath, pending);
  const sourceHash = sha256(rawState);
  let schemaSource;
  if (sourceHash === pending.source_sha256) {
    if (pending.schema_only_migration) {
      schemaSource = await readSchemaMigrationSource({ rawState, pending, ledger });
    }
    rawState = await installPendingCommitSource({
      statePath,
      rawState,
      pending,
      ledger,
      opts,
      stagedDestination,
    });
  } else if (sourceHash !== pending.destination_sha256) {
    throw fingerprintMismatch("state fingerprint diverged from pending commit; explicit recovery is required");
  }
  const destination = assertInstalledCommit(rawState, pending);
  if (pending.schema_only_migration && schemaSource) {
    assertSchemaMigrationDestination(
      schemaSource,
      destination,
      { ...ledger, high_water_revision: pending.source_high_water_revision },
      ledger,
    );
  }
  await clearPendingCommit({ stagePath, ledgerPath, ledger, pending, opts });
  return destination;
}

function schemaOnlyMigration(current, candidate, ledger) {
  if (!current || current.version !== 5 || candidate?.version !== 1
      || candidate.revision !== ledger.high_water_revision + 1
      || candidate.fence_generation !== ledger.fence_generation
      || !hasFencedSchemaMigrationEntry(candidate)
      || current.log.length + 1 !== candidate.log.length
      || !isDeepStrictEqual(current.log, candidate.log.slice(0, -1))) return false;
  const { version: _currentVersion, revision: _currentRevision, log: _currentLog, ...currentData } = current;
  const { version: _candidateVersion, revision: _candidateRevision, log: _candidateLog, ...candidateData } = candidate;
  return isDeepStrictEqual(currentData, candidateData)
    && Object.entries(current.nodes).every(([id, node]) => candidate.nodes[id]?.revision === node.revision);
}

function assertCandidateEnvelope(candidate, current, ledger) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("ledger.commit: candidate must be a state object");
  }
  if (!isFencedStateVersion(candidate.version) && !schemaOnlyMigration(current, candidate, ledger)) {
    throw new Error("ledger.commit: candidate schema version must be canonical version 1 or fenced legacy version 5");
  }
}

function assertCandidateGeneration(candidate, current, ledger) {
  if (!Number.isInteger(candidate.fence_generation)
      || candidate.fence_generation !== ledger.fence_generation
      || candidate.fence_generation !== current.fence_generation) {
    throw new Error("ledger.commit: candidate fence_generation must preserve the local generation");
  }
}

function assertCandidateRevision(candidate, ledger, migration = false) {
  const schemaMigrationCommit = migration && candidate.revision === ledger.high_water_revision + 1;
  if (!Number.isInteger(candidate.revision) || (candidate.revision <= ledger.high_water_revision && !schemaMigrationCommit)) {
    throw new Error("ledger.commit: candidate state revision must advance monotonically beyond ledger high-water revision");
  }
}

function assertCandidateRevisionRange(candidate, ledger, candidateNodeMax, migration = false) {
  const schemaMigrationCommit = migration && candidate.revision === ledger.high_water_revision + 1;
  if (candidateNodeMax > candidate.revision) {
    throw new Error("ledger.commit: node revision cannot exceed candidate state revision");
  }
  if ((!schemaMigrationCommit && candidate.revision < ledger.high_water_revision) || candidate.revision < candidateNodeMax) {
    throw new Error("ledger.commit: candidate does not reserve all state and node revisions");
  }
}

function assertNodeRevision(node, previous, id, current) {
  if (!Number.isInteger(node.revision) || node.revision < 0) {
    throw new Error(`ledger.commit: node ${id} revision must be a non-negative integer`);
  }
  if (!previous && node.revision <= current.revision) {
    throw new Error(`ledger.commit: new node ${id} revision must exceed current state revision`);
  }
  if (previous && node.revision < previous.revision) {
    throw new Error(`ledger.commit: node ${id} revision must be monotonic`);
  }
}

function assertChangedNodeRevision(node, previous, id, current) {
  const { revision: _previousRevision, ...previousData } = previous;
  const { revision: _candidateRevision, ...candidateData } = node;
  if (!isDeepStrictEqual(previousData, candidateData)
      && node.revision <= Math.max(previous.revision, current.revision)) {
    throw new Error(`ledger.commit: modified node ${id} revision must exceed its prior and state revisions`);
  }
}

function validateCandidateNodes(candidate, current, migration = false) {
  if (migration && candidate.version === 1 && candidate.revision === current.revision + 1) {
    for (const [id, node] of Object.entries(candidate.nodes)) {
      if (!current.nodes[id] || node.revision !== current.nodes[id].revision) {
        throw new Error(`ledger.commit: schema-only migration must preserve node ${id} revision`);
      }
    }
    return;
  }
  for (const [id, node] of Object.entries(candidate.nodes)) {
    const previous = current.nodes[id];
    assertNodeRevision(node, previous, id, current);
    if (previous) {
      assertChangedNodeRevision(node, previous, id, current);
    }
  }
}

function validateCommitCandidate(candidate, current, ledger) {
  const migration = schemaOnlyMigration(current, candidate, ledger);
  assertCandidateEnvelope(candidate, current, ledger);
  assertCandidateGeneration(candidate, current, ledger);
  assertCandidateRevision(candidate, ledger, migration);
  validateStateInvariants(candidate, "ledger.commit.candidate");
  const candidateNodeMax = maxNodeRevision(candidate);
  assertCandidateRevisionRange(candidate, ledger, candidateNodeMax, migration);
  validateCandidateNodes(candidate, current, migration);
  return candidateNodeMax;
}

/**
 * Atomically commit a fenced state while the caller holds this project's lock.
 * This API validates the opaque lock capability and never reacquires the lock.
 */
async function readRequiredCommitLedger(ledgerPath) {
  try {
    return readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger");
  } catch (error) {
    if (error.code === "ENOENT") {
      const missing = new Error("ledger: revision ledger is missing for fenced commit; refusing reconstruction");
      missing.code = "CLIMIER_LEDGER_MISSING";
      throw missing;
    }
    throw error;
  }
}

async function recoverPendingCommitPrerequisite({ statePath, ledgerPath, ledger }) {
  if (ledger.bootstrap_pending) {
    await finishPendingBootstrap({ statePath, ledgerPath, ledger });
    throw new Error("ledger.commit: bootstrap recovery completed; retry against the recovered state");
  }
  if (ledger.migration_pending) {
    const rawState = await fs.readFile(statePath, "utf8");
    await finishPendingMigration({ statePath, ledgerPath, ledger, rawState });
    throw new Error("ledger.commit: migration recovery completed; retry against the recovered state");
  }
}

async function recoverPendingCommitState({ statePath, ledgerPath, ledger, rawState, opts }) {
  if (!ledger.commit_pending) {
    return null;
  }
  await finishPendingCommit({ statePath, ledgerPath, ledger, rawState, opts });
  throw new Error("ledger.commit: pending commit recovery completed; retry against the recovered state");
}

async function stageCommit({ statePath, ledgerPath, ledger, rawState, candidate, candidateNodeMax, opts }) {
  const schemaMigrationCommit = schemaOnlyMigration(readJson(rawState, "fenced state"), candidate, ledger);
  const highWater = schemaMigrationCommit
    ? candidate.revision
    : Math.max(ledger.high_water_revision, candidate.revision, candidateNodeMax);
  const destinationRaw = `${JSON.stringify(candidate, null, 2)}\n`;
  const stagePath = commitStagePath(statePath, crypto.randomBytes(16).toString("hex"));
  const pending = {
    source_sha256: sha256(rawState),
    destination_sha256: sha256(destinationRaw),
    stage_id: path.basename(stagePath).slice(".commit-stage-".length),
    source_high_water_revision: ledger.high_water_revision,
    high_water_revision: highWater,
    fence_generation: ledger.fence_generation,
    ...(schemaMigrationCommit ? { schema_only_migration: true } : {}),
  };
  await writePendingCommitStage({ stagePath, ledgerPath, statePath, ledger, pending, destinationRaw, opts });
  return finishPendingCommit({ statePath, ledgerPath, ledger, rawState: destinationRaw, opts });
}

async function writePendingCommitStage({ stagePath, ledgerPath, statePath, ledger, pending, destinationRaw, opts }) {
  fault(opts, "before-stage");
  await writeDurableStage(stagePath, destinationRaw);
  fault(opts, "after-stage");
  fault(opts, "before-pending");
  ledger.commit_pending = pending;
  delete ledger.last_recovery;
  // Reserve before installing state so the durable fence never moves backward.
  ledger.high_water_revision = pending.high_water_revision;
  await persistLedger(ledgerPath, ledger);
  fault(opts, "after-pending");
  await installStagedCommit({ statePath, destinationRaw, opts });
}

async function installStagedCommit({ statePath, destinationRaw, opts }) {
  fault(opts, "before-state-rename");
  await durableReplace(statePath, destinationRaw);
  fault(opts, "after-state-rename");
}

async function readSchemaMigrationSource({ rawState, pending, ledger }) {
  const source = readJson(rawState, "schema migration source state");
  if (!pending.schema_only_migration
      || pending.high_water_revision !== pending.source_high_water_revision + 1
      || ledger.high_water_revision !== pending.high_water_revision) {
    throw fingerprintMismatch("schema-only migration reservation does not advance exactly one state revision");
  }
  try {
    assertFencedMigrationSource(source, { ...ledger, high_water_revision: pending.source_high_water_revision });
  } catch (cause) {
    throw fingerprintMismatch(`schema-only migration source is invalid: ${cause.message}`);
  }
  return source;
}

export async function commitFencedStateUnderLock(lockContext, candidate, opts = {}) {
  assertActiveLockContext(lockContext);
  const { statePath } = getActiveLockContext(lockContext);
  const ledgerPath = ledgerFile(statePath);
  await fs.mkdir(path.dirname(statePath), { recursive: true });

  const ledger = await readRequiredCommitLedger(ledgerPath);
  assertValidLedger(ledger);
  await recoverPendingCommitPrerequisite({ statePath, ledgerPath, ledger });
  const rawState = await fs.readFile(statePath, "utf8");
  await recoverPendingCommitState({ statePath, ledgerPath, ledger, rawState, opts });
  const current = readJson(rawState, "fenced state");
  if (schemaOnlyMigration(current, candidate, ledger)) {
    assertFencedMigrationSource(current, ledger);
  } else {
    assertFencedState(current, ledger);
  }
  const candidateNodeMax = validateCommitCandidate(candidate, current, ledger);
  return stageCommit({ statePath, ledgerPath, ledger, rawState, candidate, candidateNodeMax, opts });
}

export { cleanOrphanCommitStages, finishPendingCommit };
