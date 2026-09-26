// state.mjs: read/write/atomic-mutate the tasks.json state file.
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { withLock, assertActiveLockContext, getActiveLockContext } from "./lock.mjs";
import { climierHome, projectMetaFile } from "./paths.mjs";
import { validateStateInvariants } from "../contracts/state-invariants.mjs";

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

const CURRENT_STATE_VERSION = 4;
const FENCED_STATE_VERSION = 5;
const LEGACY_STATE_VERSION = 2;
const PREVIOUS_STATE_VERSION = 3;

export { FENCED_STATE_VERSION };

export function isFencedState(state) {
  return state?.version === FENCED_STATE_VERSION;
}

// Upgrade legacy-compatible state without changing the input object.
export function migrateState(state) {
  if (state && (state.version === LEGACY_STATE_VERSION || state.version === PREVIOUS_STATE_VERSION)) { return { ...state, version: CURRENT_STATE_VERSION, revision: 0 }; }
  return state;
}

export function emptyState() {
  return {
    version: CURRENT_STATE_VERSION,
    nodes: {},
    edges: [],
    initiatives: {},
    log: [],
    revision: 0,
  };
}

export function isV2State(state) {
  return [LEGACY_STATE_VERSION, PREVIOUS_STATE_VERSION, CURRENT_STATE_VERSION].includes(state?.version);
}

export function isV3State(state) {
  return [PREVIOUS_STATE_VERSION, CURRENT_STATE_VERSION].includes(state?.version);
}

export function assertStateVersion(state, version, commandName) {
  if (!state) { return; }
  if (state.version === version || (version === LEGACY_STATE_VERSION && state.version === CURRENT_STATE_VERSION)) { return; }
  throw new Error(`${commandName}: state version ${state.version} is not supported by this command (expected version ${version})`);
}

async function readMissingState(projectDir) {
  const { ledgerFile, readFencedState } = await import("./ledger.mjs");
  try { await fs.access(ledgerFile(projectDir)); }
  catch (error) { if (error.code === "ENOENT") { return null; } throw error; }
  return readFencedState(projectDir);
}

function rejectLegacyV1State(state, file) {
  if (!state || typeof state !== "object" || state.version !== 1) { return; }
  const migrationSteps = [
    "1. Backup the existing tasks.json file.",
    "2. Export any nodes you want to keep (the v1 schema uses tasks/decisions/gotchas; recreate them with add-task/add-gate/add-knowledge).",
    "3. Run `climier init --force` to recreate the project state in v3.",
    "4. Recreate each node with add-initiative / add-task / add-gate / add-knowledge (see `climier --help` for the v3 surface).",
  ];
  const wrapped = new Error(
    `state: file at ${file} has version 1; this version of climier no longer supports the v1 schema. ` +
    `To migrate, follow these steps:\n${migrationSteps.join("\n")}`,
  );
  wrapped.code = "STATE_V1_UNSUPPORTED";
  wrapped.details = {
    file,
    version: 1,
    migration_steps: migrationSteps,
    hint: "Run `climier init --force` to overwrite the v1 state with a fresh v3 state (this will erase the v1 data).",
  };
  throw wrapped;
}

function rejectMalformedFencedState(state, file) {
  if (state && typeof state === "object" && state.version === FENCED_STATE_VERSION
      && !Number.isInteger(state.fence_generation)) {
    const error = new Error(`state: file at ${file} has version ${state.version} but this climier requires a fenced state`);
    error.code = "CLIMIER_INCOMPATIBLE_VERSION";
    throw error;
  }
}

async function readLedgerState(projectDir, state) {
  const { ledgerFile, readFencedState } = await import("./ledger.mjs");
  if (state.version === FENCED_STATE_VERSION) { return readFencedState(projectDir); }
  const compatible = [LEGACY_STATE_VERSION, PREVIOUS_STATE_VERSION, CURRENT_STATE_VERSION].includes(state.version);
  if (!compatible) { return null; }
  try { await fs.access(ledgerFile(projectDir)); }
  catch (error) { if (error.code === "ENOENT") { return null; } throw error; }
  return readFencedState(projectDir);
}

function rejectFutureState(state, file) {
  if (state?.version > FENCED_STATE_VERSION) { rejectFutureWritableVersion(state, file); }
}

async function parseStateFile(projectDir, file, raw) {
  const state = JSON.parse(raw);
  rejectLegacyV1State(state, file);
  rejectMalformedFencedState(state, file);
  const ledgerState = state && typeof state === "object" ? await readLedgerState(projectDir, state) : null;
  if (ledgerState) { return ledgerState; }
  rejectFutureState(state, file);
  const migrated = migrateState(state);
  if (migrated && typeof migrated === "object") { validateStateInvariants(migrated, "state.read"); }
  return migrated;
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
  return state?.version === FENCED_STATE_VERSION || Number.isInteger(state?.fence_generation);
}

async function assertLegacyWriteAllowed(lockContext, projectDir, targetState) {
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
  if (hasFenceMarker(existing) || hasFenceMarker(targetState)) { throw ledgerRequired("state: v5 states require the revision ledger commit API"); }
}

function rejectUnsupportedWriteVersion(state, file) {
  if (state?.version === 1) { throw new Error("writeState: invalid state (version 1 is no longer supported; this build of climier only writes v4 states)"); }
  if (state?.version > FENCED_STATE_VERSION) { rejectFutureWritableVersion(state, file); }
}

async function readStateForUpdate(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") { throw error; } return emptyState(); }
}

function rejectLegacyWritableVersion(file) {
  const error = new Error(
    `state: file at ${file} has version 1; this version of climier no longer supports the v1 schema. ` +
    `Run \`climier init --force\` to overwrite the v1 state with a fresh v3 state.`,
  );
  error.code = "STATE_V1_UNSUPPORTED";
  error.details = { file, version: 1, hint: "Run `climier init --force` to overwrite the v1 state." };
  throw error;
}

function rejectFutureWritableVersion(state, file) {
  const error = new Error(`state: file at ${file} has version ${state.version} but this climier only understands version ${FENCED_STATE_VERSION}`);
  error.code = "CLIMIER_INCOMPATIBLE_VERSION";
  throw error;
}

function assertWritableStateVersion(state, file) {
  if (!state || typeof state !== "object") { return; }
  if (state.version === 1) { rejectLegacyWritableVersion(file); }
  if (state.version === FENCED_STATE_VERSION) { throw ledgerRequired("state.update: v5 states require the revision ledger commit API (not integrated)"); }
  if (state.version > FENCED_STATE_VERSION) { rejectFutureWritableVersion(state, file); }
}

async function persistUpdatedState(file, lockContext, projectDir, state) {
  await assertLegacyWriteAllowed(lockContext, projectDir, state);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

async function updateStateUnderLock(projectDir, lockContext, mutator) {
  const file = stateFile(projectDir);
  await assertLegacyWriteAllowed(lockContext, projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let state = await readStateForUpdate(file);
  assertWritableStateVersion(state, file);
  state = migrateState(state);
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
  // Timestamp prefix preserves creation ordering at millisecond precision.
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
    // ignored by design
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
  // Preserve raw bytes; corrupt-recovery snapshots may not be JSON.
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
  rejectUnsupportedWriteVersion(state, stateFile(projectDir));
  await assertLegacyWriteAllowed(lockContext, projectDir, state);
  state = migrateState(state);
  if (state.version !== CURRENT_STATE_VERSION) { throw new Error(`writeState: invalid state (version ${state.version} is not supported; expected version ${CURRENT_STATE_VERSION})`); }
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
