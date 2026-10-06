// state.mjs: read/write/atomic-mutate the tasks.json state file.
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { withLock, assertActiveLockContext, getActiveLockContext } from "./lock.ts";
import { climierHome, projectMetaFile } from "./paths.ts";
import { validateStateInvariants } from "../contracts/state-invariants.ts";

function readProjectMetaSync(projectDir) {
  const file = projectMetaFile(projectDir);
  if (!fsSync.existsSync(file)) { return null; }
  let meta;
  try {
    meta = JSON.parse(fsSync.readFileSync(file, "utf8"));
  } catch (err) {
    const wrapped = new Error(`state: project metadata at ${file} is corrupt or not valid JSON: ${err.message}`);
    wrapped.code = "CLIMIER_CORRUPT_PROJECT_META";
    wrapped.cause = err;
    throw wrapped;
  }
  if (!meta || typeof meta !== "object" || typeof meta.project_id !== "string" || !meta.project_id.trim()) { throw new Error(`state: project metadata at ${file} is invalid (missing non-empty 'project_id')`); }
  return meta;
}

function globalStateFile(projectId) {
  return path.join(climierHome(), "projects", projectId, "tasks.json");
}

function defaultProjectId(projectDir) {
  return crypto.createHash("sha1").update(path.resolve(projectDir)).digest("hex").slice(0, 16);
}

export function stateFile(projectDir) {
  const meta = readProjectMetaSync(projectDir);
  return globalStateFile(meta?.project_id || defaultProjectId(projectDir));
}

/** State path for a project known only by its id (the storage dir name). */
export function stateFileForProjectId(projectId) {
  return globalStateFile(projectId);
}

/** Project ids with a state or a ledger in the project storage root, sorted. */
export async function listProjectIds() {
  const projectsDir = path.join(climierHome(), "projects");
  let entries;
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") { return []; }
    throw error;
  }
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) { continue; }
    const dir = path.join(projectsDir, entry.name);
    if (await hasAny(path.join(dir, "tasks.json"), path.join(dir, "revision-ledger.json"))) {
      ids.push(entry.name);
    }
  }
  return ids.toSorted();
}

async function hasAny(...files) {
  for (const file of files) {
    try {
      await fs.access(file);
      return true;
    } catch (error) {
      if (error.code !== "ENOENT") { throw error; }
    }
  }
  return false;
}

export async function ensureProjectMeta(projectDir) {
  const existing = readProjectMetaSync(projectDir);
  if (existing) { return existing; }
  const file = projectMetaFile(projectDir);
  const meta = {
    version: 1,
    project_id: defaultProjectId(projectDir),
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(meta, null, 2) + "\n", "utf8");
  return meta;
}

export const STATE_SCHEMA_VERSION = 1;
const CLASSIFIABLE_NONCANONICAL_VERSIONS = new Set([2, 3, 4, 5]);
const FENCED_LEGACY_VERSION = 5;

export function isFencedStateVersion(version) {
  return version === STATE_SCHEMA_VERSION;
}

export function isFencedState(state) {
  return isFencedStateVersion(state?.version);
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
    if (!Object.prototype.hasOwnProperty.call(state, "nodes")
        && ["tasks", "decisions", "gotchas"].some((field) => Object.prototype.hasOwnProperty.call(state, field))) {
      return { kind: "pre-release" };
    }
    const missing = ["nodes", "edges", "initiatives", "log"].filter((field) => !Object.prototype.hasOwnProperty.call(state, field));
    if (missing.length > 0) { return { kind: "incomplete", missing }; }
    if (!Number.isInteger(state.fence_generation)) { return { kind: "noncanonical", reason: "fence_generation is missing or invalid" }; }
    return { kind: "canonical" };
  }
  if (state.version === FENCED_LEGACY_VERSION) { return { kind: "fenced-legacy" }; }
  return { kind: "legacy" };
}

export function emptyState() {
  return {
    version: STATE_SCHEMA_VERSION,
    fence_generation: 1,
    nodes: {},
    edges: [],
    initiatives: {},
    log: [],
    revision: 0,
  };
}

const READABLE_STATE_KINDS = new Set(["canonical"]);


