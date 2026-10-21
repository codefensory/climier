import fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { asCaughtError, codedError } from "../../contracts/errors.ts";
import { validateStateInvariants } from "../../contracts/state-invariants.ts";
import { SQLITE_INDEXES, SQLITE_PRAGMAS, SQLITE_SCHEMA, SQLITE_SCHEMA_VERSION } from "./schema.ts";
import { bodyHash, makeStoredLogRows, nodeWithoutBodyText, readSqliteChangesInTransaction } from "./delta.ts";

const SQLITE_MODULE = "bun:sqlite";
const COLLECTIONS = new Set(["nodes", "edges", "initiatives", "log"]);
const META_FIELDS = new Set(["version", "revision"]);
const ROOT_ORDER_KEY = "__root_order";
const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const sqliteTransaction = new AsyncLocalStorage<{ file: string; database: any }>();
const sqliteQueues = new Map<string, Promise<void>>();

type SqliteState = Record<string, unknown> & {
  version: number;
  revision: number;
  nodes: Record<string, unknown>;
  edges: unknown[];
  initiatives: Record<string, unknown>;
  log: unknown[];
};

function storeBody(database, hash: string, body: string, knownBodies: Map<string, string>) {
  if (knownBodies.has(hash)) {
    if (knownBodies.get(hash) !== body) { throw new Error(`storage: body hash collision for ${hash}`); }
    return;
  }
  database.query("INSERT INTO node_body (hash, body) VALUES (?, ?) ON CONFLICT(hash) DO NOTHING").run(hash, body);
  const stored = database.query("SELECT body FROM node_body WHERE hash = ?").get(hash);
  if (stored?.body !== body) { throw new Error(`storage: body hash collision for ${hash}`); }
  knownBodies.set(hash, body);
}

function hasBodyHashColumn(database): boolean {
  return database.query("PRAGMA table_info(nodes)").all().some(({ name }) => name === "body_hash");
}

function hasLogDeltaColumns(database): boolean {
  const columns = new Set(database.query("PRAGMA table_info(log)").all().map(({ name }) => name));
  return ["from_revision", "state_revision", "delta"].every((name) => columns.has(name));
}

function hasEdgeLookupColumns(database): boolean {
  const columns = new Set(database.query("PRAGMA table_info(edges)").all().map(({ name }) => name));
  return ["from_id", "to_id", "edge_type"].every((name) => columns.has(name));
}

function supportsSchemaVersion(version: number): boolean {
  return version === 0 || version === 1 || version === 2 || version === 3 || version === SQLITE_SCHEMA_VERSION;
}

function addMissingSchemaColumns(database) {
  if (!hasBodyHashColumn(database)) { database.exec("ALTER TABLE nodes ADD COLUMN body_hash TEXT"); }
  const logColumns = new Set(database.query("PRAGMA table_info(log)").all().map(({ name }) => name));
  if (!logColumns.has("from_revision")) { database.exec("ALTER TABLE log ADD COLUMN from_revision INTEGER"); }
  if (!logColumns.has("state_revision")) { database.exec("ALTER TABLE log ADD COLUMN state_revision INTEGER"); }
  if (!logColumns.has("delta")) { database.exec("ALTER TABLE log ADD COLUMN delta TEXT"); }
  const edgeColumns = new Set(database.query("PRAGMA table_info(edges)").all().map(({ name }) => name));
  if (!edgeColumns.has("from_id")) { database.exec("ALTER TABLE edges ADD COLUMN from_id TEXT"); }
  if (!edgeColumns.has("to_id")) { database.exec("ALTER TABLE edges ADD COLUMN to_id TEXT"); }
  if (!edgeColumns.has("edge_type")) { database.exec("ALTER TABLE edges ADD COLUMN edge_type TEXT"); }
}

function initializeDeltaFloor(database, schemaVersion: number) {
  if (schemaVersion === 0) { return; }
  const storedRevision = database.query("SELECT value FROM meta WHERE key = 'revision'").get();
  const revision = storedRevision ? JSON.parse(storedRevision.value) : 0;
  database.query("INSERT OR IGNORE INTO sync_state (key, value) VALUES ('delta_floor', ?)").run(revision);
}

