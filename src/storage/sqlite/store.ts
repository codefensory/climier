import fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { asCaughtError, codedError, throwV2 } from "../../contracts/errors.ts";
import { EDGE_TYPES, validateEdge, validateStateInvariants } from "../../contracts/state-invariants.ts";
import { SQLITE_INDEXES, SQLITE_PRAGMAS, SQLITE_SCHEMA, SQLITE_SCHEMA_VERSION } from "./schema.ts";
import { bodyHash, createStateDelta, makeStoredLogAppendRows, makeStoredLogRows, nodeWithoutBodyText, readDeltaFloor, readSqliteChangesInTransaction, writeDeltaFloor } from "./delta.ts";

const SQLITE_MODULE = "bun:sqlite";
const COLLECTIONS = new Set(["nodes", "edges", "initiatives", "log"]);
const META_FIELDS = new Set(["version", "revision"]);
const ROOT_ORDER_KEY = "__root_order";
const MAX_NODE_REVISION_KEY = "__maximum_node_revision";
const EDGE_VALIDATION_EPOCH_KEY = "edge_validation_epoch";
const EDGE_VALIDATION_CHECKED_KEY = "edge_validation_checked_epoch";
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

function hasIndexes(database, names: string[]): boolean {
  const placeholders = names.map(() => "?").join(",");
  const { count } = database.query(
    `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name IN (${placeholders})`,
  ).get(...names);
  return count === names.length;
}

const EDGE_VALIDATION_TRIGGERS = [
  "edge_validation_edge_insert", "edge_validation_edge_delete", "edge_validation_edge_update",
  "edge_validation_node_insert", "edge_validation_node_delete", "edge_validation_node_update",
  "edge_validation_log_invalid_insert", "edge_validation_log_invalid_update",
  "edge_validation_log_invalid_delete",
];