// for migrate detection, but never grants those forms read acceptance.
export function assertReadableState(state, commandName) {
  if (!state) { return; }
  const shape = classifyStateShape(state);
  if (READABLE_STATE_KINDS.has(shape.kind)) { return; }
  const error = new Error(`${commandName}: state is not readable (${shape.kind})`);
  error.code = "CLIMIER_STATE_NOT_READABLE";
  error.details = { kind: shape.kind, version: state.version };
  throw error;
}

async function readMissingState(projectDir) {
  const { ledgerFile, readFencedState } = await import("./ledger.ts");
  try { await fs.access(ledgerFile(projectDir)); }
  catch (error) { if (error.code === "ENOENT") { return null; } throw error; }
  return readFencedState(projectDir);
}

function stateShapeError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

async function parseStateFile(projectDir, file, raw) {
  const state = JSON.parse(raw);
  const shape = classifyStateShape(state);
  if (shape.kind === "invalid") {
    throw stateShapeError("CLIMIER_INVALID_STATE_FORMAT", `state: file at ${file} is not a JSON object`, { file });
  }
  if (shape.kind === "pre-release") {
    throw stateShapeError("PRE_RELEASE_STATE_UNSUPPORTED", `state: pre-release state at ${file} has tasks/decisions/gotchas without nodes; run climier migrate`, {
      file, version: state.version, hint: "Run climier migrate to import this pre-release state.",
    });
  }
  if (shape.kind === "legacy" || shape.kind === "fenced-legacy") {
    throw stateShapeError("CLIMIER_INCOMPATIBLE_VERSION", `state: file at ${file} is not a canonical version ${STATE_SCHEMA_VERSION} state; run climier migrate`, {
      file, version: state.version, hint: "Run climier migrate to import this state.",
    });
  }
  if (shape.kind === "incompatible") { rejectFutureWritableVersion(state, file); }
  if (shape.kind === "incomplete") {
    throw stateShapeError("CLIMIER_INCOMPLETE_STATE", `state: canonical version 1 file at ${file} is incomplete (missing ${shape.missing.join(", ")})`, {
      file, missing: shape.missing,
    });
  }
  if (shape.kind === "noncanonical") {
    throw stateShapeError("CLIMIER_NONCANONICAL_STATE", `state: version 1 file at ${file} is not canonical (${shape.reason}); run climier migrate`, {
      file, version: STATE_SCHEMA_VERSION, reason: shape.reason, hint: "Run climier migrate to create a canonical state.",
    });
  }
  if (shape.kind === "canonical") {
    const { ledgerFile, readFencedState } = await import("./ledger.ts");
    try { await fs.access(ledgerFile(projectDir)); }
    catch (error) {
      if (error.code === "ENOENT") {
        throw stateShapeError("CLIMIER_NONCANONICAL_STATE", `state: version 1 file at ${file} is not canonical (revision-ledger.json is missing); run climier migrate`, {
          file, version: STATE_SCHEMA_VERSION, reason: "revision-ledger.json is missing", hint: "Run climier migrate to create a canonical state.",
        });
      }
      throw error;
    }
    return readFencedState(projectDir);
  }
  throw stateShapeError("CLIMIER_INCOMPATIBLE_VERSION", `state: file at ${file} is not a canonical version ${STATE_SCHEMA_VERSION} state; run climier migrate`, { file, version: state.version, hint: "Run climier migrate to import this state." });
}

export async function readState(projectDir) {
  const file = stateFile(projectDir);
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") { return readMissingState(projectDir); }
    throw error;
  }
  try {
    return await parseStateFile(projectDir, file, raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      const wrapped = new Error(`state: file at ${file} is corrupt or not valid JSON: ${error.message}`);
      wrapped.code = "CLIMIER_CORRUPT_STATE";
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
}

function ledgerRequired(message) {
  const error = new Error(message);
  error.code = "CLIMIER_LEDGER_REQUIRED";
  return error;
}

function hasFenceMarker(state) {
  return state?.version === FENCED_LEGACY_VERSION || Number.isInteger(state?.fence_generation);
}

async function assertUnledgeredWriteAllowed(lockContext, projectDir, targetState) {
  assertActiveLockContext(lockContext, projectDir);
  const { statePath } = getActiveLockContext(lockContext);
  const ledgerPath = path.join(path.dirname(statePath), "revision-ledger.json");
  try {
    await fs.access(ledgerPath);
    throw ledgerRequired("state: revision-ledger projects require the fenced ledger commit API");
  } catch (error) {
    if (error.code !== "ENOENT") { throw error; }
  }

  let existing;
  try {
    existing = JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) { throw error; } }
  if (hasFenceMarker(existing) || hasFenceMarker(targetState)) { throw ledgerRequired("state: canonical states require the revision ledger commit API"); }
}

