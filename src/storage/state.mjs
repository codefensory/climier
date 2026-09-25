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
  if (!fsSync.existsSync(file)) return null;
  let meta;
  try {
    meta = JSON.parse(fsSync.readFileSync(file, "utf8"));
  } catch (err) {
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

function globalStateFile(projectId) {
  return path.join(climierHome(), "projects", projectId, "tasks.json");
}

function defaultProjectId(projectDir) {
  return crypto.createHash("sha1").update(path.resolve(projectDir)).digest("hex").slice(0, 16);
}

export function stateFile(projectDir) {
  const meta = readProjectMetaSync(projectDir);
  return globalStateFile(meta ? meta.project_id : defaultProjectId(projectDir));
}

export async function ensureProjectMeta(projectDir) {
  const existing = readProjectMetaSync(projectDir);
  if (existing) return existing;
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
  return !!state && state.version === FENCED_STATE_VERSION;
}

// v1 is no longer supported. v2 and v3 remain readable through this narrow
// migration because their collections and node representation are compatible
// with v4. The returned object is new, and migration never mutates its input.
export function migrateState(state) {
  if (state && (state.version === LEGACY_STATE_VERSION || state.version === PREVIOUS_STATE_VERSION)) {
    return { ...state, version: CURRENT_STATE_VERSION, revision: 0 };
  }
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
  return !!state && (state.version === LEGACY_STATE_VERSION || state.version === PREVIOUS_STATE_VERSION || state.version === CURRENT_STATE_VERSION);
}

export function isV3State(state) {
  return !!state && (state.version === PREVIOUS_STATE_VERSION || state.version === CURRENT_STATE_VERSION);
}

export function assertStateVersion(state, version, commandName) {
  if (!state) return;
  if (state.version === version || (version === LEGACY_STATE_VERSION && state.version === CURRENT_STATE_VERSION)) return;
  throw new Error(`${commandName}: state version ${state.version} is not supported by this command (expected version ${version})`);
}

export async function readState(projectDir) {
  const file = stateFile(projectDir);
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      const { ledgerFile, readFencedState } = await import("./ledger.mjs");
      try {
        await fs.access(ledgerFile(projectDir));
      } catch (ledgerError) {
        if (ledgerError.code === "ENOENT") return null;
        throw ledgerError;
      }
      return readFencedState(projectDir);
    }
    throw err;
  }

  try {
    const state = JSON.parse(raw);
    // v1 states are no longer supported. Surface a structured error so the
    // caller (CLI entry or init) can guide the user through manual
    // migration. The migration path is documented in the message and
    // details: backup, export, init --force, recreate nodes.
    if (state && typeof state === "object" && state.version === 1) {
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
    // An object carrying only the version marker is still an unsupported shape,
    // not a fenced state. Keep the legacy forward-compatibility error for this
    // malformed fixture; complete v5 states are validated by the ledger reader.
    if (state && typeof state === "object" && state.version === FENCED_STATE_VERSION
        && !Number.isInteger(state.fence_generation)) {
      const wrapped = new Error(`state: file at ${file} has version ${state.version} but this climier requires a fenced state`);
      wrapped.code = "CLIMIER_INCOMPATIBLE_VERSION";
      throw wrapped;
    }
    // Load the ledger reader only after this module has initialized. ledger.mjs
    // imports stateFile/migrateState from this module, so a static reverse import
    // would create an initialization cycle. The reader owns its single lock and
    // validates/recoveries the v5 state against the durable project ledger.
    if (state && typeof state === "object" && state.version === FENCED_STATE_VERSION) {
      const { readFencedState } = await import("./ledger.mjs");
      return await readFencedState(projectDir);
    }
    // A migration_pending ledger is durable before the legacy source is renamed
    // to v5. Probe only for its existence here; readFencedState reopens and
    // validates it under the lock before attempting exact-fingerprint recovery.
    if (state && typeof state === "object" && [LEGACY_STATE_VERSION, PREVIOUS_STATE_VERSION, CURRENT_STATE_VERSION].includes(state.version)) {
      const { ledgerFile, readFencedState } = await import("./ledger.mjs");
      let hasLedger = true;
      try {
        await fs.access(ledgerFile(projectDir));
      } catch (err) {
        if (err.code === "ENOENT") hasLedger = false;
        else throw err;
      }
      if (hasLedger) return await readFencedState(projectDir);
    }
    // Forward-compatibility: surface a clear error if a future version is found.
    if (state && typeof state === "object" && "version" in state && state.version > FENCED_STATE_VERSION) {
      const wrapped = new Error(`state: file at ${file} has version ${state.version} but this climier only understands version ${FENCED_STATE_VERSION}`);
      wrapped.code = "CLIMIER_INCOMPATIBLE_VERSION";
      throw wrapped;
    }
    const migrated = migrateState(state);
    if (migrated && typeof migrated === "object") validateStateInvariants(migrated, "state.read");
    return migrated;
  } catch (err) {
    if (err instanceof SyntaxError) {
      const wrapped = new Error(`state: file at ${file} is corrupt or not valid JSON: ${err.message}`);
      wrapped.code = "CLIMIER_CORRUPT_STATE";
      wrapped.cause = err;
      throw wrapped;
    }
    throw err;
  }
}

