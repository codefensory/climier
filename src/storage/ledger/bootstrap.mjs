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

async function readPendingBootstrapState(statePath, stagePath, pending, ledger) {
  try {
    const rawState = await fs.readFile(statePath, "utf8");
    if (sha256(rawState) !== pending.destination_sha256) {
      throw fingerprintMismatch("state diverged from the pending bootstrap destination");
    }
    return rawState;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    const staged = await readPendingBootstrapStage(stagePath, pending, ledger);
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

async function finishPendingBootstrap({ statePath, ledgerPath, ledger, expectedDestinationRaw }) {
  const pending = ledger.bootstrap_pending;
  if (!pending) {
    return null;
  }
  if (expectedDestinationRaw && sha256(expectedDestinationRaw) !== pending.destination_sha256) {
    throw fingerprintMismatch("retry initial state does not match the pending bootstrap destination");
  }
  const stagePath = bootstrapStagePath(statePath, pending.stage_id);
  const rawState = await readPendingBootstrapState(statePath, stagePath, pending, ledger);
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

function makeBootstrapLedger(prepared, destinationHash, stageId) {
  return {
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
}

async function createPendingBootstrap({ stagePath, ledgerPath, statePath, prepared, ledger, opts }) {
  await writeDurableStage(stagePath, prepared.destinationRaw);
  fault(opts, "before-pending");
  await durableCreate(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  fault(opts, "after-pending");
  try {
    await fs.link(stagePath, statePath);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw bootstrapExists();
    }
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
  if (await fileExists(statePath)) {
    throw bootstrapExists();
  }
  return createInitialBootstrap({ statePath, ledgerPath, prepared, opts });
}

async function createInitialBootstrap({ statePath, ledgerPath, prepared, opts }) {
  await cleanOrphanBootstrapStages(statePath);
  const stageId = crypto.randomBytes(16).toString("hex");
  const stagePath = bootstrapStagePath(statePath, stageId);
  const destinationHash = sha256(prepared.destinationRaw);
  const ledger = makeBootstrapLedger(prepared, destinationHash, stageId);
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
    const initialState = { version: 4, nodes: {}, edges: [], initiatives: {}, log: [], revision: 0 };
    const rawState = `${JSON.stringify(initialState, null, 2)}\n`;
    await durableReplace(statePath, rawState);
    return rawState;
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
  if (state.version !== FENCED_STATE_VERSION) {
    const error = new Error("ledger: fenced project is missing v5 state marker; refusing legacy downgrade");
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

async function bootstrapLocked(projectDir, opts, handlers) {
  const statePath = stateFile(projectDir);
  const ledgerPath = ledgerFile(projectDir);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const initialLedger = await readOptionalLedger(ledgerPath);
  if (initialLedger && hasPendingBootstrap(initialLedger)) {
    return finishPendingBootstrap({ statePath, ledgerPath, ledger: initialLedger });
  }
  const rawState = await readOrCreateState(statePath);
  const ledger = initialLedger ?? await readOptionalLedger(ledgerPath);
  if (ledger) {
    return finishExistingLedger({ statePath, ledgerPath, ledger, rawState, opts }, handlers);
  }
  return prepareMigration({ statePath, ledgerPath, rawState, opts });
}


export { fileExists, finishPendingBootstrap, bootstrapLocked };
