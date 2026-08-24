// state.mjs: read/write/atomic-mutate the tasks.json state file.
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { climierHome, projectMetaFile } from "./paths.mjs";

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
  await fs.writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8");
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
