// Durable fenced bootstrap and initial-state protocol.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { stateFile, migrateState, FENCED_STATE_VERSION } from "../state.mjs";
import { assertActiveLockContext, getActiveLockContext } from "../lock.mjs";
import { validateStateInvariants } from "../../contracts/state-invariants.mjs";
import { assertValidLedger, LEDGER_VERSION, SOURCE_VERSIONS } from "./recovery.mjs";
import { fencedDestination, finishPendingMigration } from "./migration.mjs";
import { assertFencedState, bootstrapStagePath, durableCreate, durableReplace, fault, fingerprintMismatch, maxNodeRevision, persistLedger, readJson, sha256, syncDirectory, writeDurableStage } from "./stages.mjs";

function ledgerFile(projectDir) {
  return path.join(path.dirname(stateFile(projectDir)), "revision-ledger.json");
}

function fencedInitialState(initialState) {
  if (!initialState || typeof initialState !== "object" || Array.isArray(initialState)
      || !SOURCE_VERSIONS.has(initialState.version)) {
    const error = new Error(`ledger.bootstrap: unsupported initial state version ${initialState?.version}`);
    error.code = "CLIMIER_UNSUPPORTED_SOURCE_VERSION";
    throw error;
  }
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
    version: FENCED_STATE_VERSION,
    revision: fence,
    fence_generation: 1,
    nodes: Object.fromEntries(Object.entries(compatible.nodes).map(([id, node]) => [id, { ...node, revision: fence }])),
  };
  validateStateInvariants(destination, "ledger.bootstrap.initial.destination");
  return { destination, destinationRaw: `${JSON.stringify(destination, null, 2)}\n`, highWater: fence };
}

