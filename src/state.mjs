// state.mjs: read/write/atomic-mutate the tasks.json state file.
import fs from "node:fs/promises";
import path from "node:path";

function stateFile(projectDir) {
  return path.join(projectDir, ".agents", "tasks", "tasks.json");
}

export function emptyState() {
  return {
    version: 1,
    tasks: {},
    decisions: {},
    gotchas: {},
    initiatives: {},
    log: [],
  };
}

export async function readState(projectDir) {
  try {
    const raw = await fs.readFile(stateFile(projectDir), "utf8");
    const state = JSON.parse(raw);
    // Forward-compatibility: surface a clear error if a future version is found.
    if (state && typeof state === "object" && "version" in state && state.version > 1) {
      const wrapped = new Error(`state: file at ${stateFile(projectDir)} has version ${state.version} but this climier only understands version 1`);
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

// Add a node to a top-level collection (tasks/decisions/gotchas).
// Uses withLock so concurrent addNode calls are serialized.
export async function addNode(projectDir, collection, id, node) {
  const { withLock } = await import("./lock.mjs");
  return withLock(projectDir, async () => {
    return updateState(projectDir, (s) => {
      s[collection] = s[collection] || {};
      if (s[collection][id]) throw new Error(`${collection}/${id} already exists`);
      s[collection][id] = { id, ...node };
      return s;
    });
  });
}

export async function writeState(projectDir, state) {
  // Schema validation: a state must have all five top-level collections.
  const required = ["tasks", "decisions", "gotchas", "initiatives", "log"];
  if (!state || typeof state !== "object") {
    throw new Error("writeState: invalid state (not an object)");
  }
  for (const k of required) {
    if (!(k in state)) {
      throw new Error(`writeState: invalid state (missing '${k}' collection)`);
    }
  }
  const file = stateFile(projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export { stateFile };
