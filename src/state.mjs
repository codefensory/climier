// state.mjs: read/write/atomic-mutate the tasks.json state file.
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { climierHome, projectMetaFile } from "./storage/paths.mjs";

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

// v2-only: there is no v1 schema anymore. v1 states are rejected by
// readState with STATE_V1_UNSUPPORTED; the migration path lives in that
// error message. See ./commands/init.mjs for the bootstrap path.
export function emptyState() {
  return {
    version: 2,
    nodes: {},
    edges: [],
    initiatives: {},
    log: [],
  };
}

export function isV2State(state) {
  return !!state && state.version === 2;
}

export function assertStateVersion(state, version, commandName) {
  if (!state) return;
  if (state.version === version) return;
  throw new Error(`${commandName}: state version ${state.version} is not supported by this command (expected version ${version})`);
}

export async function readState(projectDir) {
  try {
    const raw = await fs.readFile(stateFile(projectDir), "utf8");
    const state = JSON.parse(raw);
    // v1 states are no longer supported. Surface a structured error so the
    // caller (CLI entry or init) can guide the user through manual
    // migration. The migration path is documented in the message and
    // details: backup, export, init --force, recreate nodes.
    if (state && typeof state === "object" && state.version === 1) {
      const migrationSteps = [
        "1. Backup the existing tasks.json file.",
        "2. Export any nodes you want to keep (the v1 schema uses tasks/decisions/gotchas; recreate them with add-task/add-gate/add-knowledge).",
        "3. Run `climier init --force` to recreate the project state in v2.",
        "4. Recreate each node with add-initiative / add-task / add-gate / add-knowledge (see `climier --help` for the v2 surface).",
      ];
      const wrapped = new Error(
        `state: file at ${stateFile(projectDir)} has version 1; this version of climier no longer supports the v1 schema. ` +
        `To migrate, follow these steps:\n${migrationSteps.join("\n")}`,
      );
      wrapped.code = "STATE_V1_UNSUPPORTED";
      wrapped.details = {
        file: stateFile(projectDir),
        version: 1,
        migration_steps: migrationSteps,
        hint: "Run `climier init --force` to overwrite the v1 state with a fresh v2 state (this will erase the v1 data).",
      };
      throw wrapped;
    }
    // Forward-compatibility: surface a clear error if a future version is found.
    if (state && typeof state === "object" && "version" in state && state.version > 2) {
      const wrapped = new Error(`state: file at ${stateFile(projectDir)} has version ${state.version} but this climier only understands version 2`);
      wrapped.code = "CLIMIER_INCOMPATIBLE_VERSION";
      throw wrapped;
    }
    return state;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    if (err instanceof SyntaxError) {
      const wrapped = new Error(`state: file at ${stateFile(projectDir)} is corrupt or not valid JSON: ${err.message}`);
      wrapped.code = "CLIMIER_CORRUPT_STATE";
      wrapped.cause = err;
      throw wrapped;
    }
    throw err;
  }
}

// Atomic update: read, mutate, write to tmp, rename. Never partial.
export async function updateState(projectDir, mutator) {
  const file = stateFile(projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let state;
  try {
    const raw = await fs.readFile(file, "utf8");
    state = JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    state = emptyState();
  }
  // If state.version !== 2, surface the same v1 / incompatible-version error
  // readState would. updateState is the path most mutating commands hit on
  // existing state files; it must reject v1 the same way so callers don't
  // bypass the check.
  if (state && typeof state === "object" && state.version === 1) {
    const wrapped = new Error(
      `state: file at ${file} has version 1; this version of climier no longer supports the v1 schema. ` +
      `Run \`climier init --force\` to overwrite the v1 state with a fresh v2 state.`,
    );
    wrapped.code = "STATE_V1_UNSUPPORTED";
    wrapped.details = { file, version: 1, hint: "Run `climier init --force` to overwrite the v1 state." };
    throw wrapped;
  }
  if (state && typeof state === "object" && "version" in state && state.version > 2) {
    const wrapped = new Error(`state: file at ${file} has version ${state.version} but this climier only understands version 2`);
    wrapped.code = "CLIMIER_INCOMPATIBLE_VERSION";
    throw wrapped;
  }
  const next = mutator({ ...state });
  if (next === undefined) {
    // mutator mutated in-place; we wrote the spread so the outer state is stale.
    // To be safe, re-read after writing via mutator that returns the new state.
    throw new Error("updateState mutator must return the new state object");
  }
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
  return next;
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
  // listing contract for the future `snapshots` command.
  result.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return result;
}

// writeState: validate and persist a v2 state. Rejects v1 shapes and any
// state missing the v2 collections. This is the single source of truth for
// the on-disk schema; helpers must not bypass it for v2 writes.
export async function writeState(projectDir, state) {
  if (!state || typeof state !== "object") {
    throw new Error("writeState: invalid state (not an object)");
  }
  if (state.version === 1) {
    throw new Error(
      "writeState: invalid state (version 1 is no longer supported; this build of climier only writes v2 states)",
    );
  }
  if (state.version !== 2) {
    throw new Error(`writeState: invalid state (version ${state.version} is not supported; expected version 2)`);
  }
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