function upgradeDatabase(database, schemaVersion: number) {
  database.exec(SQLITE_SCHEMA);
  addMissingSchemaColumns(database);
  if (schemaVersion < SQLITE_SCHEMA_VERSION) {
    migrateInlineBodies(database);
    migrateEdgeLookupColumns(database);
  }
  database.exec(SQLITE_INDEXES);
  initializeDeltaFloor(database, schemaVersion);
  database.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
}

function migrateInlineBodies(database) {
  const rows = database.query("SELECT id, data, body_hash FROM nodes ORDER BY position").all();
  const knownBodies = new Map<string, string>();
  const updateNode = database.query("UPDATE nodes SET data = ?, body_hash = ? WHERE id = ?");
  for (const row of rows) {
    const node = JSON.parse(row.data);
    if (!node || typeof node !== "object" || Array.isArray(node) || typeof node.body !== "string") { continue; }
    const hash = bodyHash(node.body);
    storeBody(database, hash, node.body, knownBodies);
    updateNode.run(JSON.stringify(nodeWithoutBodyText(node)), hash, row.id);
  }
}

function migrateEdgeLookupColumns(database) {
  const rows = database.query("SELECT position, data FROM edges ORDER BY position").all();
  const update = database.query("UPDATE edges SET from_id = ?, to_id = ?, edge_type = ? WHERE position = ?");
  for (const { position, data } of rows) {
    const edge = JSON.parse(data);
    update.run(edge?.from ?? null, edge?.to ?? null, edge?.type ?? null, position);
  }
}

async function assertDatabaseFile(file: string) {
  let handle;
  try {
    handle = await fs.open(file, "r");
  } catch (rawCaughtValue: unknown) {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") { return; }
    throw error;
  }
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead > 0 && (bytesRead !== header.length || !header.equals(SQLITE_HEADER))) {
      throw new Error(`storage: file at ${file} is corrupt or not a database`);
    }
  } finally {
    await handle.close();
  }
}

async function openDatabase(file: string) {
  await assertDatabaseFile(file);
  const { Database } = await import(SQLITE_MODULE);
  const database = new Database(file, { create: true });
  try {
    database.exec(SQLITE_PRAGMAS);
    const { user_version: schemaVersion } = database.query("PRAGMA user_version").get();
    if (!supportsSchemaVersion(schemaVersion)) {
      throw new Error(`storage: unsupported SQLite schema version ${schemaVersion}`);
    }
    if (schemaVersion === SQLITE_SCHEMA_VERSION && hasBodyHashColumn(database) && hasLogDeltaColumns(database) && hasEdgeLookupColumns(database)) { return database; }
    database.transaction(() => upgradeDatabase(database, schemaVersion))();
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function assertCanonicalState(state: unknown, command: string): asserts state is SqliteState {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error(`${command}: invalid state (not an object)`);
  }
  const candidate = state as Record<string, unknown>;
  for (const key of COLLECTIONS) {
    if (!(key in candidate)) { throw new Error(`${command}: invalid state (missing '${key}' collection)`); }
  }
  if (candidate.version !== 1) {
    throw new Error(`${command}: SQLite store requires canonical schema-1 state`);
  }
  validateStateInvariants(candidate, command);
}

function readRows(database, table: string, key: string) {
  return database.query(`SELECT ${key}, data FROM ${table} ORDER BY position`).all();
}

function readNodes(database, includeBodies: boolean): Record<string, unknown> {
  const nodes = Object.fromEntries(database.query("SELECT id, data, body_hash FROM nodes ORDER BY position").all()
    .map(({ id, data, body_hash }) => [id, { node: JSON.parse(data), bodyHash: body_hash }]));
  if (includeBodies) {
    const bodies = new Map<string, string>();
    for (const { bodyHash: hash } of Object.values(nodes) as Array<{ node: Record<string, unknown>; bodyHash: string | null }>) {
      if (hash === null || bodies.has(hash)) { continue; }
      const stored = database.query("SELECT body FROM node_body WHERE hash = ?").get(hash);
      if (!stored) { throw new Error(`storage: missing body with content hash ${hash}`); }
      bodies.set(hash, stored.body);
    }
    for (const value of Object.values(nodes) as Array<{ node: Record<string, unknown>; bodyHash: string | null }>) {
      if (value.bodyHash !== null) { value.node.body = bodies.get(value.bodyHash); }
    }
  }
  return Object.fromEntries(Object.entries(nodes).map(([id, { node }]) => [id, node]));
}

function activeDatabase(file: string) {
  const active = sqliteTransaction.getStore();
  if (active && active.file !== path.resolve(file)) { throw new Error("storage: cannot access another SQLite project inside an active transaction"); }
  return active?.database;
}

async function withReadTransaction<T>(file: string, missing: T, read: (database: any) => T): Promise<T> {
  const active = activeDatabase(file);
  if (active) { return read(active); }
  try {
    await fs.access(file);
  } catch (rawCaughtValue: unknown) {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") { return missing; }
    throw error;
  }
  const database = await openDatabase(file);
  try { return database.transaction(() => read(database))(); }
  finally { database.close(); }
}

async function withProcessQueue<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const previous = sqliteQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  sqliteQueues.set(key, current);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (sqliteQueues.get(key) === current) { sqliteQueues.delete(key); }
  }
}