function rejectUnsupportedWriteVersion(state, file) {
  if (state?.version === STATE_SCHEMA_VERSION) {
    if (classifyStateShape(state).kind === "pre-release") {
      throw stateShapeError("PRE_RELEASE_STATE_UNSUPPORTED", `state: ${file} holds a pre-canonical state (tasks/decisions/gotchas without nodes); run climier migrate`, {
        file, hint: "Run climier migrate to import this state.",
      });
    }
    throw ledgerRequired("state: canonical states require the revision ledger commit API");
  }
  if (!Number.isInteger(state?.version) || (state.version > STATE_SCHEMA_VERSION && !CLASSIFIABLE_NONCANONICAL_VERSIONS.has(state.version))) { rejectFutureWritableVersion(state, file); }
}

async function readStateForUpdate(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") { throw error; }
    return { version: STATE_SCHEMA_VERSION, nodes: {}, edges: [], initiatives: {}, log: [], revision: 0 };
  }
}

function rejectFutureWritableVersion(state, file) {
  const error = new Error(`state: file at ${file} has version ${state?.version} but this climier only understands schema version ${STATE_SCHEMA_VERSION}; run climier migrate`);
  error.code = "CLIMIER_INCOMPATIBLE_VERSION";
  throw error;
}

function assertWritableStateVersion(state, file) {
  if (!state || typeof state !== "object") { return; }
  if (state.version === STATE_SCHEMA_VERSION) { throw new Error("state.update: version 1 state requires the canonical ledger write API"); }
  if (state.version > STATE_SCHEMA_VERSION && !CLASSIFIABLE_NONCANONICAL_VERSIONS.has(state.version)) { rejectFutureWritableVersion(state, file); }
  if (!Number.isInteger(state.version)) { rejectFutureWritableVersion(state, file); }
  if (CLASSIFIABLE_NONCANONICAL_VERSIONS.has(state.version)) {
    throw stateShapeError("CLIMIER_INCOMPATIBLE_VERSION", `state: file at ${file} has legacy version ${state.version}; run climier migrate`, {
      file, version: state.version, hint: "Run climier migrate to import this state.",
    });
  }
}