function ledgerRequired(message) {
  const error = new Error(message);
  error.code = "CLIMIER_LEDGER_REQUIRED";
  return error;
}

function hasFenceMarker(state) {
  return !!state && (state.version === FENCED_STATE_VERSION || Number.isInteger(state.fence_generation));
}

async function assertLegacyWriteAllowed(lockContext, projectDir, targetState) {
  assertActiveLockContext(lockContext, projectDir);
  const { statePath } = getActiveLockContext(lockContext);
  const ledgerPath = path.join(path.dirname(statePath), "revision-ledger.json");
  try {
    await fs.access(ledgerPath);
    throw ledgerRequired("state: revision-ledger projects require the fenced ledger commit API");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let existing;
  try {
    existing = JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  if (hasFenceMarker(existing) || hasFenceMarker(targetState)) {
    throw ledgerRequired("state: v5 states require the revision ledger commit API");
  }
}

function rejectUnsupportedWriteVersion(state, file) {
  if (state && typeof state === "object" && state.version === 1) {
    throw new Error(
      "writeState: invalid state (version 1 is no longer supported; this build of climier only writes v4 states)",
    );
  }
  if (state && typeof state === "object" && "version" in state && state.version > FENCED_STATE_VERSION) {
    const wrapped = new Error(`state: file at ${file} has version ${state.version} but this climier only understands version ${FENCED_STATE_VERSION}`);
    wrapped.code = "CLIMIER_INCOMPATIBLE_VERSION";
    throw wrapped;
  }
}

async function updateStateUnderLock(projectDir, lockContext, mutator) {
  const file = stateFile(projectDir);
  await assertLegacyWriteAllowed(lockContext, projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let state;
  try {
    const raw = await fs.readFile(file, "utf8");
    state = JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    state = emptyState();
  }
  if (state && typeof state === "object" && state.version === 1) {
    const wrapped = new Error(
      `state: file at ${file} has version 1; this version of climier no longer supports the v1 schema. ` +
      `Run \`climier init --force\` to overwrite the v1 state with a fresh v3 state.`,
    );
    wrapped.code = "STATE_V1_UNSUPPORTED";
    wrapped.details = { file, version: 1, hint: "Run `climier init --force` to overwrite the v1 state." };
    throw wrapped;
  }
  if (state && typeof state === "object" && state.version === FENCED_STATE_VERSION) {
    throw ledgerRequired("state.update: v5 states require the revision ledger commit API (not integrated)");
  }
  if (state && typeof state === "object" && "version" in state && state.version > FENCED_STATE_VERSION) {
    const wrapped = new Error(`state: file at ${file} has version ${state.version} but this climier only understands version ${FENCED_STATE_VERSION}`);
    wrapped.code = "CLIMIER_INCOMPATIBLE_VERSION";
    throw wrapped;
  }
  state = migrateState(state);
  if (state && typeof state === "object") validateStateInvariants(state, "state.update");
  const next = mutator({ ...state });
  if (next === undefined) throw new Error("updateState mutator must return the new state object");
  await assertLegacyWriteAllowed(lockContext, projectDir, next);
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
  return next;
}

// Hold one project lock over the full read/mutate/write transaction. Nested
// calls from an existing withLock scope reuse that scope's opaque capability.
export async function updateState(projectDir, mutator) {
  return withLock(projectDir, (lockContext) => updateStateUnderLock(projectDir, lockContext, mutator));
}

// =====================================================================
// Snapshot primitives (ADR-004 §§Snapshots/Plan 1)
//
// A snapshot lives under `<state-dir>/snapshots/` and is an immutable
// raw copy of the state file at the moment of capture, plus a sibling
// metadata file with id/created_at/reason/bytes/sha256. Creation is
// always paired with temp+rename so a partial pair never appears as
// "complete" in `listSnapshots`. The caller is expected to hold
// `withLock(projectDir)` for the lifetime of the mutation; we do not
// take the lock here so the primitive stays composable.
// =====================================================================

const VALID_SNAPSHOT_REASONS = new Set(["force-init", "corrupt-recovery", "pre-restore"]);

function snapshotDir(projectDir) {
  return path.join(path.dirname(stateFile(projectDir)), "snapshots");
}

// Public accessor for the snapshot directory of a project. Exported so
// commands (notably `restore`) can compose against the same layout the
// primitives write into without recomputing the path.
export { snapshotDir };

function buildSnapshotId(reason) {
  // toISOString() returns `YYYY-MM-DDTHH:mm:ss.SSSZ`. Strip the dashes,
  // colons and dot so the id prefix is a sortable UTC timestamp with
  // millisecond precision (matches the ADR format).
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

export async function createSnapshot(projectDir, reason) {
  if (!VALID_SNAPSHOT_REASONS.has(reason)) {
    const allowed = [...VALID_SNAPSHOT_REASONS].join(", ");
    throw new Error(`createSnapshot: invalid reason '${reason}' (allowed: ${allowed})`);
  }
  const statePath = stateFile(projectDir);
  // Read raw bytes (may include non-JSON content for corrupt-recovery;
  // we never parse the state file here, by design).
  const raw = await fs.readFile(statePath);
  const dir = snapshotDir(projectDir);
  await fs.mkdir(dir, { recursive: true });
  await tryChmod(dir, 0o700);
  const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
  const id = buildSnapshotId(reason);
  const finalRawPath = path.join(dir, `${id}.json`);
  const finalMetaPath = path.join(dir, `${id}.meta.json`);
  const tmpRawPath = `${finalRawPath}.tmp-${process.pid}-${Date.now()}`;
  const tmpMetaPath = `${finalMetaPath}.tmp-${process.pid}-${Date.now()}`;
  const metadata = {
    id,
    created_at: new Date().toISOString(),
    reason,
    bytes: raw.length,
    sha256,
  };
  // Write raw first, then metadata. Both use temp+rename so a crash
  // mid-write never leaves a half-written file at the final path.
  await fs.writeFile(tmpRawPath, raw);
  await tryChmod(tmpRawPath, 0o600);
  await fs.writeFile(tmpMetaPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");
  await tryChmod(tmpMetaPath, 0o600);
  await fs.rename(tmpRawPath, finalRawPath);
  await fs.rename(tmpMetaPath, finalMetaPath);
  return metadata;
}

export async function listSnapshots(projectDir) {
  const dir = snapshotDir(projectDir);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const result = [];
  for (const name of entries) {
    // We anchor on the metadata file: a metadata file without its raw
    // pair is incomplete, and an orphan raw file has no metadata to
    // describe it. The primitive surfaces only complete pairs.
    if (!name.endsWith(".meta.json")) continue;
    const id = name.slice(0, -".meta.json".length);
    const rawPath = path.join(dir, `${id}.json`);
    const metaPath = path.join(dir, `${id}.meta.json`);
    try {
      await fs.access(rawPath);
    } catch {
      continue;
    }
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    } catch {
      continue;
    }
    // Mismatched id (tampered metadata) is treated as incomplete.
    if (!meta || typeof meta !== "object" || meta.id !== id) continue;
    result.push(meta);
  }
  // Sort descending: ids are timestamp-prefixed, so lexicographic order
  // matches creation order. Newest first matches the ADR §Snapshots
  // listing contract.
  result.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return result;
}

async function writeStateUnderLock(projectDir, lockContext, state) {
  if (!state || typeof state !== "object") {
    throw new Error("writeState: invalid state (not an object)");
  }
  rejectUnsupportedWriteVersion(state, stateFile(projectDir));
  await assertLegacyWriteAllowed(lockContext, projectDir, state);
  state = migrateState(state);
  if (state.version !== CURRENT_STATE_VERSION) {
    throw new Error(`writeState: invalid state (version ${state.version} is not supported; expected version ${CURRENT_STATE_VERSION})`);
  }
  validateStateInvariants(state, "writeState");
  const required = ["nodes", "edges", "initiatives", "log"];
  for (const k of required) {
    if (!(k in state)) {
      throw new Error(`writeState: invalid state (missing '${k}' collection)`);
    }
  }
  const file = stateFile(projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

// writeState validates and persists the current v4 schema under the canonical
// project lock. Existing kernel callers inside withLock reuse its capability.
export async function writeState(projectDir, state) {
  return withLock(projectDir, (lockContext) => writeStateUnderLock(projectDir, lockContext, state));
}

// Validate that an initiative name is registered in state.initiatives.
// Throws with a clear error listing valid names (or the bootstrap hint)
// if not. Used by add-task / add-decision / add-gotcha to prevent silent
// typo-driven orphan initiatives (the "qa" / "research" case in real
// projects: an agent writes --initiative=qa and it just sticks).
// ponytail: this is the only place initiative registration is enforced.
// Validation lives here (state.mjs) not in dag.mjs because it's a state
// concern, not a derivation. The helper is pure; callers pass the state
// they already loaded.
export function assertInitiativeRegistered(state, name, commandName) {
  if (name === true) {
    // CLI parser quirk: `--initiative` with no value becomes boolean true.
    // The required-only flag checks (e.g. add-task's) catch this earlier
    // for required fields, but for optional ones we surface a clear error.
    throw new Error(`${commandName}: --initiative requires a value`);
  }
  if (
    state &&
    state.initiatives &&
    Object.prototype.hasOwnProperty.call(state.initiatives, name)
  ) {
    return;
  }
  const valid =
    state && state.initiatives ? Object.keys(state.initiatives).sort() : [];
  const hint =
    valid.length > 0
      ? `valid initiatives: ${valid.join(", ")}`
      : `no initiatives registered; run \`climier add-initiative <name> --desc "..."\` first`;
  throw new Error(`${commandName}: --initiative '${name}' is not registered (${hint})`);
}

export { readProjectMetaSync };