export async function withSqliteTransaction<T>(file: string, operation: () => Promise<T>): Promise<T> {
  if (activeDatabase(file)) {
    throw codedError(
      "INVALID_EXECUTION_CONTRACT",
      "kernel.mutate: nested kernel.mutate is rejected (the kernel is single-entry; providers must not mutate)",
      { field: "mutate", depth: 2 },
    );
  }
  return withProcessQueue(file, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const database = await openDatabase(file);
    let transactionStarted = false;
    try {
      database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const result = await sqliteTransaction.run({ file: path.resolve(file), database }, operation);
      database.exec("COMMIT");
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        try { database.exec("ROLLBACK"); } catch {}
      }
      throw error;
    } finally {
      database.close();
    }
  });
}

function readLog(database, includeLog: boolean) {
  if (includeLog) {
    return readRows(database, "log", "position").map(({ data }) => JSON.parse(data));
  }
  const invalid = database.query("SELECT data FROM log WHERE json_valid(data) = 0 ORDER BY position LIMIT 1").get();
  if (invalid) { JSON.parse(invalid.data); }
  return [];
}

function readStateInTransaction(database, { includeBodies = true, includeLog = true }: { includeBodies?: boolean; includeLog?: boolean } = {}): SqliteState | null {
  const metadata = Object.fromEntries(database.query("SELECT key, value FROM meta").all()
    .map(({ key, value }) => [key, JSON.parse(value)]));
  if (metadata.version === undefined) { return null; }
  const extras = { ...metadata.extras };
  const values = {
    ...extras,
    version: metadata.version,
    revision: metadata.revision,
    nodes: readNodes(database, includeBodies),
    edges: readRows(database, "edges", "position").map(({ data }) => JSON.parse(data)),
    initiatives: Object.fromEntries(readRows(database, "initiatives", "name").map(({ name, data }) => [name, JSON.parse(data)])),
    log: readLog(database, includeLog),
  };
  const state = Object.fromEntries((metadata[ROOT_ORDER_KEY] || Object.keys(values))
    .filter((key) => Object.hasOwn(values, key))
    .map((key) => [key, values[key]]));
  assertCanonicalState(state, "readState");
  return state;
}

function contentAddressedNode(database, value: unknown, knownBodies: Map<string, string>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) { return { data: value, hash: null }; }
  const node = value as Record<string, unknown>;
  if (typeof node.body !== "string") { return { data: value, hash: null }; }
  const hash = bodyHash(node.body);
  storeBody(database, hash, node.body, knownBodies);
  return { data: nodeWithoutBodyText(node), hash };
}

function replaceNodes(database, nodes: Record<string, unknown>) {
  const knownBodies = new Map<string, string>();
  const insert = database.prepare("INSERT INTO nodes (id, position, data, body_hash) VALUES (?, ?, ?, ?)");
  Object.entries(nodes).forEach(([id, value], position) => {
    const { data, hash } = contentAddressedNode(database, value, knownBodies);
    insert.run(id, position, JSON.stringify(data), hash);
  });
  database.exec("DELETE FROM node_body WHERE hash NOT IN (SELECT body_hash FROM nodes WHERE body_hash IS NOT NULL)");
}