function hasEdgeValidationTriggers(database): boolean {
  const placeholders = EDGE_VALIDATION_TRIGGERS.map(() => "?").join(",");
  const { count } = database.query(
    `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN (${placeholders})`,
  ).get(...EDGE_VALIDATION_TRIGGERS);
  return count === EDGE_VALIDATION_TRIGGERS.length;
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

function initializeEdgeValidation(database) {
  database.query("INSERT OR IGNORE INTO sync_state (key, value) VALUES (?, 0)").run(EDGE_VALIDATION_EPOCH_KEY);
  database.query("INSERT OR IGNORE INTO sync_state (key, value) VALUES (?, -1)").run(EDGE_VALIDATION_CHECKED_KEY);
  database.query("UPDATE sync_state SET value = -1 WHERE key = ?").run(EDGE_VALIDATION_CHECKED_KEY);
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
  initializeEdgeValidation(database);
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
    if (schemaVersion === SQLITE_SCHEMA_VERSION && hasBodyHashColumn(database) && hasLogDeltaColumns(database) && hasEdgeLookupColumns(database) && hasIndexes(database, [
      "idx_nodes_count_fields_position",
      "idx_edges_identity",
      "idx_edges_json_fields",
      "idx_nodes_id_shape_kind",
      "idx_nodes_count_subkind_position",
      "idx_nodes_count_status_position",
      "idx_nodes_count_subkind_status_position",
    ]) && hasEdgeValidationTriggers(database)) { return database; }
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

async function runSqliteReadTransaction<T>(file: string, database: any, operation: () => Promise<T>): Promise<T> {
  let started = false;
  try {
    database.exec("BEGIN");
    started = true;
    const result = await sqliteTransaction.run({ file: path.resolve(file), database }, operation);
    database.exec("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) {
      try { database.exec("ROLLBACK"); } catch {}
    }
    throw error;
  }
}

export async function withSqliteReadTransaction<T>(file: string, operation: () => Promise<T>): Promise<T | null> {
  const active = activeDatabase(file);
  if (active) { return operation(); }
  try {
    await fs.access(file);
  } catch (rawCaughtValue: unknown) {
    const error = asCaughtError(rawCaughtValue);
    if (error.code === "ENOENT") { return null; }
    throw error;
  }
  const database = await openDatabase(file);
  try { return await runSqliteReadTransaction(file, database, operation); }
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

function maximumNodeRevision(nodes: Record<string, unknown>): number {
  let maximum = 0;
  for (const node of Object.values(nodes)) {
    const revision = node && typeof node === "object" ? (node as Record<string, unknown>).revision : undefined;
    if (Number.isInteger(revision) && (revision as number) > maximum) { maximum = revision as number; }
  }
  return maximum;
}

function replaceMetadata(database, state: SqliteState) {
  const insert = database.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  const extras = Object.fromEntries(Object.entries(state).filter(([key]) => !META_FIELDS.has(key) && !COLLECTIONS.has(key)));
  for (const [key, value] of Object.entries({
    version: state.version,
    revision: state.revision,
    extras,
    [ROOT_ORDER_KEY]: Object.keys(state),
    [MAX_NODE_REVISION_KEY]: maximumNodeRevision(state.nodes),
  })) { insert.run(key, JSON.stringify(value)); }
}

// Full rewrites are for migration/restore and the safe fallback when no trustworthy incremental delta exists.
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

function appendCompatibleOrder(previous: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const surviving = Object.keys(previous).filter((key) => Object.hasOwn(next, key));
  const nextKeys = Object.keys(next);
  return surviving.every((key, index) => nextKeys[index] === key);
}

function hasUnversionedRows(database): boolean {
  return Boolean(database.query(`
    SELECT 1 FROM nodes UNION ALL SELECT 1 FROM edges UNION ALL SELECT 1 FROM initiatives UNION ALL SELECT 1 FROM log LIMIT 1
  `).get());
}

function isDeltaState(value: unknown): value is SqliteState {
  if (!value || typeof value !== "object" || Array.isArray(value)) { return false; }
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 && Number.isSafeInteger(candidate.revision)
    && Boolean(candidate.nodes && typeof candidate.nodes === "object" && !Array.isArray(candidate.nodes))
    && Array.isArray(candidate.edges)
    && Boolean(candidate.initiatives && typeof candidate.initiatives === "object" && !Array.isArray(candidate.initiatives))
    && Array.isArray(candidate.log);
}

function canApplyStateDelta(database, previous: SqliteState | null, state: SqliteState, delta: Record<string, any>): boolean {
  if (!previous || state.revision < previous.revision || !Object.hasOwn(delta.log, "append")) { return false; }
  if (!appendCompatibleOrder(previous.nodes, state.nodes) || !appendCompatibleOrder(previous.initiatives, state.initiatives)) { return false; }
  const storedRevision = database.query("SELECT value FROM meta WHERE key = 'revision'").get();
  if (storedRevision) { return JSON.parse(storedRevision.value) === previous.revision; }
  return previous.revision === 0 && !hasUnversionedRows(database);
}

function applyStateDelta(database, state: SqliteState, previous: SqliteState, delta: Record<string, any>) {
  const extras = Object.fromEntries(Object.entries(state).filter(([key]) => !META_FIELDS.has(key) && !COLLECTIONS.has(key)));
  const findMetadata = database.query("SELECT value FROM meta WHERE key = ?");
  const upsertMetadata = database.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [key, value] of Object.entries({
    version: state.version,
    revision: state.revision,
    extras,
    [ROOT_ORDER_KEY]: Object.keys(state),
    [MAX_NODE_REVISION_KEY]: maximumNodeRevision(state.nodes),
  })) {
    const encoded = JSON.stringify(value);
    if (findMetadata.get(key)?.value !== encoded) { upsertMetadata.run(key, encoded); }
  }
  database.query("DELETE FROM meta WHERE key NOT IN ('version', 'revision', 'extras', ?, ?)").run(ROOT_ORDER_KEY, MAX_NODE_REVISION_KEY);

  const changedNodeIds = [...Object.keys(delta.nodes.upsert), ...delta.nodes.remove];
  const existingNodes = new Map<string, { position: number; body_hash: string | null }>();
  const findNode = database.query("SELECT position, body_hash FROM nodes WHERE id = ?");
  for (const id of changedNodeIds) {
    const row = findNode.get(id);
    if (row) { existingNodes.set(id, row); }
  }
  let nextNodePosition: number | undefined;
  const insertNode = database.query("INSERT INTO nodes (id, position, data, body_hash) VALUES (?, ?, ?, ?)");
  const updateNode = database.query("UPDATE nodes SET data = ?, body_hash = ? WHERE id = ?");
  const knownBodies = new Map<string, string>();
  for (const [id, value] of Object.entries(delta.nodes.upsert) as Array<[string, unknown]>) {
    const { data, hash } = contentAddressedNode(database, value, knownBodies);
    const existing = existingNodes.get(id);
    if (existing) { updateNode.run(JSON.stringify(data), hash, id); }
    else {
      if (nextNodePosition === undefined) { nextNodePosition = (database.query("SELECT COALESCE(MAX(position), -1) AS position FROM nodes").get().position as number) + 1; }
      insertNode.run(id, nextNodePosition++, JSON.stringify(data), hash);
    }
  }
  const deleteNode = database.query("DELETE FROM nodes WHERE id = ?");
  for (const id of delta.nodes.remove as string[]) { deleteNode.run(id); }
  const obsoleteBodyHashes = new Set([...existingNodes.values()].map(({ body_hash }) => body_hash).filter((hash): hash is string => typeof hash === "string"));
  const deleteBody = database.query("DELETE FROM node_body WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM nodes WHERE body_hash = ?)");
  for (const hash of obsoleteBodyHashes) { deleteBody.run(hash, hash); }

  const changedInitiativeNames = [...Object.keys(delta.initiatives.upsert), ...delta.initiatives.remove];
  const existingInitiatives = new Map<string, number>();
  const findInitiative = database.query("SELECT position FROM initiatives WHERE name = ?");
  for (const name of changedInitiativeNames) {
    const row = findInitiative.get(name);
    if (row) { existingInitiatives.set(name, row.position); }
  }
  let nextInitiativePosition: number | undefined;
  const insertInitiative = database.query("INSERT INTO initiatives (name, position, data) VALUES (?, ?, ?)");
  const updateInitiative = database.query("UPDATE initiatives SET data = ? WHERE name = ?");
  for (const [name, value] of Object.entries(delta.initiatives.upsert)) {
    const existing = existingInitiatives.get(name);
    if (existing !== undefined) { updateInitiative.run(JSON.stringify(value), name); }
    else {
      if (nextInitiativePosition === undefined) { nextInitiativePosition = (database.query("SELECT COALESCE(MAX(position), -1) AS position FROM initiatives").get().position as number) + 1; }
      insertInitiative.run(name, nextInitiativePosition++, JSON.stringify(value));
    }
  }
  const deleteInitiative = database.query("DELETE FROM initiatives WHERE name = ?");
  for (const name of delta.initiatives.remove as string[]) { deleteInitiative.run(name); }

  if (Object.hasOwn(delta, "edges")) {
    database.exec("DELETE FROM edges");
    const insertEdge = database.query("INSERT INTO edges (position, data, from_id, to_id, edge_type) VALUES (?, ?, ?, ?, ?)");
    state.edges.forEach((edge: any, position) => insertEdge.run(position, JSON.stringify(edge), edge?.from ?? null, edge?.to ?? null, edge?.type ?? null));
  }

  const appendedLogRows = makeStoredLogAppendRows(database, state, previous, delta);
  const insertLog = database.query("INSERT INTO log (position, data, from_revision, state_revision, delta) VALUES (?, ?, ?, ?, ?)");
  const updateLogDelta = database.query("UPDATE log SET from_revision = ?, state_revision = ?, delta = ? WHERE position = ?");
  for (const row of appendedLogRows) {
    if (row.existing) { updateLogDelta.run(row.from_revision, row.state_revision, row.delta, row.position); }
    else { insertLog.run(row.position, row.data, row.from_revision, row.state_revision, row.delta); }
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

export const SQLITE_EDGE_INVARIANT_RULES = Object.freeze([
  "edge-object",
  "endpoint-shape",
  "type-shape",
  "self-edge",
  "endpoint-exists",
  "allowed-type",
  "kind-compatibility",
  "unique-edge",
  "blocks-acyclic",
] as const);

function hasUnreadableSqliteMutationRows(database): boolean {
  return Boolean(database.query(`
    SELECT 1 FROM nodes WHERE json_valid(data) = 0
    UNION ALL SELECT 1 FROM edges WHERE json_valid(data) = 0
    UNION ALL SELECT 1 FROM initiatives WHERE json_valid(data) = 0
    UNION ALL SELECT 1 FROM meta WHERE key = 'extras' AND json_valid(value) = 0
    LIMIT 1
  `).get());
}

function hasUnreadableSqliteLog(database): boolean {
  return Boolean(database.query("SELECT 1 FROM log WHERE json_valid(data) = 0 LIMIT 1").get());
}

function hasMissingNodeBody(database): boolean {
  return Boolean(database.query(`
    SELECT 1 FROM nodes AS n
    LEFT JOIN node_body AS b ON b.hash = n.body_hash
    WHERE n.body_hash IS NOT NULL AND b.hash IS NULL
    LIMIT 1
  `).get());
}

// Cache the global edge proof by a trigger-maintained epoch; ordinary task/status/log writes leave it valid.
function edgeValidationState(database): { epoch: number; checked: number } | null {
  const rows = database.query("SELECT key, value FROM sync_state WHERE key IN (?, ?)")
    .all(EDGE_VALIDATION_EPOCH_KEY, EDGE_VALIDATION_CHECKED_KEY);
  const values = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  const epoch = values[EDGE_VALIDATION_EPOCH_KEY];
  const checked = values[EDGE_VALIDATION_CHECKED_KEY];
  return Number.isInteger(epoch) && Number.isInteger(checked) ? { epoch, checked } : null;
}

// Call only after full-state validation or successful SQL validation of the current epoch.
function markEdgeValidationCurrent(database, epoch?: number) {
  const current = epoch ?? database.query("SELECT value FROM sync_state WHERE key = ?").get(EDGE_VALIDATION_EPOCH_KEY)?.value;
  if (!Number.isInteger(current)) { return; }
  database.query("INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(EDGE_VALIDATION_CHECKED_KEY, current);
}

function validateSqliteMutationStructure(database): boolean {
  const malformedOrStale = database.query(`
    SELECT position, data FROM edges INDEXED BY idx_edges_json_fields
    WHERE json_type(data) IS NOT 'object'
      OR json_type(data, '$.from') IS NOT 'text'
      OR json_type(data, '$.to') IS NOT 'text'
      OR json_type(data, '$.type') IS NOT 'text'
      OR from_id = '' OR to_id = '' OR edge_type = ''
      OR from_id IS NOT json_extract(data, '$.from')
      OR to_id IS NOT json_extract(data, '$.to')
      OR edge_type IS NOT json_extract(data, '$.type')
    ORDER BY position
    LIMIT 1
  `).get();

  let shapeInvalidEdge: { position: number; data: string } | null = null;
  if (malformedOrStale) {
    const edge = JSON.parse(malformedOrStale.data);
    const shapeIsInvalid = !edge || typeof edge !== "object" || Array.isArray(edge)
      || typeof edge.from !== "string" || edge.from.length === 0
      || typeof edge.to !== "string" || edge.to.length === 0
      || typeof edge.type !== "string" || edge.type.length === 0;
    if (shapeIsInvalid) { shapeInvalidEdge = malformedOrStale; }
    else { return false; }
  }

  const invalidEdge = database.query(`
    SELECT e.position, e.data
    FROM edges AS e
    LEFT JOIN nodes AS f INDEXED BY idx_nodes_id_shape_kind ON f.id = e.from_id
    LEFT JOIN nodes AS t INDEXED BY idx_nodes_id_shape_kind ON t.id = e.to_id
    WHERE e.from_id IS NULL OR e.to_id IS NULL
      OR e.from_id = e.to_id
      OR f.id IS NULL OR t.id IS NULL
      OR json_type(f.data) IN ('null', 'false')
      OR (json_type(f.data) IN ('integer', 'real') AND json_extract(f.data, '$') = 0)
      OR (json_type(f.data) = 'text' AND json_extract(f.data, '$') = '')
      OR json_type(t.data) IN ('null', 'false')
      OR (json_type(t.data) IN ('integer', 'real') AND json_extract(t.data, '$') = 0)
      OR (json_type(t.data) = 'text' AND json_extract(t.data, '$') = '')
      OR e.edge_type NOT IN (${EDGE_TYPES.map((type) => `'${type}'`).join(", ")})
      OR (e.edge_type = 'BLOCKS' AND (
        json_extract(f.data, '$.kind') IS NOT 'resolvable'
        OR json_extract(t.data, '$.kind') IS NOT 'resolvable'
      ))
      OR (e.edge_type = 'SUPERSEDES' AND NOT (
        (json_type(f.data, '$.kind') IS NULL AND json_type(t.data, '$.kind') IS NULL)
        OR (
          json_type(f.data, '$.kind') IN ('integer', 'real')
          AND json_type(t.data, '$.kind') IN ('integer', 'real')
          AND json_extract(f.data, '$.kind') IS json_extract(t.data, '$.kind')
        )
        OR (
          json_type(f.data, '$.kind') = json_type(t.data, '$.kind')
          AND json_type(f.data, '$.kind') IN ('text', 'true', 'false', 'null')
          AND json_extract(f.data, '$.kind') IS json_extract(t.data, '$.kind')
        )
      ))
    ORDER BY e.position
    LIMIT 1
  `).get();
  const ambiguousEdgeKey = database.query(`
    SELECT 1 FROM edges WHERE instr(from_id, '|') > 0 OR instr(to_id, '|') > 0 LIMIT 1
  `).get();
  if (ambiguousEdgeKey) { return false; }

  const duplicateEdge = database.query(`
    WITH duplicate_sets AS (
      SELECT from_id, to_id, edge_type, MIN(position) AS first_position
      FROM edges
      GROUP BY from_id, to_id, edge_type
      HAVING COUNT(*) > 1
    )
    SELECT MIN(e.position) AS position
    FROM edges AS e
    JOIN duplicate_sets AS d
      ON e.from_id IS d.from_id AND e.to_id IS d.to_id AND e.edge_type IS d.edge_type
    WHERE e.position > d.first_position
  `).get();
  const duplicatePosition = Number.isInteger(duplicateEdge?.position) ? duplicateEdge.position : null;
  const shapePosition = shapeInvalidEdge ? shapeInvalidEdge.position : null;
  const earliestErrorPosition = [invalidEdge?.position, duplicatePosition, shapePosition]
    .filter(Number.isInteger).reduce((minimum, position) => Math.min(minimum, position), Number.POSITIVE_INFINITY);
  if (shapeInvalidEdge && shapePosition !== null && shapePosition === earliestErrorPosition) {
    validateEdge({ nodes: Object.create(null) }, JSON.parse(shapeInvalidEdge.data), "readState");
    return false;
  }
  if (invalidEdge && invalidEdge.position === earliestErrorPosition) {
    const edge = JSON.parse(invalidEdge.data);
    const nodes = Object.create(null);
    if (edge && typeof edge === "object" && !Array.isArray(edge)) {
      const endpointRows = database.query("SELECT id, data FROM nodes WHERE id IN (?, ?)").all(edge.from, edge.to);
      for (const row of endpointRows) { nodes[row.id] = JSON.parse(row.data); }
    }
    validateEdge({ nodes }, edge, "readState");
    return false;
  }
  if (duplicatePosition !== null && duplicatePosition === earliestErrorPosition) {
    const edge = JSON.parse(database.query("SELECT data FROM edges WHERE position = ?").get(duplicatePosition).data);
    throwV2(
      "DUPLICATE_EDGE",
      `readState: edge ${edge.type} ${edge.from} -> ${edge.to} is duplicated`,
      { from: edge.from, to: edge.to, type: edge.type },
    );
  }

  // A directed cycle contains an edge against node insertion order. The CTE only detects it;
  // the canonical validator supplies its stable DFS path and exact error details.
  const cycle = database.query(`
    WITH RECURSIVE reachable(start_id, node_id) AS (
      SELECT e.from_id, e.to_id
      FROM edges AS e
      JOIN nodes AS source ON source.id = e.from_id
      JOIN nodes AS target ON target.id = e.to_id
      WHERE e.edge_type = 'BLOCKS' AND source.position >= target.position
      UNION
      SELECT reachable.start_id, e.to_id
      FROM reachable
      JOIN edges AS e ON e.from_id = reachable.node_id AND e.edge_type = 'BLOCKS'
      WHERE e.to_id IS NOT NULL
    )
    SELECT start_id FROM reachable WHERE start_id = node_id LIMIT 1
  `).get();
  if (cycle) {
    const state = readStateInTransaction(database);
    validateStateInvariants(state, "readState");
    return false;
  }
  return true;
}

export async function readSqliteMutationMetadata(file: string) {
  return withReadTransaction(file, null, (database) => {
    const rows = database.query("SELECT key, value FROM meta WHERE key IN ('version', 'revision', ?, ?)").all(ROOT_ORDER_KEY, MAX_NODE_REVISION_KEY);
    const metadata = Object.fromEntries(rows.map(({ key, value }) => [key, JSON.parse(value)]));
    if (metadata.version === undefined) { return null; }
    if (metadata.version !== 1) { throw new Error("storage: SQLite store requires canonical schema-1 state"); }
    const validationState = edgeValidationState(database);
    if (!validationState || hasMissingNodeBody(database) || hasUnreadableSqliteMutationRows(database)) {
      return { version: metadata.version, revision: metadata.revision, closureSafe: false };
    }
    if (validationState.epoch !== validationState.checked && hasUnreadableSqliteLog(database)) {
      return { version: metadata.version, revision: metadata.revision, closureSafe: false };
    }
    if (!Number.isInteger(metadata.revision) || metadata.revision < 0) {
      throwV2("INVALID_EXECUTION_CONTRACT", "readState: state revision must be a non-negative integer", {
        field: "revision", value: metadata.revision,
      });
    }
    const closureSafe = validationState.epoch === validationState.checked
      ? true
      : validateSqliteMutationStructure(database);
    if (closureSafe && validationState.epoch !== validationState.checked) {
      markEdgeValidationCurrent(database, validationState.epoch);
    }
    const maximumNodeRevision = Number.isInteger(metadata[MAX_NODE_REVISION_KEY])
      ? metadata[MAX_NODE_REVISION_KEY]
      : database.query(
        "SELECT COALESCE(MAX(CASE WHEN json_type(data, '$.revision') = 'integer' THEN json_extract(data, '$.revision') ELSE 0 END), 0) AS revision FROM nodes",
      ).get().revision;
    return {
      version: metadata.version,
      revision: metadata.revision,
      maximumNodeRevision,
      rootOrder: Array.isArray(metadata[ROOT_ORDER_KEY]) ? metadata[ROOT_ORDER_KEY] : null,
      closureSafe,
    };
  });
}

function hasStoredState(database): boolean {
  return Boolean(database.query("SELECT 1 FROM meta WHERE key = 'version'").get());
}

export async function readSqliteHasState(file: string): Promise<boolean> {
  return withReadTransaction(file, false, hasStoredState);
}

export async function readSqliteNodeMetadata(file: string, filters: { kind?: string; omit?: string[]; fields?: string[] } = {}): Promise<Record<string, Record<string, unknown>> | null> {
  return withReadTransaction(file, null, (database) => {
    if (!hasStoredState(database)) { return null; }
    const where = filters.kind === undefined ? "" : " WHERE json_extract(data, '$.kind') = ?";
    const omittedPaths = (filters.omit ?? []).map((field) => `$.${field}`);
    const projectedFields = filters.fields ?? [];
    let dataExpression = "data";
    const params: string[] = [];
    if (projectedFields.length > 0) {
      dataExpression = `json_object(${projectedFields.map((field) => `'${field.replaceAll("'", "''")}', json_extract(data, '$.${field.replaceAll("'", "''")}')`).join(", ")})`;
    } else if (omittedPaths.length > 0) {
      dataExpression = `json_remove(data, ${omittedPaths.map(() => "?").join(", ")})`;
      params.push(...omittedPaths);
    }
    if (filters.kind !== undefined) {params.push(filters.kind);}
    const rows = database.query(`SELECT id, ${dataExpression} AS data FROM nodes${where} ORDER BY position`)
      .all(...params);
    return Object.fromEntries(rows.map(({ id, data }) => [id, JSON.parse(data)]));
  });
}

export async function readSqliteKnowledgeCandidates(file: string, target: { id?: unknown; domain?: unknown; tags?: unknown; initiative?: unknown }): Promise<Record<string, Record<string, unknown>> | null> {
  return withReadTransaction(file, null, (database) => {
    if (!hasStoredState(database)) { return null; }
    const matches: string[] = [];
    const params: unknown[] = [];
    const addArrayMatch = (scopeField: string, value: unknown) => {
      if (typeof value !== "string" || value.length === 0) { return; }
      matches.push(`EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(n.data, '$.scope.${scopeField}') = 'array' THEN json_extract(n.data, '$.scope.${scopeField}') ELSE '[]' END) AS scoped WHERE scoped.type = 'text' AND scoped.value = ?)`);
      params.push(value);
    };
    addArrayMatch("node_ids", target.id);
    addArrayMatch("domains", target.domain);
    addArrayMatch("initiatives", target.initiative);
    if (Array.isArray(target.tags) && target.tags.length > 0) {
      matches.push(`EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_type(n.data, '$.scope.tags') = 'array' THEN json_extract(n.data, '$.scope.tags') ELSE '[]' END) AS scoped
        JOIN json_each(?) AS target_tag ON scoped.type = target_tag.type AND scoped.value IS target_tag.value
        WHERE scoped.type IN ('text', 'integer', 'real', 'true', 'false', 'null')
      )`);
      params.push(JSON.stringify(target.tags));
    }
    if (matches.length === 0) { return {}; }
    const fields = ["id", "kind", "domain", "tags", "initiative", "scope"];
    const projected = `json_object(${fields.map((field) => `'${field}', json_extract(n.data, '$.${field}')`).join(", ")})`;
    const rows = database.query(`SELECT n.id, ${projected} AS data FROM nodes AS n WHERE json_extract(n.data, '$.kind') = 'knowledge' AND (${matches.join(" OR ")}) ORDER BY n.position`)
      .all(...params);
    return Object.fromEntries(rows.map(({ id, data }) => [id, JSON.parse(data)]));
  });
}

export async function readSqliteInitiatives(file: string): Promise<Record<string, Record<string, unknown>> | null> {
  return withReadTransaction(file, null, (database) => {
    if (!hasStoredState(database)) { return null; }
    return Object.fromEntries(database.query("SELECT name, data FROM initiatives ORDER BY name").all()
      .map(({ name, data }) => [name, JSON.parse(data)]));
  });
}

export async function readSqliteLogEntries(file: string, filters: { action?: string; agent?: string; node?: string } = {}): Promise<unknown[] | null> {
  return withReadTransaction(file, null, (database) => {
    if (!hasStoredState(database)) { return null; }
    const conditions: string[] = [];
    const params: string[] = [];
    for (const field of ["action", "agent", "node"] as const) {
      if (filters[field]) {
        conditions.push(`json_extract(data, '$.${field}') = ?`);
        params.push(filters[field]!);
      }
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    return database.query(`SELECT data FROM log${where} ORDER BY position`).all(...params)
      .map(({ data }) => JSON.parse(data));
  });
}

export async function readSqliteLogForNode(file: string, id: string): Promise<unknown[] | null> {
  return withReadTransaction(file, null, (database) => {
    if (!hasStoredState(database)) { return null; }
    return database.query(
      "SELECT data FROM log WHERE json_extract(data, '$.node') = ? OR (json_type(data, '$.note') = 'text' AND instr(json_extract(data, '$.note'), ?) > 0) ORDER BY position",
    ).all(id, id).map(({ data }) => JSON.parse(data));
  });
}

function searchGlobPattern(query: string): string {
  const pattern = [...query].map((character) => {
    const variants = new Set([character, character.toLowerCase(), character.toUpperCase()].filter((value) => [...value].length === 1));
    if (variants.size > 1 && ![...variants].some((value) => "][-^".includes(value))) {
      return `[${[...variants].join("")}]`;
    }
    if (character === "*") { return "[*]"; }
    if (character === "?") { return "[?]"; }
    if (character === "[") { return "[[]"; }
    if (character === "]") { return "[]]"; }
    return character;
  }).join("");
  return `*${pattern}*`;
}

function searchCandidateRows(database, query: string, all: boolean) {
  const lower = query.toLowerCase();
  const pattern = searchGlobPattern(query);
  return database.query(`
    WITH searchable AS (
      SELECT n.id, n.data, n.body_hash, n.position, b.body,
        (SELECT json_group_array(target) FROM (
          SELECT CASE WHEN ref.type = 'object' THEN json_extract(ref.value, '$.target') ELSE NULL END AS target
          FROM json_each(n.data, '$.refs') AS ref ORDER BY ref.key
        )) AS ref_targets
      FROM nodes AS n LEFT JOIN node_body AS b ON b.hash = n.body_hash
      WHERE json_extract(n.data, '$.kind') = 'knowledge'
        AND (? = 1 OR COALESCE(NULLIF(json_extract(n.data, '$.status'), ''), 'active') = 'active')
    )
    SELECT id, data, body_hash, body
    FROM searchable
    WHERE instr(lower(data), ?) > 0 OR data GLOB ?
      OR instr(lower(COALESCE(body, '')), ?) > 0 OR COALESCE(body, '') GLOB ?
      OR instr(lower(COALESCE(ref_targets, '')), ?) > 0 OR COALESCE(ref_targets, '') GLOB ?
    ORDER BY position
  `).all(all ? 1 : 0, lower, pattern, lower, pattern, lower, pattern);
}

function hydrateSearchCandidates(rows) {
  return Object.fromEntries(rows.map(({ id, data, body_hash, body }) => {
    const node = JSON.parse(data);
    if (body_hash !== null && body_hash !== undefined) {
      if (body === null || body === undefined) { throw new Error(`storage: missing body with content hash ${body_hash}`); }
      node.body = body;
    }
    return [id, node];
  }));
}

export async function readSqliteSearchCandidates(file: string, query: string, all = false): Promise<Record<string, Record<string, unknown>> | null> {
  return withReadTransaction(file, null, (database) => {
    if (!hasStoredState(database)) { return null; }
    return hydrateSearchCandidates(searchCandidateRows(database, query, all));
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

export async function readSqliteEdges(file: string): Promise<unknown[]> {
  return withReadTransaction(file, [], (database) => database.query("SELECT data FROM edges ORDER BY position")
    .all().map(({ data }) => JSON.parse(data)));
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

export async function readSqliteMutationIncidentEdges(file: string, ids: string[]) {
  const uniqueIds = [...new Set(ids)];
  return withReadTransaction(file, [], (database) => {
    if (uniqueIds.length === 0) { return []; }
    const placeholders = uniqueIds.map(() => "?").join(",");
    return database.query(
      `SELECT position, data FROM edges WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders}) ORDER BY position`,
    ).all(...uniqueIds, ...uniqueIds).map(({ position, data }) => ({ position, edge: JSON.parse(data) }));
  });
}

export async function readSqliteMutationEdges(file: string, ids: string[], direction: "from" | "to", type: string) {
  const uniqueIds = [...new Set(ids)];
  return withReadTransaction(file, [], (database) => {
    if (uniqueIds.length === 0) { return []; }
    const column = direction === "from" ? "from_id" : "to_id";
    const placeholders = uniqueIds.map(() => "?").join(",");
    return database.query(
      `SELECT position, data FROM edges WHERE ${column} IN (${placeholders}) AND edge_type = ? ORDER BY position`,
    ).all(...uniqueIds, type).map(({ position, data }) => ({ position, edge: JSON.parse(data) }));
  });
}

export async function readSqliteInitiativeNames(file: string): Promise<string[]> {
  return withReadTransaction(file, [], (database) => database.query("SELECT name FROM initiatives ORDER BY position")
    .all().map(({ name }) => name));
}

export async function readSqliteInitiativesByNames(file: string, names: string[]): Promise<Record<string, Record<string, unknown>>> {
  const uniqueNames = [...new Set(names)];
  return withReadTransaction(file, {}, (database) => {
    if (uniqueNames.length === 0) { return {}; }
    const rows = database.query(
      `SELECT name, data FROM initiatives WHERE name IN (${uniqueNames.map(() => "?").join(",")}) ORDER BY position`,
    ).all(...uniqueNames);
    return Object.fromEntries(rows.map(({ name, data }) => [name, JSON.parse(data)]));
  });
}

export async function readSqliteLogSince(file: string, revision: number): Promise<unknown[]> {
  if (!Number.isSafeInteger(revision) || revision < 0) { throw new TypeError("storage: revision must be a non-negative safe integer"); }
  return withReadTransaction(file, [], (database) => database.query(
    "SELECT data FROM log INDEXED BY idx_log_state_revision_position WHERE state_revision > ? ORDER BY position",
  ).all(revision).map(({ data }) => JSON.parse(data)));
}

export async function readSqliteCounts(file: string, filters: { kind?: string; subkind?: string; status?: string; statusDefault?: string; initiative?: string; domain?: string; claimedBy?: string } = {}) {
  return withReadTransaction(file, { total: 0, byKind: {}, bySubkind: {}, byStatus: {} }, (database) => {
    const conditions: string[] = [];
    const params: string[] = [];
    for (const field of ["kind", "subkind", "status"] as const) {
      if (filters[field] !== undefined) {
        conditions.push(field === "status" && filters.statusDefault !== undefined
          ? `CASE WHEN json_extract(data, '$.status') IS NULL OR json_extract(data, '$.status') = '' OR (json_type(data, '$.status') IN ('integer', 'real', 'false') AND json_extract(data, '$.status') = 0) THEN ? ELSE json_extract(data, '$.status') END = ?`
          : `json_extract(data, '$.${field}') = ?`);
        if (field === "status" && filters.statusDefault !== undefined) {params.push(filters.statusDefault);}
        params.push(filters[field]!);
      }
    }
    for (const field of ["initiative", "domain"] as const) {
      if (filters[field] !== undefined) {
        conditions.push(`json_extract(data, '$.${field}') = ?`);
        params.push(filters[field]!);
      }
    }
    if (filters.claimedBy !== undefined) {
      conditions.push("CASE WHEN json_extract(data, '$.claim.by') IS NULL OR json_extract(data, '$.claim.by') = '' OR (json_type(data, '$.claim.by') IN ('integer', 'real', 'false') AND json_extract(data, '$.claim.by') = 0) THEN json_extract(data, '$.claimed_by') ELSE json_extract(data, '$.claim.by') END = ?");
      params.push(filters.claimedBy);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    // Unfiltered counts intentionally aggregate every node; only grouped scalar rows reach JavaScript.
    const rows = database.query(
      `SELECT json_extract(data, '$.kind') AS kind, json_extract(data, '$.subkind') AS subkind, json_extract(data, '$.status') AS status, COUNT(*) AS count FROM nodes${where} GROUP BY kind, subkind, status ORDER BY MIN(position)`,
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

export async function writeSqliteMutation(file: string, mutation: {
  previousRevision: number;
  revision: number;
  nodes: { upsert: Record<string, unknown>; remove?: string[] };
  edges: { add?: unknown[]; remove?: unknown[] };
  initiatives: { upsert?: Record<string, unknown>; remove?: string[] };
  logEntry: unknown;
}) {
  const database = activeDatabase(file);
  if (!database) { throw new Error("kernel mutation writes require an active SQLite transaction"); }
  const metadata = Object.fromEntries(database.query("SELECT key, value FROM meta").all()
    .map(({ key, value }) => [key, JSON.parse(value)]));
  if (metadata.version !== 1) { throw new Error("writeState: SQLite store requires canonical schema-1 state"); }
  if (metadata.revision !== mutation.previousRevision) {
    throw new Error(`storage: mutation snapshot revision ${mutation.previousRevision} does not match stored revision ${metadata.revision}`);
  }
  if (!Number.isSafeInteger(mutation.revision) || mutation.revision <= mutation.previousRevision) {
    throw new Error("storage: mutation revision must advance the canonical state revision");
  }
  const priorMaximumNodeRevision = Number.isInteger(metadata[MAX_NODE_REVISION_KEY])
    ? metadata[MAX_NODE_REVISION_KEY]
    : database.query(
      "SELECT COALESCE(MAX(CASE WHEN json_type(data, '$.revision') = 'integer' THEN json_extract(data, '$.revision') ELSE 0 END), 0) AS revision FROM nodes",
    ).get().revision;

  const nodeUpserts = mutation.nodes.upsert || {};
  const nodeRemovals = mutation.nodes.remove || [];
  const oldNodeRows = new Map<string, { body_hash: string | null }>();
  const findNode = database.query("SELECT body_hash FROM nodes WHERE id = ?");
  for (const id of [...Object.keys(nodeUpserts), ...nodeRemovals]) {
    const row = findNode.get(id);
    if (row) { oldNodeRows.set(id, row); }
  }
  const insertNode = database.query("INSERT INTO nodes (id, position, data, body_hash) VALUES (?, ?, ?, ?)");
  const updateNode = database.query("UPDATE nodes SET data = ?, body_hash = ? WHERE id = ?");
  const knownBodies = new Map<string, string>();
  let nextNodePosition: number | undefined;
  for (const [id, node] of Object.entries(nodeUpserts)) {
    const { data, hash } = contentAddressedNode(database, node, knownBodies);
    if (oldNodeRows.has(id)) { updateNode.run(JSON.stringify(data), hash, id); }
    else {
      if (nextNodePosition === undefined) {
        nextNodePosition = (database.query("SELECT COALESCE(MAX(position), -1) AS position FROM nodes").get().position as number) + 1;
      }
      insertNode.run(id, nextNodePosition++, JSON.stringify(data), hash);
    }
  }
  const deleteNode = database.query("DELETE FROM nodes WHERE id = ?");
  for (const id of nodeRemovals) { deleteNode.run(id); }
  const deleteBody = database.query("DELETE FROM node_body WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM nodes WHERE body_hash = ?)");
  for (const { body_hash: hash } of oldNodeRows.values()) {
    if (typeof hash === "string") { deleteBody.run(hash, hash); }
  }
  const maximumNodeRevisionAfterMutation = nodeRemovals.length > 0
    ? database.query(
      "SELECT COALESCE(MAX(CASE WHEN json_type(data, '$.revision') = 'integer' THEN json_extract(data, '$.revision') ELSE 0 END), 0) AS revision FROM nodes",
    ).get().revision
    : Math.max(priorMaximumNodeRevision, maximumNodeRevision(nodeUpserts));

  const edgeAdds = mutation.edges.add || [];
  const edgeRemoves = mutation.edges.remove || [];
  const deleteEdge = database.query("DELETE FROM edges WHERE from_id = ? AND to_id = ? AND edge_type = ?");
  for (const edge of edgeRemoves as Array<Record<string, unknown>>) {
    deleteEdge.run(edge.from, edge.to, edge.type);
  }
  if (edgeAdds.length > 0) {
    let position = (database.query("SELECT COALESCE(MAX(position), -1) AS position FROM edges").get().position as number) + 1;
    const insertEdge = database.query("INSERT INTO edges (position, data, from_id, to_id, edge_type) VALUES (?, ?, ?, ?, ?)");
    for (const edge of edgeAdds as Array<Record<string, unknown>>) {
      insertEdge.run(position++, JSON.stringify(edge), edge.from, edge.to, edge.type);
    }
  }

  const initiativeUpserts = mutation.initiatives.upsert || {};
  const initiativeRemovals = mutation.initiatives.remove || [];
  const findInitiative = database.query("SELECT position FROM initiatives WHERE name = ?");
  const insertInitiative = database.query("INSERT INTO initiatives (name, position, data) VALUES (?, ?, ?)");
  const updateInitiative = database.query("UPDATE initiatives SET data = ? WHERE name = ?");
  let nextInitiativePosition: number | undefined;
  for (const [name, initiative] of Object.entries(initiativeUpserts)) {
    const existing = findInitiative.get(name);
    if (existing) { updateInitiative.run(JSON.stringify(initiative), name); }
    else {
      if (nextInitiativePosition === undefined) {
        nextInitiativePosition = (database.query("SELECT COALESCE(MAX(position), -1) AS position FROM initiatives").get().position as number) + 1;
      }
      insertInitiative.run(name, nextInitiativePosition++, JSON.stringify(initiative));
    }
  }
  const deleteInitiative = database.query("DELETE FROM initiatives WHERE name = ?");
  for (const name of initiativeRemovals) { deleteInitiative.run(name); }

  database.query("INSERT INTO meta (key, value) VALUES ('revision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(mutation.revision));
  database.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(MAX_NODE_REVISION_KEY, JSON.stringify(maximumNodeRevisionAfterMutation));

  const delta: Record<string, unknown> = {
    from_revision: mutation.previousRevision,
    revision: mutation.revision,
    set: {},
    remove: [],
    nodes: { upsert: nodeUpserts, remove: nodeRemovals },
    initiatives: { upsert: initiativeUpserts, remove: initiativeRemovals },
    log: { append: [mutation.logEntry] },
  };
  if (edgeAdds.length > 0 || edgeRemoves.length > 0) {
    delta.edges = readRows(database, "edges", "position").map(({ data }) => JSON.parse(data));
  }
  if (readDeltaFloor(database) === null) { writeDeltaFloor(database, mutation.previousRevision); }
  const position = (database.query("SELECT COALESCE(MAX(position), -1) AS position FROM log").get().position as number) + 1;
  database.query("INSERT INTO log (position, data, from_revision, state_revision, delta) VALUES (?, ?, ?, ?, ?)")
    .run(position, JSON.stringify(mutation.logEntry), mutation.previousRevision, mutation.revision, JSON.stringify(delta));
  return mutation.revision;
}

export async function writeSqliteState(file: string, state: unknown, previousState?: Record<string, unknown> | null) {
  assertCanonicalState(state, "writeState");
  const active = activeDatabase(file);
  if (active) {
    let previous: SqliteState | null;
    if (previousState === undefined) {
      previous = readStateInTransaction(active);
    } else {
      previous = isDeltaState(previousState) ? previousState : null;
    }
    const delta = previous ? createStateDelta(previous, state, new Map()) : null;
    if (delta && canApplyStateDelta(active, previous, state, delta)) { applyStateDelta(active, state, previous!, delta); }
    else {
      let replacementPrevious = previous;
      const storedRevision = active.query("SELECT value FROM meta WHERE key = 'revision'").get();
      if (previous && storedRevision && JSON.parse(storedRevision.value) !== previous.revision) {
        replacementPrevious = readStateInTransaction(active);
      } else if (previous && !storedRevision && hasUnversionedRows(active)) {
        replacementPrevious = null;
      }
      replaceRows(active, state, replacementPrevious);
    }
    markEdgeValidationCurrent(active);
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
  const draft = structuredClone(current);
  const next = mutator(draft);
  if (next === undefined) { throw new Error("updateState mutator must return the new state object"); }
  await writeSqliteState(file, next, current);
  return next;
}