async function finishPendingBootstrap({ statePath, ledgerPath, ledger, expectedDestinationRaw }) {
  const pending = ledger.bootstrap_pending;
  if (!pending) return null;
  if (expectedDestinationRaw && sha256(expectedDestinationRaw) !== pending.destination_sha256) {
    throw fingerprintMismatch("retry initial state does not match the pending bootstrap destination");
  }
  const stagePath = bootstrapStagePath(statePath, pending.stage_id);
  let rawState;
  try {
    rawState = await fs.readFile(statePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (rawState !== undefined) {
    if (sha256(rawState) !== pending.destination_sha256) {
      throw fingerprintMismatch("state diverged from the pending bootstrap destination");
    }
  } else {
    let staged;
    try {
      staged = await fs.readFile(stagePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") throw fingerprintMismatch("bootstrap stage is missing; explicit recovery is required");
      throw error;
    }
    if (sha256(staged) !== pending.destination_sha256) {
      throw fingerprintMismatch("bootstrap stage does not match the pending destination fingerprint");
    }
    const candidate = readJson(staged, "bootstrap stage");
    assertFencedState(candidate, ledger);
    try {
      await fs.link(stagePath, statePath);
      await syncDirectory(path.dirname(statePath));
      rawState = staged;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      rawState = await fs.readFile(statePath, "utf8");
      if (sha256(rawState) !== pending.destination_sha256) {
        throw fingerprintMismatch("state appeared with a different bootstrap destination");
      }
    }
  }
  const state = readJson(rawState, "bootstrapped state");
  assertFencedState(state, ledger);
  ledger.bootstrap_pending = null;
  await persistLedger(ledgerPath, ledger);
  await fs.unlink(stagePath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await syncDirectory(path.dirname(statePath));
  return state;
}

async function cleanOrphanBootstrapStages(statePath) {
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
    if (entry.isFile() && /^\\.bootstrap-stage-[a-f0-9]{32}$/.test(entry.name)) {
      await fs.unlink(path.join(directory, entry.name));
      changed = true;
    }
  }
  if (changed) await syncDirectory(directory);
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
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function bootstrapInitialUnderLock(lockContext, initialState, opts = {}) {
  assertActiveLockContext(lockContext, opts.projectDir);
  const { projectDir, statePath } = getActiveLockContext(lockContext);
  const ledgerPath = ledgerFile(projectDir);
  const prepared = fencedInitialState(initialState);
  const destinationHash = sha256(prepared.destinationRaw);
  await fs.mkdir(path.dirname(statePath), { recursive: true });

  const hasState = await fileExists(statePath);
  const hasLedger = await fileExists(ledgerPath);
  if (hasLedger) {
    let ledger;
    try {
      ledger = readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger");
      assertValidLedger(ledger);
    } catch (error) {
      if (error.code === "ENOENT") throw bootstrapExists();
      if (error.code === "CLIMIER_CORRUPT_LEDGER" || error.code === "CLIMIER_INVALID_LEDGER") throw bootstrapExists();
      throw error;
    }
    if (ledger.bootstrap_pending == null) throw bootstrapExists();
    return finishPendingBootstrap({
      statePath,
      ledgerPath,
      ledger,
      expectedDestinationRaw: prepared.destinationRaw,
    });
  }
  if (hasState) throw bootstrapExists();

  await cleanOrphanBootstrapStages(statePath);
  const stageId = crypto.randomBytes(16).toString("hex");
  const stagePath = bootstrapStagePath(statePath, stageId);
  const ledger = {
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
  await writeDurableStage(stagePath, prepared.destinationRaw);
  fault(opts, "before-pending");
  await durableCreate(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  fault(opts, "after-pending");
  try {
    await fs.link(stagePath, statePath);
  } catch (error) {
    if (error.code === "EEXIST") throw bootstrapExists();
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

async function bootstrapLocked(projectDir, opts, { finishPendingCommit, cleanOrphanCommitStages }) {
  const statePath = stateFile(projectDir);
  const ledgerPath = ledgerFile(projectDir);
  await fs.mkdir(path.dirname(statePath), { recursive: true });

  try {
    const existingLedger = readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger");
    assertValidLedger(existingLedger);
    if (existingLedger.bootstrap_pending) {
      return finishPendingBootstrap({ statePath, ledgerPath, ledger: existingLedger });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let rawState;
  try {
    rawState = await fs.readFile(statePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const state = {
      version: 4,
      nodes: {},
      edges: [],
      initiatives: {},
      log: [],
      revision: 0,
    };
    rawState = `${JSON.stringify(state, null, 2)}\n`;
    await durableReplace(statePath, rawState);
  }

  let ledger = null;
  try {
    ledger = readJson(await fs.readFile(ledgerPath, "utf8"), "revision ledger");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (ledger) {
    assertValidLedger(ledger);
    const state = readJson(rawState, "state");
    if (ledger.migration_pending) {
      return finishPendingMigration({ statePath, ledgerPath, ledger, rawState });
    }
    if (ledger.commit_pending) {
      return finishPendingCommit({ statePath, ledgerPath, ledger, rawState, opts });
    }
    await cleanOrphanCommitStages(statePath);
    if (state.version !== FENCED_STATE_VERSION) {
      const error = new Error("ledger: fenced project is missing v5 state marker; refusing legacy downgrade");
      error.code = "CLIMIER_LEDGER_STATE_MISMATCH";
      throw error;
    }
    assertFencedState(state, ledger);
    return state;
  }

  const source = readJson(rawState, "source state");
  if (source.version === FENCED_STATE_VERSION) {
    const error = new Error("ledger: revision ledger is missing for fenced state; refusing reconstruction");
    error.code = "CLIMIER_LEDGER_MISSING";
    throw error;
  }
  const { destinationRaw, highWater, fence } = fencedDestination(source);
  const pending = {
    source_version: source.version,
    source_high_water_revision: highWater,
    fence_revision: fence,
    fence_generation: 1,
    source_sha256: sha256(rawState),
    destination_sha256: sha256(destinationRaw),
  };
  ledger = {
    version: LEDGER_VERSION,
    fence_generation: 1,
    high_water_revision: fence,
    migration_pending: pending,
  };
  fault(opts, "before-pending");
  await persistLedger(ledgerPath, ledger);
  fault(opts, "after-pending");
  await durableReplace(statePath, destinationRaw);
  fault(opts, "after-state-rename");
  return finishPendingMigration({ statePath, ledgerPath, ledger, rawState: destinationRaw });
}


export { fileExists, finishPendingBootstrap, bootstrapLocked };