function replaceMetadata(database, state: SqliteState) {
  const insert = database.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  const extras = Object.fromEntries(Object.entries(state).filter(([key]) => !META_FIELDS.has(key) && !COLLECTIONS.has(key)));
  for (const [key, value] of Object.entries({
    version: state.version,
    revision: state.revision,
    extras,
    [ROOT_ORDER_KEY]: Object.keys(state),
  })) { insert.run(key, JSON.stringify(value)); }
}

function replaceRows(database, state: SqliteState, previousState?: Record<string, unknown> | null) {
  const previous = (previousState === undefined ? readStateInTransaction(database, { includeBodies: false }) : previousState) as SqliteState | null;
  const previousBodyHashes = new Map<string, string | null>(database.query("SELECT id, body_hash FROM nodes").all()
    .map(({ id, body_hash }) => [id, body_hash as string | null]));
  const storedLogRows = makeStoredLogRows(database, state, previous, previousBodyHashes);
  database.exec("DELETE FROM meta; DELETE FROM nodes; DELETE FROM edges; DELETE FROM initiatives; DELETE FROM log;");
  replaceMetadata(database, state);
  replaceNodes(database, state.nodes);
  const insertEdge = database.prepare("INSERT INTO edges (position, data, from_id, to_id, edge_type) VALUES (?, ?, ?, ?, ?)");
  state.edges.forEach((edge: any, position) => insertEdge.run(position, JSON.stringify(edge), edge?.from ?? null, edge?.to ?? null, edge?.type ?? null));
  const insertInitiative = database.prepare("INSERT INTO initiatives (name, position, data) VALUES (?, ?, ?)");
  Object.entries(state.initiatives).forEach(([name, initiative], position) => insertInitiative.run(name, position, JSON.stringify(initiative)));
  const insertLog = database.prepare("INSERT INTO log (position, data, from_revision, state_revision, delta) VALUES (?, ?, ?, ?, ?)");
  for (const row of storedLogRows) {
    insertLog.run(row.position, row.data, row.from_revision, row.state_revision, row.delta);
  }
}

export async function readSqliteState(file: string, options: { includeBodies?: boolean; includeLog?: boolean } = {}) {
  const active = activeDatabase(file);
  if (active) { return readStateInTransaction(active, options); }
  try {
    await fs.access(file);
  } catch (rawCaughtValue: unknown) {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") { return null; }
    throw error;
  }
  const database = await openDatabase(file);
  try {
    return database.transaction(() => readStateInTransaction(database, options))();
  } finally {
    database.close();
  }
}

function hydrateNode(database, row) {
  const node = JSON.parse(row.data);
  if (row.body_hash !== null && row.body_hash !== undefined) {
    const body = database.query("SELECT body FROM node_body WHERE hash = ?").get(row.body_hash);
    if (!body) { throw new Error(`storage: missing body with content hash ${row.body_hash}`); }
    node.body = body.body;
  }
  return node;
}

export async function readSqliteNode(file: string, id: string): Promise<Record<string, unknown> | null> {
  return withReadTransaction(file, null, (database) => {
    const row = database.query("SELECT data, body_hash FROM nodes WHERE id = ?").get(id);
    return row ? hydrateNode(database, row) : null;
  });
}

export async function readSqliteNodesByIds(file: string, ids: string[]): Promise<Record<string, Record<string, unknown>>> {
  const uniqueIds = [...new Set(ids)];
  return withReadTransaction(file, {}, (database) => {
    if (uniqueIds.length === 0) { return {}; }
    const rows = database.query(
      `SELECT id, data, body_hash FROM nodes WHERE id IN (${uniqueIds.map(() => "?").join(",")}) ORDER BY position`,
    ).all(...uniqueIds);
    return Object.fromEntries(rows.map(({ id, ...row }) => [id, hydrateNode(database, row)]));
  });
}

