import { asCaughtError } from "../contracts/errors.ts";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { climierHome, projectMetaFile, sqliteStateFileForProjectId } from "./paths.ts";
import { validateStateInvariants } from "../contracts/state-invariants.ts";
import { normalizeProjectName } from "../contracts/project-name.ts";
import type { ProjectState } from "../contracts/domain.ts";

const STATE_RECOVERY_HINT = "Preserve the project files; restore a verified backup or contact the maintainer.";

function readProjectMetaSync(projectDir) {
  const file = projectMetaFile(projectDir);
  if (!fsSync.existsSync(file)) { return null; }
  let meta;
  try {
    meta = JSON.parse(fsSync.readFileSync(file, "utf8"));
  } catch (rawCaughtValue: unknown) {
    const err = asCaughtError(rawCaughtValue);
    const wrapped = new Error(`state: project metadata at ${file} is corrupt or not valid JSON: ${err.message}`);
    wrapped.code = "CLIMIER_CORRUPT_PROJECT_META";
    wrapped.cause = err;
    throw wrapped;
  }
  if (!meta || typeof meta !== "object" || typeof meta.project_id !== "string" || !meta.project_id.trim()) {
    throw new Error(`state: project metadata at ${file} is invalid (missing non-empty 'project_id')`);
  }
  return meta;
}

function defaultProjectId(projectDir) {
  return crypto.createHash("sha1").update(path.resolve(projectDir)).digest("hex").slice(0, 16);
}

function projectId(projectDir) {
  return readProjectMetaSync(projectDir)?.project_id || defaultProjectId(projectDir);
}

/** Canonical runtime state is stored only in this SQLite database. */
export function stateFile(projectDir) {
  return sqliteStateFileForProjectId(projectId(projectDir));
}

export function stateFileForProjectId(id: string) {
  return sqliteStateFileForProjectId(id);
}

export function sqliteStateFile(projectDir) {
  return stateFile(projectDir);
}

/** Legacy schema-1 JSON source, accessed only by the explicit migration codec. */
export function jsonStateFile(projectDir) {
  return path.join(climierHome(), "projects", projectId(projectDir), "tasks.json");
}

/** Project ids with canonical SQLite state, sorted. */
export async function listProjectIds() {
  const projectsDir = path.join(climierHome(), "projects");
  let entries;
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch (rawCaughtValue: unknown) {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") { return []; }
    throw error;
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) { continue; }
    try {
      await fs.access(path.join(projectsDir, entry.name, "state.sqlite"));
      ids.push(entry.name);
    } catch (rawCaughtValue: unknown) {
      const error = asCaughtError(rawCaughtValue);
      if (error.code !== "ENOENT") { throw error; }
    }
  }
  return ids.sort();
}

function defaultProjectName(projectDir) {
  const base = path.basename(path.resolve(projectDir));
  return normalizeProjectName(base) ?? defaultProjectId(projectDir);
}

async function writeProjectMetaFile(projectDir, meta) {
  const file = projectMetaFile(projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(meta, null, 2) + "\n", "utf8");
}

/** Path of the local display-name sidecar kept beside a project's state. */
export function projectNameFile(id: string) {
  return path.join(climierHome(), "projects", id, "project.json");
}

/** Read the stored display name for a project id; null when unset or unreadable. */
export async function readProjectName(id: string) {
  if (typeof id !== "string" || !id.trim()) { return null; }
  let raw;
  try {
    raw = await fs.readFile(projectNameFile(id), "utf8");
  } catch (rawCaughtValue: unknown) {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") { return null; }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.project_id !== id) { return null; }
    return normalizeProjectName(parsed.name);
  } catch {
    return null;
  }
}

/** Persist a project's display name beside its state, atomically. */
export async function writeProjectName(id: string, name: string) {
  const normalized = normalizeProjectName(name);
  if (!normalized) { throw new Error("state: project name must be a non-empty string"); }
  const file = projectNameFile(id);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  await fs.writeFile(temporary, JSON.stringify({ version: 1, project_id: id, name: normalized }, null, 2) + "\n", "utf8");
  await fs.rename(temporary, file);
}

async function ensureStoredProjectName(id, name) {
  if (await readProjectName(id) === name) { return; }
  await writeProjectName(id, name);
}

export async function ensureProjectMeta(projectDir) {
  const existing = readProjectMetaSync(projectDir);
  if (existing) {
    const name = normalizeProjectName(existing.name) ?? defaultProjectName(projectDir);
    await ensureStoredProjectName(existing.project_id, name);
    return existing;
  }
  const meta = { version: 1, project_id: defaultProjectId(projectDir) };
  await writeProjectMetaFile(projectDir, meta);
  await ensureStoredProjectName(meta.project_id, defaultProjectName(projectDir));
  return meta;
}

