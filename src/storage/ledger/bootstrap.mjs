// Durable fenced bootstrap and initial-state protocol.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { stateFile, migrateState, STATE_SCHEMA_VERSION, FENCED_STATE_VERSION } from "../state.mjs";
import { assertActiveLockContext, getActiveLockContext } from "../lock.mjs";
import { validateStateInvariants } from "../../contracts/state-invariants.mjs";
import { assertValidLedger, LEDGER_VERSION, SOURCE_VERSIONS } from "./recovery.mjs";
import { fencedDestination, finishPendingMigration } from "./migration.mjs";
import { assertFencedState, bootstrapStagePath, durableCreate, durableReplace, fault, fingerprintMismatch, maxNodeRevision, persistLedger, readJson, sha256, syncDirectory, writeDurableStage } from "./stages.mjs";

function ledgerFile(projectDir) {
  return path.join(path.dirname(stateFile(projectDir)), "revision-ledger.json");
}

function assertSupportedInitialState(initialState) {
  if (!initialState || typeof initialState !== "object" || Array.isArray(initialState)
      || (!SOURCE_VERSIONS.has(initialState.version) && initialState.version !== STATE_SCHEMA_VERSION)) {
    const error = new Error(`ledger.bootstrap: unsupported initial state version ${initialState?.version}`);
    error.code = "CLIMIER_UNSUPPORTED_SOURCE_VERSION";
    throw error;
  }
}

function fencedInitialState(initialState) {
  assertSupportedInitialState(initialState);
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
    version: STATE_SCHEMA_VERSION,
    revision: fence,
    fence_generation: 1,
    nodes: Object.fromEntries(Object.entries(compatible.nodes).map(([id, node]) => [id, { ...node, revision: fence }])),
  };
  validateStateInvariants(destination, "ledger.bootstrap.initial.destination");
  return { destination, destinationRaw: `${JSON.stringify(destination, null, 2)}\n`, highWater: fence };
}

async function readPendingBootstrapStage(stagePath, pending, ledger) {
  let staged;
  try {
    staged = await fs.readFile(stagePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw fingerprintMismatch("bootstrap stage is missing; explicit recovery is required");
    }
    throw error;
  }
  if (sha256(staged) !== pending.destination_sha256) {
    throw fingerprintMismatch("bootstrap stage does not match the pending destination fingerprint");
  }
  assertFencedState(readJson(staged, "bootstrap stage"), ledger);
  return staged;
}

async function publishPendingBootstrapStage(stagePath, statePath, pending, staged) {
  try {
    await fs.link(stagePath, statePath);
    await syncDirectory(path.dirname(statePath));
    return staged;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    const rawState = await fs.readFile(statePath, "utf8");
    if (sha256(rawState) !== pending.destination_sha256) {
      throw fingerprintMismatch("state appeared with a different bootstrap destination");
    }
    return rawState;
  }
}

async function checkpoint(opts, point) {
  fault(opts, point);
  if (typeof opts.onCheckpoint === "function") {
    await opts.onCheckpoint(point);
  }
}

async function replacePendingBootstrapSource(statePath, stagePath, pending, ledger, rawState, opts) {
  if (!pending.source_sha256 || sha256(rawState) !== pending.source_sha256) {
    throw fingerprintMismatch("state diverged from the pending bootstrap source and destination");
  }
  const staged = await readPendingBootstrapStage(stagePath, pending, ledger);
  await checkpoint(opts, "before-state-replace");
  await durableReplace(statePath, staged);
  await checkpoint(opts, "after-state-replace");
  return staged;
}

async function readPendingBootstrapState(statePath, stagePath, pending, ledger, opts) {
  try {
    const rawState = await fs.readFile(statePath, "utf8");
    const currentHash = sha256(rawState);
    if (currentHash === pending.destination_sha256) {
      return rawState;
    }
    if (pending.source_sha256 && currentHash === pending.source_sha256) {
      return replacePendingBootstrapSource(statePath, stagePath, pending, ledger, rawState, opts);
    }
    throw fingerprintMismatch("state diverged from the pending bootstrap source and destination");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    const staged = await readPendingBootstrapStage(stagePath, pending, ledger);
    if (pending.source_sha256) {
      await checkpoint(opts, "before-state-replace");
      await durableReplace(statePath, staged);
      await checkpoint(opts, "after-state-replace");
      return staged;
    }
    return publishPendingBootstrapStage(stagePath, statePath, pending, staged);
  }
}