export async function readSqliteEdgesOf(file: string, ids: string[], options: { type?: string } = {}): Promise<unknown[]> {
  const uniqueIds = [...new Set(ids)];
  return withReadTransaction(file, [], (database) => {
    if (uniqueIds.length === 0) { return []; }
    const placeholders = uniqueIds.map(() => "?").join(",");
    const typeFilter = options.type === undefined ? "" : " AND edge_type = ?";
    const params = options.type === undefined ? [...uniqueIds, ...uniqueIds] : [...uniqueIds, ...uniqueIds, options.type];
    return database.query(
      `SELECT data FROM edges WHERE (from_id IN (${placeholders}) OR to_id IN (${placeholders}))${typeFilter} ORDER BY position`,
    ).all(...params).map(({ data }) => JSON.parse(data));
  });
}

export async function readSqliteLogSince(file: string, revision: number): Promise<unknown[]> {
  if (!Number.isSafeInteger(revision) || revision < 0) { throw new TypeError("storage: revision must be a non-negative safe integer"); }
  return withReadTransaction(file, [], (database) => database.query(
    "SELECT data FROM log INDEXED BY idx_log_state_revision_position WHERE state_revision > ? ORDER BY position",
  ).all(revision).map(({ data }) => JSON.parse(data)));
}

export async function readSqliteCounts(file: string, filters: { kind?: string; subkind?: string; status?: string } = {}) {
  return withReadTransaction(file, { total: 0, byKind: {}, bySubkind: {}, byStatus: {} }, (database) => {
    const conditions: string[] = [];
    const params: string[] = [];
    for (const field of ["kind", "subkind", "status"] as const) {
      if (filters[field] !== undefined) {
        conditions.push(`json_extract(data, '$.${field}') = ?`);
        params.push(filters[field]!);
      }
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = database.query(
      `SELECT json_extract(data, '$.kind') AS kind, json_extract(data, '$.subkind') AS subkind, json_extract(data, '$.status') AS status, COUNT(*) AS count FROM nodes${where} GROUP BY kind, subkind, status ORDER BY kind, subkind, status`,
    ).all(...params);
    const byKind = new Map<string, number>();
    const bySubkind = new Map<string, number>();
    const byStatus = new Map<string, number>();
    let total = 0;
    for (const row of rows) {
      total += row.count;
      if (typeof row.kind === "string") { byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + row.count); }
      if (typeof row.subkind === "string") { bySubkind.set(row.subkind, (bySubkind.get(row.subkind) ?? 0) + row.count); }
      if (typeof row.status === "string") { byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + row.count); }
    }
    return {
      total,
      byKind: Object.fromEntries(byKind),
      bySubkind: Object.fromEntries(bySubkind),
      byStatus: Object.fromEntries(byStatus),
    };
  });
}

export async function readSqliteRevision(file: string): Promise<number> {
  return withReadTransaction(file, 0, (database) => {
    const row = database.query("SELECT value FROM meta WHERE key = 'revision'").get();
    return row ? JSON.parse(row.value) : 0;
  });
}

export async function readSqliteChangesSince(file: string, since: number) {
  if (!Number.isSafeInteger(since) || since < 0) { throw new TypeError("storage: since must be a non-negative safe integer"); }
  const active = activeDatabase(file);
  if (active) { return readSqliteChangesInTransaction(active, since); }
  try {
    await fs.access(file);
  } catch (rawCaughtValue: unknown) {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") { return null; }
    throw error;
  }
  const database = await openDatabase(file);
  try {
    return database.transaction(() => readSqliteChangesInTransaction(database, since))();
  } finally {
    database.close();
  }
}

export async function writeSqliteState(file: string, state: unknown, previousState?: Record<string, unknown> | null) {
  assertCanonicalState(state, "writeState");
  const active = activeDatabase(file);
  if (active) {
    replaceRows(active, state, previousState);
    return state;
  }
  return withSqliteTransaction(file, async () => writeSqliteState(file, state, previousState));
}

export async function updateSqliteState(file: string, mutator: (state: Record<string, unknown>) => Record<string, unknown>) {
  const active = activeDatabase(file);
  if (!active) { return withSqliteTransaction(file, () => updateSqliteState(file, mutator)); }
  const current = readStateInTransaction(active) || {
    version: 1,
    revision: 0,
    nodes: {},
    edges: [],
    initiatives: {},
    log: [],
  };
  const next = mutator({ ...current });
  if (next === undefined) { throw new Error("updateState mutator must return the new state object"); }
  assertCanonicalState(next, "state.update");
  replaceRows(active, next, current);
  return next;
}