/** Record an explicit display name into the repo metadata and the state sidecar. */
export async function setProjectMetaName(projectDir, name) {
  const existing = readProjectMetaSync(projectDir);
  if (!existing) {
    throw new Error(`state: project metadata at ${projectMetaFile(projectDir)} is missing; run climier init first`);
  }
  const normalized = normalizeProjectName(name);
  if (!normalized) { throw new Error("state: project name must be a non-empty string"); }
  await writeProjectMetaFile(projectDir, { ...existing, name: normalized });
  await ensureStoredProjectName(existing.project_id, normalized);
  return { ...existing, name: normalized };
}

/** Backfill the display name for projects created before names existed. */
export async function syncProjectDisplayName(projectDir, projectConfig) {
  const id = typeof projectConfig?.project_id === "string" ? projectConfig.project_id.trim() : "";
  if (!id) { return null; }
  const name = normalizeProjectName(projectConfig.name) ?? defaultProjectName(projectDir);
  await ensureStoredProjectName(id, name);
  return name;
}

export const STATE_SCHEMA_VERSION = 1;
const CLASSIFIABLE_NONCANONICAL_VERSIONS = new Set([2, 3, 4, 5]);

export function isCanonicalStateVersion(version) {
  return version === STATE_SCHEMA_VERSION;
}

export function classifyStateShape(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) { return { kind: "invalid" }; }
  if (!Object.prototype.hasOwnProperty.call(state, "nodes")
      && ["tasks", "decisions", "gotchas"].some((field) => Object.prototype.hasOwnProperty.call(state, field))) {
    return { kind: "pre-release" };
  }
  if (!Number.isInteger(state.version)
      || (state.version > STATE_SCHEMA_VERSION && !CLASSIFIABLE_NONCANONICAL_VERSIONS.has(state.version))) {
    return { kind: "incompatible" };
  }
  if (state.version === STATE_SCHEMA_VERSION) {
    const missing = ["nodes", "edges", "initiatives", "log"].filter((field) => !Object.prototype.hasOwnProperty.call(state, field));
    return missing.length > 0 ? { kind: "incomplete", missing } : { kind: "canonical" };
  }
  return { kind: "legacy" };
}

export function emptyState(): ProjectState {
  return { version: STATE_SCHEMA_VERSION, nodes: {}, edges: [], initiatives: {}, log: [], revision: 0 };
}

export function assertReadableState(state, commandName) {
  if (!state) { return; }
  const shape = classifyStateShape(state);
  if (shape.kind === "canonical") { return; }
  const error = new Error(`${commandName}: state is not readable (${shape.kind})`);
  error.code = "CLIMIER_STATE_NOT_READABLE";
  error.details = { kind: shape.kind, version: state.version };
  throw error;
}

function stateShapeError(code, message, details?: Record<string, unknown>) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

