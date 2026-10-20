import fs from "node:fs/promises";
import path from "node:path";
import { asCaughtError } from "../../contracts/errors.ts";
import { validateStateInvariants } from "../../contracts/state-invariants.ts";
import { SQLITE_PRAGMAS, SQLITE_SCHEMA, SQLITE_SCHEMA_VERSION } from "./schema.ts";

const SQLITE_MODULE = "bun:sqlite";
const COLLECTIONS = new Set(["nodes", "edges", "initiatives", "log"]);
const META_FIELDS = new Set(["version", "fence_generation", "revision"]);
const ROOT_ORDER_KEY = "__root_order";

type SqliteState = Record<string, unknown> & {
  version: number;
  fence_generation: number;
  revision: number;
  nodes: Record<string, unknown>;
  edges: unknown[];
  initiatives: Record<string, unknown>;
  log: unknown[];
};

async function openDatabase(file: string) {
  const { Database } = await import(SQLITE_MODULE);
  const database = new Database(file, { create: true });
  database.exec(SQLITE_PRAGMAS);
  const { user_version: schemaVersion } = database.query("PRAGMA user_version").get();
  if (schemaVersion !== 0 && schemaVersion !== SQLITE_SCHEMA_VERSION) {
    database.close();
    throw new Error(`storage: unsupported SQLite schema version ${schemaVersion}`);
  }
  database.exec(SQLITE_SCHEMA);
  if (schemaVersion === 0) { database.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`); }
  return database;
}

function assertCanonicalState(state: unknown, command: string): asserts state is SqliteState {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error(`${command}: invalid state (not an object)`);
  }
  const candidate = state as Record<string, unknown>;
  if (candidate.version !== 1 || !Number.isInteger(candidate.fence_generation)) {
    throw new Error(`${command}: SQLite store requires canonical schema-1 state with fence_generation`);
  }
  for (const key of COLLECTIONS) {
    if (!(key in candidate)) { throw new Error(`${command}: invalid state (missing '${key}' collection)`); }
  }
  validateStateInvariants(candidate, command);
}

function readRows(database, table: string, key: string) {
  return database.query(`SELECT ${key}, data FROM ${table} ORDER BY position`).all();
}

function readStateInTransaction(database): SqliteState | null {
  const metadata = Object.fromEntries(database.query("SELECT key, value FROM meta").all()
    .map(({ key, value }) => [key, JSON.parse(value)]));
  if (metadata.version === undefined) { return null; }
  const values = {
    ...metadata.extras,
    version: metadata.version,
    ...(metadata.fence_generation === undefined ? {} : { fence_generation: metadata.fence_generation }),
    revision: metadata.revision,
    nodes: Object.fromEntries(readRows(database, "nodes", "id").map(({ id, data }) => [id, JSON.parse(data)])),
    edges: readRows(database, "edges", "position").map(({ data }) => JSON.parse(data)),
    initiatives: Object.fromEntries(readRows(database, "initiatives", "name").map(({ name, data }) => [name, JSON.parse(data)])),
    log: readRows(database, "log", "position").map(({ data }) => JSON.parse(data)),
  };
  const state = Object.fromEntries((metadata[ROOT_ORDER_KEY] || Object.keys(values))
    .filter((key) => Object.hasOwn(values, key))
    .map((key) => [key, values[key]]));
  assertCanonicalState(state, "readState");
  return state;
}

function replaceRows(database, state: SqliteState) {
  database.exec("DELETE FROM meta; DELETE FROM nodes; DELETE FROM edges; DELETE FROM initiatives; DELETE FROM log;");
  const insertMeta = database.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  const extras = Object.fromEntries(Object.entries(state).filter(([key]) => !META_FIELDS.has(key) && !COLLECTIONS.has(key)));
  for (const [key, value] of Object.entries({
    version: state.version,
    fence_generation: state.fence_generation,
    revision: state.revision,
    extras,
    [ROOT_ORDER_KEY]: Object.keys(state),
  })) {
    insertMeta.run(key, JSON.stringify(value));
  }
  const insertNode = database.prepare("INSERT INTO nodes (id, position, data) VALUES (?, ?, ?)");
  Object.entries(state.nodes).forEach(([id, node], position) => insertNode.run(id, position, JSON.stringify(node)));
  const insertEdge = database.prepare("INSERT INTO edges (position, data) VALUES (?, ?)");
  state.edges.forEach((edge, position) => insertEdge.run(position, JSON.stringify(edge)));
  const insertInitiative = database.prepare("INSERT INTO initiatives (name, position, data) VALUES (?, ?, ?)");
  Object.entries(state.initiatives).forEach(([name, initiative], position) => insertInitiative.run(name, position, JSON.stringify(initiative)));
  const insertLog = database.prepare("INSERT INTO log (position, data) VALUES (?, ?)");
  state.log.forEach((entry, position) => insertLog.run(position, JSON.stringify(entry)));
}

export async function readSqliteState(file: string) {
  try {
    await fs.access(file);
  } catch (rawCaughtValue: unknown) {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") { return null; }
    throw error;
  }
  const database = await openDatabase(file);
  try {
    return database.transaction(() => readStateInTransaction(database))();
  } finally {
    database.close();
  }
}

export async function writeSqliteState(file: string, state: unknown) {
  assertCanonicalState(state, "writeState");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const database = await openDatabase(file);
  try {
    database.transaction(() => replaceRows(database, state))();
  } finally {
    database.close();
  }
  return state;
}

export async function updateSqliteState(file: string, mutator: (state: Record<string, unknown>) => Record<string, unknown>) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const database = await openDatabase(file);
  try {
    return database.transaction(() => {
      const current = readStateInTransaction(database) || {
        version: 1,
        fence_generation: 1,
        revision: 0,
        nodes: {},
        edges: [],
        initiatives: {},
        log: [],
      };
      const next = mutator({ ...current });
      if (next === undefined) { throw new Error("updateState mutator must return the new state object"); }
      assertCanonicalState(next, "state.update");
      replaceRows(database, next);
      return next;
    })();
  } finally {
    database.close();
  }
}