async function clearPendingBootstrap({ stagePath, statePath, ledgerPath, ledger, state }) {
  assertFencedState(state, ledger);
  ledger.bootstrap_pending = null;
  await persistLedger(ledgerPath, ledger);
  await fs.unlink(stagePath).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
  await syncDirectory(path.dirname(statePath));
  return state;
}

async function finishPendingBootstrap({ statePath, ledgerPath, ledger, expectedDestinationRaw, opts = {} }) {
  const pending = ledger.bootstrap_pending;
  if (!pending) {
    return null;
  }
  if (expectedDestinationRaw && sha256(expectedDestinationRaw) !== pending.destination_sha256) {
    throw fingerprintMismatch("retry initial state does not match the pending bootstrap destination");
  }
  const stagePath = bootstrapStagePath(statePath, pending.stage_id);
  const rawState = await readPendingBootstrapState(statePath, stagePath, pending, ledger, opts);
  const state = readJson(rawState, "bootstrapped state");
  return clearPendingBootstrap({ stagePath, statePath, ledgerPath, ledger, state });
}

async function cleanOrphanBootstrapStages(statePath) {
  const directory = path.dirname(statePath);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  let changed = false;
  for (const entry of entries) {
    if (entry.isFile() && /^\\.bootstrap-stage-[a-f0-9]{32}$/.test(entry.name)) {
      await fs.unlink(path.join(directory, entry.name));
      changed = true;
    }
  }
  if (changed) {
    await syncDirectory(directory);
  }
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
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function loadExistingBootstrapLedger(ledgerPath) {
  try {
    const ledger = readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger");
    assertValidLedger(ledger);
    return ledger;
  } catch (error) {
    if (error.code === "ENOENT"
        || error.code === "CLIMIER_CORRUPT_LEDGER"
        || error.code === "CLIMIER_INVALID_LEDGER") {
      throw bootstrapExists();
    }
    throw error;
  }
}

function hasPendingBootstrap(ledger) {
  return ledger.bootstrap_pending !== null && ledger.bootstrap_pending !== undefined;
}

function makeBootstrapLedger(prepared, destinationHash, stageId, sourceRaw = null) {
  return {
    version: LEDGER_VERSION,
    fence_generation: 1,
    high_water_revision: prepared.highWater,
    migration_pending: null,
    commit_pending: null,
    bootstrap_pending: {
      ...(sourceRaw === null ? {} : { source_sha256: sha256(sourceRaw) }),
      destination_sha256: destinationHash,
      stage_id: stageId,
      fence_generation: 1,
      high_water_revision: prepared.highWater,
    },
  };
}

async function createPendingBootstrap({ stagePath, ledgerPath, statePath, prepared, ledger, opts }) {
  await writeDurableStage(stagePath, prepared.destinationRaw);
  await checkpoint(opts, "before-pending");
  await durableCreate(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  await checkpoint(opts, "after-pending");
  if (await fileExists(statePath) && ledger.bootstrap_pending.source_sha256) {
    const sourceRaw = await fs.readFile(statePath, "utf8");
    await replacePendingBootstrapSource(statePath, stagePath, ledger.bootstrap_pending, ledger, sourceRaw, opts);
  } else {
    try {
      await fs.link(stagePath, statePath);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw bootstrapExists();
      }
      throw error;
    }
    await syncDirectory(path.dirname(statePath));
  }
  fault(opts, "after-state-create");
  return finishPendingBootstrap({
    statePath,
    ledgerPath,
    ledger,
    expectedDestinationRaw: prepared.destinationRaw,
    opts,
  });
}

export async function bootstrapInitialUnderLock(lockContext, initialState, opts = {}) {
  assertActiveLockContext(lockContext, opts.projectDir);
  const { projectDir, statePath } = getActiveLockContext(lockContext);
  const ledgerPath = ledgerFile(projectDir);
  const prepared = fencedInitialState(initialState);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  if (await fileExists(ledgerPath)) {
    const ledger = await loadExistingBootstrapLedger(ledgerPath);
    if (!hasPendingBootstrap(ledger)) {
      throw bootstrapExists();
    }
    return finishPendingBootstrap({
      statePath,
      ledgerPath,
      ledger,
      expectedDestinationRaw: prepared.destinationRaw,
    });
  }
  if (await fileExists(statePath) && opts.replaceExisting !== true) {
    throw bootstrapExists();
  }
  return createInitialBootstrap({ statePath, ledgerPath, prepared, opts });
}

async function createInitialBootstrap({ statePath, ledgerPath, prepared, opts, sourceRaw = null }) {
  await cleanOrphanBootstrapStages(statePath);
  const stageId = crypto.randomBytes(16).toString("hex");
  const stagePath = bootstrapStagePath(statePath, stageId);
  const destinationHash = sha256(prepared.destinationRaw);
  const ledger = makeBootstrapLedger(prepared, destinationHash, stageId, sourceRaw);
  if (opts.replaceExisting === true) {
    await writeDurableStage(stagePath, prepared.destinationRaw);
    await checkpoint(opts, "before-pending");
    await durableReplace(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    await checkpoint(opts, "after-pending");
    await checkpoint(opts, "before-state-replace");
    await durableReplace(statePath, prepared.destinationRaw);
    await checkpoint(opts, "after-state-replace");
    fault(opts, "after-state-create");
    return finishPendingBootstrap({ statePath, ledgerPath, ledger, expectedDestinationRaw: prepared.destinationRaw, opts });
  }
  return createPendingBootstrap({ stagePath, ledgerPath, statePath, prepared, ledger, opts });
}

async function readOptionalLedger(ledgerPath) {
  try {
    return readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readOrCreateState(statePath) {
  try {
    return await fs.readFile(statePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return null;
  }
}

async function finishExistingLedger({ statePath, ledgerPath, ledger, rawState, opts }, handlers) {
  assertValidLedger(ledger);
  const state = readJson(rawState, "state");
  if (ledger.migration_pending) {
    return finishPendingMigration({ statePath, ledgerPath, ledger, rawState });
  }
  if (ledger.commit_pending) {
    return handlers.finishPendingCommit({ statePath, ledgerPath, ledger, rawState, opts });
  }
  await handlers.cleanOrphanCommitStages(statePath);
  if (state.version !== FENCED_STATE_VERSION && state.version !== STATE_SCHEMA_VERSION) {
    const error = new Error("ledger: fenced project is missing a supported state marker; refusing legacy downgrade");
    error.code = "CLIMIER_LEDGER_STATE_MISMATCH";
    throw error;
  }
  assertFencedState(state, ledger);
  return state;
}

async function prepareMigration({ statePath, ledgerPath, rawState, opts }) {
  const source = readJson(rawState, "source state");
  if (source.version === FENCED_STATE_VERSION) {
    const error = new Error("ledger: revision ledger is missing for fenced state; refusing reconstruction");
    error.code = "CLIMIER_LEDGER_MISSING";
    throw error;
  }
  const { destinationRaw, highWater, fence } = fencedDestination(source);
  const ledger = {
    version: LEDGER_VERSION,
    fence_generation: 1,
    high_water_revision: fence,
    migration_pending: {
      source_version: source.version,
      source_high_water_revision: highWater,
      fence_revision: fence,
      fence_generation: 1,
      source_sha256: sha256(rawState),
      destination_sha256: sha256(destinationRaw),
    },
  };
  return publishMigration({ statePath, ledgerPath, ledger, destinationRaw, opts });
}

async function publishMigration({ statePath, ledgerPath, ledger, destinationRaw, opts }) {
  fault(opts, "before-pending");
  await persistLedger(ledgerPath, ledger);
  fault(opts, "after-pending");
  await durableReplace(statePath, destinationRaw);
  fault(opts, "after-state-rename");
  return finishPendingMigration({ statePath, ledgerPath, ledger, rawState: destinationRaw });
}

export async function migrateLegacyInitialUnderLock(lockContext, initialState, sourceRaw, opts = {}) {
  assertActiveLockContext(lockContext, opts.projectDir);
  const { projectDir, statePath } = getActiveLockContext(lockContext);
  const ledgerPath = path.join(path.dirname(statePath), "revision-ledger.json");
  const currentLedger = await readOptionalLedger(ledgerPath);
  if (currentLedger?.bootstrap_pending) {
    return finishPendingBootstrap({ statePath, ledgerPath, ledger: currentLedger, opts });
  }
  const existingState = sourceRaw === null ? null : await readOrCreateState(statePath);
  if (currentLedger?.migration_pending) {
    const error = new Error(`migrate: project ${opts.projectId || path.basename(projectDir)} has legacy migration_pending; resolve it with the pre-cut binary or recreate explicitly`);
    error.code = "CLIMIER_OLD_MIGRATION_PENDING";
    throw error;
  }
  if (currentLedger) {
    assertValidLedger(currentLedger);
    if (currentLedger.bootstrap_pending) {
      const state = await finishPendingBootstrap({ statePath, ledgerPath, ledger: currentLedger, opts });
      return state;
    }
    throw bootstrapExists();
  }
  if (sourceRaw !== null && (existingState === null || sha256(existingState) !== sha256(sourceRaw))) {
    const error = fingerprintMismatch("legacy migration source changed before bootstrap staging");
    throw error;
  }
  const prepared = fencedInitialState(initialState);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  if (sourceRaw !== null) {
    const targetHighWater = prepared.highWater + 1;
    prepared.destination.revision = targetHighWater;
    for (const node of Object.values(prepared.destination.nodes)) node.revision = targetHighWater;
    prepared.destinationRaw = `${JSON.stringify(prepared.destination, null, 2)}\n`;
    prepared.highWater = targetHighWater;
  }
  return createInitialBootstrap({ statePath, ledgerPath, prepared, opts: { ...opts, replaceExisting: true }, sourceRaw });
}

async function bootstrapLocked(projectDir, opts, handlers) {
  const statePath = stateFile(projectDir);
  const ledgerPath = ledgerFile(projectDir);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const initialLedger = await readOptionalLedger(ledgerPath);
  if (opts.replaceExisting === true) {
    const source = await readOrCreateState(statePath);
    const priorLedger = initialLedger;
    const highWater = Math.max(
      priorLedger?.high_water_revision || 0,
      source ? (() => { try { return maxNodeRevision(readJson(source, "replaced state")); } catch { return 0; } })() : 0,
    );
    const initial = { version: STATE_SCHEMA_VERSION, nodes: {}, edges: [], initiatives: {}, log: [], revision: highWater };
    const prepared = fencedInitialState(initial);
    const ledger = makeBootstrapLedger(prepared, sha256(prepared.destinationRaw), crypto.randomBytes(16).toString("hex"));
    ledger.high_water_revision = highWater + 1;
    return replaceWithCanonicalBootstrap({ statePath, ledgerPath, prepared, ledger, opts });
  }
  if (initialLedger && hasPendingBootstrap(initialLedger)) {
    return finishPendingBootstrap({ statePath, ledgerPath, ledger: initialLedger });
  }
  const rawState = await readOrCreateState(statePath);
  const ledger = initialLedger ?? await readOptionalLedger(ledgerPath);
  if (ledger) {
    if (rawState === null) {
      return finishBootstrapWithoutState(ledger, statePath, ledgerPath);
    }
    return finishExistingLedger({ statePath, ledgerPath, ledger, rawState, opts }, handlers);
  }
  if (rawState === null) {
    return createInitialBootstrap({ statePath, ledgerPath, prepared: fencedInitialState({ version: STATE_SCHEMA_VERSION, nodes: {}, edges: [], initiatives: {}, log: [], revision: 0 }), opts });
  }
  return prepareMigration({ statePath, ledgerPath, rawState, opts });
}


export { fileExists, finishPendingBootstrap, bootstrapLocked };