/** Decode the legacy schema-1 JSON file for the explicit migrate command only. */
export async function readJsonStateForMigration(projectDir: string) {
  const file = jsonStateFile(projectDir);
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (rawCaughtValue: unknown) {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") { return null; }
    throw error;
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (cause) {
    const error = stateShapeError("CLIMIER_CORRUPT_STATE", `state migrate: file at ${file} is corrupt or not valid JSON`, { file });
    error.cause = cause;
    throw error;
  }
  const shape = classifyStateShape(state);
  if (shape.kind !== "canonical") {
    throw stateShapeError(
      "CLIMIER_NONCANONICAL_STATE",
      `state migrate: file at ${file} is not a complete schema-1 state (${shape.kind}); ${STATE_RECOVERY_HINT}`,
      { file, shape: shape.kind, hint: STATE_RECOVERY_HINT },
    );
  }
  validateStateInvariants(state, "state migrate");
  const { fence_generation: _retiredFence, ...canonicalState } = state;
  return canonicalState;
}

async function assertExplicitMigrationRequiredForFile(file: string) {
  try {
    await fs.access(file);
  } catch (rawCaughtValue: unknown) {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") { return; }
    throw error;
  }
  const error = new Error(`SQLite state is missing but legacy JSON exists at ${file}; run \`climier state migrate --as <agent> --yes\` first`);
  error.code = "CLIMIER_SQLITE_MIGRATION_REQUIRED";
  error.details = { file, command: "climier state migrate" };
  throw error;
}

async function assertExplicitMigrationRequired(projectDir) {
  return assertExplicitMigrationRequiredForFile(jsonStateFile(projectDir));
}

export async function sqliteStateExists(projectDir: string) {
  const { readSqliteHasState } = await import("./sqlite/store.ts");
  const exists = await readSqliteHasState(stateFile(projectDir));
  if (!exists) { await assertExplicitMigrationRequired(projectDir); }
  return exists;
}

export async function readState(projectDir, options: { includeBodies?: boolean; includeLog?: boolean } = {}) {
  const { readSqliteState } = await import("./sqlite/store.ts");
  const state = await readSqliteState(stateFile(projectDir), options);
  if (state === null) { await assertExplicitMigrationRequired(projectDir); }
  return state;
}

export async function readStateByProjectId(id: string, options: { includeBodies?: boolean } = {}) {
  const { readSqliteState } = await import("./sqlite/store.ts");
  const state = await readSqliteState(stateFileForProjectId(id), options);
  if (state === null) { await assertExplicitMigrationRequiredForFile(path.join(climierHome(), "projects", id, "tasks.json")); }
  return state;
}

export async function updateState(projectDir, mutator) {
  const { readSqliteState, updateSqliteState, withSqliteTransaction } = await import("./sqlite/store.ts");
  const file = stateFile(projectDir);
  return withSqliteTransaction(file, async () => {
    if (await readSqliteState(file) === null) { await assertExplicitMigrationRequired(projectDir); }
    return updateSqliteState(file, mutator);
  });
}

const VALID_SNAPSHOT_REASONS = new Set(["force-init", "corrupt-recovery", "pre-restore"]);

export function snapshotDir(projectDir) {
  return path.join(path.dirname(stateFile(projectDir)), "snapshots");
}

function buildSnapshotId(reason) {
  const ts = new Date().toISOString().replace(/[-:.]/g, "");
  return `${ts}-${reason}-${crypto.randomBytes(4).toString("hex")}`;
}

async function tryChmod(target, mode) {
  try { await fs.chmod(target, mode); } catch {}
}

async function writeSnapshotPair(raw, metadata, dir) {
  const finalRawPath = path.join(dir, `${metadata.id}.json`);
  const finalMetaPath = path.join(dir, `${metadata.id}.meta.json`);
  const suffix = `${process.pid}-${Date.now()}`;
  const tmpRawPath = `${finalRawPath}.tmp-${suffix}`;
  const tmpMetaPath = `${finalMetaPath}.tmp-${suffix}`;
  await fs.writeFile(tmpRawPath, raw);
  await tryChmod(tmpRawPath, 0o600);
  await fs.writeFile(tmpMetaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await tryChmod(tmpMetaPath, 0o600);
  await fs.rename(tmpRawPath, finalRawPath);
  await fs.rename(tmpMetaPath, finalMetaPath);
}

export async function createSnapshot(projectDir, reason) {
  if (!VALID_SNAPSHOT_REASONS.has(reason)) { throw new Error(`createSnapshot: invalid reason '${reason}' (allowed: ${[...VALID_SNAPSHOT_REASONS].join(", ")})`); }
  const state = await readState(projectDir);
  if (!state) { throw new Error("createSnapshot: cannot snapshot a missing state"); }
  const raw = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
  const dir = snapshotDir(projectDir);
  await fs.mkdir(dir, { recursive: true });
  await tryChmod(dir, 0o700);
  const metadata = {
    id: buildSnapshotId(reason),
    created_at: new Date().toISOString(),
    reason,
    bytes: raw.length,
    sha256: crypto.createHash("sha256").update(raw).digest("hex"),
  };
  await writeSnapshotPair(raw, metadata, dir);
  return metadata;
}

async function readSnapshotMetadata(dir, name) {
  if (!name.endsWith(".meta.json")) { return null; }
  const id = name.slice(0, -".meta.json".length);
  try { await fs.access(path.join(dir, `${id}.json`)); } catch { return null; }
  let metadata;
  try { metadata = JSON.parse(await fs.readFile(path.join(dir, `${id}.meta.json`), "utf8")); } catch { return null; }
  return metadata && typeof metadata === "object" && metadata.id === id ? metadata : null;
}

export async function listSnapshots(projectDir) {
  const dir = snapshotDir(projectDir);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (rawCaughtValue: unknown) {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") { return []; }
    throw error;
  }
  const result: Array<Record<string, unknown>> = [];
  for (const name of entries) {
    const metadata = await readSnapshotMetadata(dir, name);
    if (metadata) { result.push(metadata); }
  }
  return result.sort((first, second) => String(first.id) < String(second.id) ? 1 : String(first.id) > String(second.id) ? -1 : 0);
}

export async function writeState(projectDir, state) {
  const { readSqliteState, writeSqliteState, withSqliteTransaction } = await import("./sqlite/store.ts");
  const file = stateFile(projectDir);
  return withSqliteTransaction(file, async () => {
    if (await readSqliteState(file) === null) { await assertExplicitMigrationRequired(projectDir); }
    return writeSqliteState(file, state);
  });
}

export function assertInitiativeRegistered(state, name, commandName) {
  if (name === true) { throw new Error(`${commandName}: --initiative requires a value`); }
  if (state?.initiatives && Object.prototype.hasOwnProperty.call(state.initiatives, name)) { return; }
  const valid = state?.initiatives ? Object.keys(state.initiatives).sort() : [];
  const hint = valid.length > 0
    ? `valid initiatives: ${valid.join(", ")}`
    : `no initiatives registered; run \`climier add-initiative <name> --desc "..."\` first`;
  throw new Error(`${commandName}: --initiative '${name}' is not registered (${hint})`);
}

export { readProjectMetaSync };
