import fs from "node:fs/promises";
import path from "node:path";
import { assertActiveLockContext, getActiveLockContext } from "./lock.mjs";
import { detectMigrationState } from "./migrate-detection.mjs";
import { assertValidLedger } from "./ledger/recovery.mjs";
import { assertFencedMigrationSource, readJson } from "./ledger/stages.mjs";
import { commitFencedStateUnderLock } from "./ledger/commit.mjs";
import { migrateLegacyInitialUnderLock } from "./ledger/bootstrap.mjs";
import { finishPendingBootstrap } from "./ledger/bootstrap.mjs";
import { validateStateInvariants } from "../contracts/state-invariants.mjs";
import { climierHome } from "./paths.mjs";
import { STATE_SCHEMA_VERSION } from "./state.mjs";

function ledgerPath(statePath) {
  return path.join(path.dirname(statePath), "revision-ledger.json");
}

function hasPendingOperation(ledger) {
  return Boolean(ledger.migration_pending || ledger.commit_pending || ledger.bootstrap_pending
    || ledger.recovery_pending || ledger.replace_pending);
}

async function optionalJson(file, label) {
  try {
    return { raw: await fs.readFile(file, "utf8"), exists: true };
  } catch (error) {
    if (error.code === "ENOENT") return { raw: null, exists: false };
    throw error;
  }
}