async function persistUpdatedState(file, lockContext, projectDir, state) {
  await assertUnledgeredWriteAllowed(lockContext, projectDir, state);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

async function updateStateUnderLock(projectDir, lockContext, mutator) {
  const file = stateFile(projectDir);
  await assertUnledgeredWriteAllowed(lockContext, projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let state = await readStateForUpdate(file);
  assertWritableStateVersion(state, file);
  state = { ...state, version: 4, revision: Number.isInteger(state.revision) ? state.revision : 0 };
  if (state && typeof state === "object") { validateStateInvariants(state, "state.update"); }
  const next = mutator({ ...state });
  if (next === undefined) { throw new Error("updateState mutator must return the new state object"); }
  await persistUpdatedState(file, lockContext, projectDir, next);
  return next;
}

export async function updateState(projectDir, mutator) {
  return withLock(projectDir, (lockContext) => updateStateUnderLock(projectDir, lockContext, mutator));
}

const VALID_SNAPSHOT_REASONS = new Set(["force-init", "corrupt-recovery", "pre-restore"]);

function snapshotDir(projectDir) {
  return path.join(path.dirname(stateFile(projectDir)), "snapshots");
}

export { snapshotDir };

function buildSnapshotId(reason) {

  const iso = new Date().toISOString();
  const ts = iso.replace(/[-:.]/g, "");
  const random = crypto.randomBytes(4).toString("hex");
  return `${ts}-${reason}-${random}`;
}

async function tryChmod(target, mode) {
  // Best-effort: chmod is a no-op on Windows beyond the read-only bit
  // and can fail with EPERM/ENOTSUP on locked-down filesystems. The
  // primitive contract is "do not throw on permission errors".
  try {
    await fs.chmod(target, mode);
  } catch {

  }
}

async function writeSnapshotPair(raw, metadata, dir) {
  const finalRawPath = path.join(dir, `${metadata.id}.json`);
  const finalMetaPath = path.join(dir, `${metadata.id}.meta.json`);
  const tmpRawPath = `${finalRawPath}.tmp-${process.pid}-${Date.now()}`;
  const tmpMetaPath = `${finalMetaPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpRawPath, raw);
  await tryChmod(tmpRawPath, 0o600);
  await fs.writeFile(tmpMetaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await tryChmod(tmpMetaPath, 0o600);
  await fs.rename(tmpRawPath, finalRawPath);
  await fs.rename(tmpMetaPath, finalMetaPath);
}

export async function createSnapshot(projectDir, reason) {
  if (!VALID_SNAPSHOT_REASONS.has(reason)) { throw new Error(`createSnapshot: invalid reason '${reason}' (allowed: ${[...VALID_SNAPSHOT_REASONS].join(", ")})`); }
  const statePath = stateFile(projectDir);

  const raw = await fs.readFile(statePath);
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
  try {
    await fs.access(path.join(dir, `${id}.json`));
  } catch {
    return null;
  }
  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(path.join(dir, `${id}.meta.json`), "utf8"));
  } catch {
    return null;
  }
  return metadata && typeof metadata === "object" && metadata.id === id ? metadata : null;
}

function newestFirst(first, second) {
  if (first.id < second.id) { return 1; }
  return first.id > second.id ? -1 : 0;
}

export async function listSnapshots(projectDir) {
  const dir = snapshotDir(projectDir);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") { return []; }
    throw error;
  }
  const result = [];
  for (const name of entries) {
    // Only complete snapshot pairs with matching metadata ids are surfaced.
    const metadata = await readSnapshotMetadata(dir, name);
    if (metadata) { result.push(metadata); }
  }
  // Timestamp-prefixed ids sort in creation order, newest first.
  return result.toSorted(newestFirst);
}

async function writeStateUnderLock(projectDir, lockContext, state) {
  if (!state || typeof state !== "object") { throw new Error("writeState: invalid state (not an object)"); }
  await assertUnledgeredWriteAllowed(lockContext, projectDir, state);
  rejectUnsupportedWriteVersion(state, stateFile(projectDir));
  state = { ...state, version: 4, revision: Number.isInteger(state.revision) ? state.revision : 0 };
  if (state.version !== 4) { throw new Error(`writeState: invalid state (version ${state.version} is not supported; expected version 4)`); }
  validateStateInvariants(state, "writeState");
  for (const key of ["nodes", "edges", "initiatives", "log"]) {
    if (!(key in state)) { throw new Error(`writeState: invalid state (missing '${key}' collection)`); }
  }
  const file = stateFile(projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

export async function writeState(projectDir, state) {
  return withLock(projectDir, (lockContext) => writeStateUnderLock(projectDir, lockContext, state));
}

// Validate initiative registration to prevent typo-driven orphans. This pure
// state helper is the single enforcement point; callers pass their snapshot.
export function assertInitiativeRegistered(state, name, commandName) {
  if (name === true) { throw new Error(`${commandName}: --initiative requires a value`); }
  if (
    state &&
    state.initiatives &&
    Object.prototype.hasOwnProperty.call(state.initiatives, name)
  ) {
    return;
  }
  const valid =
    state && state.initiatives ? Object.keys(state.initiatives).toSorted() : [];
  const hint =
    valid.length > 0
      ? `valid initiatives: ${valid.join(", ")}`
      : `no initiatives registered; run \`climier add-initiative <name> --desc "..."\` first`;
  throw new Error(`${commandName}: --initiative '${name}' is not registered (${hint})`);
}

export { readProjectMetaSync };