async function backupProject(projectId, projectDir) {
  const backupsDir = path.join(climierHome(), "backups", projectId);
  await fs.mkdir(backupsDir, { recursive: true });
  const timestamp = new Date().toISOString();
  let backupDir = path.join(backupsDir, timestamp);
  let suffix = 0;
  while (true) {
    try {
      await fs.access(backupDir);
      suffix += 1;
      backupDir = path.join(backupsDir, `${timestamp}-${suffix}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      break;
    }
  }
  await fs.cp(projectDir, backupDir, { recursive: true, errorOnExist: true, force: false });
  try {
    await fs.access(path.join(backupDir, "revision-ledger.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;

    await fs.writeFile(path.join(backupDir, "revision-ledger.json"), `${JSON.stringify({ absent_at_backup: true }, null, 2)}\n`, { flag: "wx" });
  }
  return backupDir;
}

function normalizeLegacyState(source, form) {
  if (form === "pre-release") {
    return { version: STATE_SCHEMA_VERSION, nodes: {}, edges: [], initiatives: {}, log: [], revision: 0 };
  }
  const nodes = source.nodes && typeof source.nodes === "object" && !Array.isArray(source.nodes)
    ? Object.fromEntries(Object.entries(source.nodes).map(([id, node]) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return [id, node];
      const normalized = { ...node };
      if (normalized.subkind === "gate" && normalized.resolution_mode === undefined) {
        normalized.resolution_mode = "choice";
      }
      return [id, normalized];
    }))
    : {};
  const normalized = {
    ...source,

    version: 4,
    nodes,
    edges: Array.isArray(source.edges) ? source.edges : [],
    initiatives: source.initiatives && typeof source.initiatives === "object" && !Array.isArray(source.initiatives)
      ? source.initiatives
      : {},
    log: Array.isArray(source.log) ? source.log : [],
    revision: Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
  };
  return normalized;
}

async function migrateParsedOldProjectUnderLock(lockContext, projectId, rawState, source, ledger, opts = {}) {
  const { projectDir, statePath } = getActiveLockContext(lockContext);
  const detected = detectMigrationState(source, { hasLedger: Boolean(ledger) });
  if (ledger?.migration_pending) {
    const error = new Error(`migrate: project ${projectId} has legacy migration_pending; resolve it with the pre-cut binary or recreate explicitly`);
    error.code = "CLIMIER_OLD_MIGRATION_PENDING";
    throw error;
  }
  if (detected.error) throw new Error(`migrate: project ${projectId}: ${detected.error}`);
  if (!new Set(["pre-release", "legacy-v2", "legacy-v3", "legacy-v4"]).has(detected.form)) {
    throw new Error(`migrate: project ${projectId} has unsupported form ${detected.form}`);
  }
  if (ledger) {
    assertValidLedger(ledger);
    if (hasPendingOperation(ledger)) {
      throw new Error(`migrate: project ${projectId} has a pending ledger operation`);
    }
  }
  const initial = normalizeLegacyState(source, detected.form);
  validateStateInvariants(initial, "ledger.migrate.legacy-source", { requireRevision: true });
  const migrated = await migrateLegacyInitialUnderLock(lockContext, initial, rawState, { ...opts, projectId });
  return {
    project_id: projectId,
    ...detectMigrationState(migrated, { hasLedger: true }),
    migrated: true,
  };
}

/** Import pre-fenced forms through the durable initial bootstrap protocol. */
export async function migrateOldProjectUnderLock(lockContext, projectId, opts = {}) {
  assertActiveLockContext(lockContext);
  const { projectDir, statePath } = getActiveLockContext(lockContext);
  const rawStateFile = await optionalJson(statePath, "state");
  const ledgerFile = await optionalJson(ledgerPath(statePath), "revision ledger");
  const source = rawStateFile.raw === null ? null : readJson(rawStateFile.raw, "state");
  const ledger = ledgerFile.raw === null ? null : readJson(ledgerFile.raw, "revision ledger");

  if (ledger?.migration_pending) {
    const error = new Error(`migrate: project ${projectId} has legacy migration_pending; resolve it with the pre-cut binary or recreate explicitly`);
    error.code = "CLIMIER_OLD_MIGRATION_PENDING";
    throw error;
  }
  // Save the whole project before either resuming a publication or creating a
  // new stage. This preserves an existing stage/pending exactly as found.
  await backupProject(projectId, projectDir);

  if (ledger?.bootstrap_pending) {
    assertValidLedger(ledger);
    const state = await finishPendingBootstrap({ statePath, ledgerPath: ledgerPath(statePath), ledger, opts });
    return {
      project_id: projectId,
      ...detectMigrationState(state, { hasLedger: true }),
      migrated: true,
      resumed: true,
    };
  }
  if (source === null) {
    const empty = { version: STATE_SCHEMA_VERSION, nodes: {}, edges: [], initiatives: {}, log: [], revision: 0 };
    const state = await migrateLegacyInitialUnderLock(lockContext, empty, null, { ...opts, projectId });
    return { project_id: projectId, ...detectMigrationState(state, { hasLedger: true }), migrated: true };
  }
  return migrateParsedOldProjectUnderLock(lockContext, projectId, rawStateFile.raw, source, ledger, opts);
}


export async function migrateFencedProjectUnderLock(lockContext, projectId, opts = {}) {
  assertActiveLockContext(lockContext);
  const { statePath } = getActiveLockContext(lockContext);
  const sourceRaw = await fs.readFile(statePath, "utf8");
  const source = readJson(sourceRaw, "state");
  const rawLedger = await fs.readFile(ledgerPath(statePath), "utf8");
  const ledger = readJson(rawLedger, "revision ledger");
  if (ledger.migration_pending) {
    const error = new Error(`migrate: project ${projectId} has legacy migration_pending; resolve it with the pre-cut binary or recreate explicitly`);
    error.code = "CLIMIER_OLD_MIGRATION_PENDING";
    throw error;
  }
  assertValidLedger(ledger);
  if (hasPendingOperation(ledger)) {
    const error = new Error(`migrate: project ${projectId} has a pending ledger operation`);
    error.code = "CLIMIER_LEDGER_PENDING_OPERATION";
    throw error;
  }

  const detection = detectMigrationState(source, { hasLedger: true });
  if (detection.error) throw new Error(`migrate: project ${projectId}: ${detection.error}`);
  if (detection.form === "canonical") {
    return { project_id: projectId, ...detection };
  }
  if (detection.form !== "fenced-legacy") {
    throw new Error(`migrate: project ${projectId} has unsupported form ${detection.form}`);
  }

  assertFencedMigrationSource(source, ledger);
  await backupProject(projectId, getActiveLockContext(lockContext).projectDir);

  const candidate = {
    ...source,
    version: 1,
    revision: source.revision + 1,
    log: [...source.log, {
      ts: new Date().toISOString(),
      action: "migrate",
      agent: "migrate",
      from_version: 5,
      to_version: 1,
    }],
  };
  validateStateInvariants(candidate, "ledger.migrate.candidate");
  for (const [id, node] of Object.entries(source.nodes)) {
    if (candidate.nodes[id]?.revision !== node.revision) {
      throw new Error(`migrate: project ${projectId} schema transition changed node ${id} revision`);
    }
  }

  const committed = await commitFencedStateUnderLock(lockContext, candidate, opts);
  return {
    project_id: projectId,
    ...detectMigrationState(committed, { hasLedger: true }),
    migrated: true,
  };
}


export async function migrateProjectUnderLock(lockContext, projectId, opts = {}) {
  assertActiveLockContext(lockContext);
  const { statePath } = getActiveLockContext(lockContext);
  const rawState = await optionalJson(statePath, "state");
  if (rawState.raw === null) {
    return migrateOldProjectUnderLock(lockContext, projectId, opts);
  }
  const state = readJson(rawState.raw, "state");
  const rawLedger = await optionalJson(ledgerPath(statePath), "revision ledger");
  const ledger = rawLedger.raw === null ? null : readJson(rawLedger.raw, "revision ledger");
  if (ledger?.migration_pending) {
    const error = new Error(`migrate: project ${projectId} has legacy migration_pending; resolve it with the pre-cut binary or recreate explicitly`);
    error.code = "CLIMIER_OLD_MIGRATION_PENDING";
    throw error;
  }
  const detection = detectMigrationState(state, { hasLedger: Boolean(ledger) });
  if (ledger?.bootstrap_pending || ["pre-release", "legacy-v2", "legacy-v3", "legacy-v4"].includes(detection.form)) {
    return migrateOldProjectUnderLock(lockContext, projectId, opts);
  }
  if (detection.form === "fenced-legacy" || detection.form === "canonical") {
    return migrateFencedProjectUnderLock(lockContext, projectId, opts);
  }
  if (detection.error) throw new Error(`migrate: project ${projectId}: ${detection.error}`);
  throw new Error(`migrate: project ${projectId} has unsupported form ${detection.form}`);
}
