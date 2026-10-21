import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createTempProject,
  rmTempProject,
  runCli,
  jsonStateFilePath,
  writeCanonicalState,
  writeLegacyJsonState,
} from "./helpers.ts";

const SQLITE_MODULE = "bun:sqlite";

const canonicalState = () => ({
  version: 1,
  revision: 0,
  nodes: {},
  edges: [],
  initiatives: {},
  log: [],
});

function mutateCanonicalState(state) {
  return {
    ...state,
    revision: state.revision + 1,
    initiatives: { core: { desc: "SQLite store", created_at: "2026-10-20T00:00:00.000Z" } },
    nodes: {
      "T-sqlite": { id: "T-sqlite", kind: "resolvable", subkind: "task", title: "SQLite", body: "body is content-addressed", status: "open" },
    },
    log: [{ action: "created", node: "T-sqlite" }],
  };
}

async function assertSqliteDatabase(file) {
  const { Database } = await import(SQLITE_MODULE);
  const database = new Database(file);
  try {
    assert.equal(database.query("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(database.query("PRAGMA user_version").get().user_version, 3);
    const { SQLITE_PRAGMAS } = await import("../src/storage/sqlite/schema.ts");
    assert.match(SQLITE_PRAGMAS, /PRAGMA synchronous = NORMAL/i);
    assert.match(SQLITE_PRAGMAS, /PRAGMA busy_timeout = 5000/i);
    const tables = database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name);
    for (const table of ["meta", "nodes", "node_body", "edges", "initiatives", "log", "sync_state"]) { assert.ok(tables.includes(table), table); }
  } finally { database.close(); }
}

test("SQLite state store creates, mutates, and reads canonical state", async () => {
  const { readState, updateState, writeState } = await import("../src/storage/state.ts");
  const dir = await createTempProject();
  try {
    const initial = canonicalState();
    await writeState(dir, initial);
    assert.deepEqual(await readState(dir), initial);
    const expected = await updateState(dir, mutateCanonicalState);
    assert.deepEqual(await readState(dir), expected);
    assert.equal(expected.nodes["T-sqlite"].body, "body is content-addressed");
  } finally { await rmTempProject(dir); }
});

test("SQLite readState can skip audit rows for projections that do not consume them", async () => {
  const { readState, writeState } = await import("../src/storage/state.ts");
  const dir = await createTempProject();
  const state = {
    ...canonicalState(),
    revision: 1,
    nodes: { "T-sqlite": { id: "T-sqlite", kind: "resolvable", subkind: "task", title: "SQLite", status: "open" } },
    log: [{ action: "created", node: "T-sqlite" }],
  };
  try {
    await writeState(dir, state);
    const projection = await readState(dir, { includeBodies: false, includeLog: false });
    assert.deepEqual(projection, { ...state, log: [] });
    const { stateFile } = await import("../src/storage/state.ts");
    const { Database } = await import(SQLITE_MODULE);
    const database = new Database(stateFile(dir));
    try { database.query("UPDATE log SET data = ?").run("{"); }
    finally { database.close(); }
    await assert.rejects(readState(dir, { includeBodies: false, includeLog: false }), SyntaxError);
  } finally { await rmTempProject(dir); }
});

test("state export returns complete schema-1 state from the SQLite database", async () => {
  const dir = await createTempProject();
  const state = {
    ...canonicalState(),
    revision: 3,
    initiatives: { core: { desc: "Export test", created_at: "2026-10-20T00:00:00.000Z" } },
    nodes: { "T-export": { id: "T-export", kind: "resolvable", subkind: "task", title: "Export", body: "body", status: "open" } },
    log: [{ action: "add-task", node: "T-export" }],
    plugins: { "plugin.test": { data: { kept: true } } },
  };
  try {
    const { stateFile } = await import("../src/storage/state.ts");
    await writeCanonicalState(dir, state);
    const result = await runCli(["--project", dir, "state", "export"]);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), state);
    await fs.access(stateFile(dir));
    await assertSqliteDatabase(stateFile(dir));
  } finally { await rmTempProject(dir); }
});

test("normal CLI creation, mutation, reads, and export use SQLite only", async () => {
  const dir = await createTempProject();
  try {
    let result = await runCli(["--project", dir, "init"]);
    assert.equal(result.code, 0, result.stdout);
    result = await runCli(["--project", dir, "add-initiative", "core", "--desc", "SQLite project", "--as", "worker"]);
    assert.equal(result.code, 0, result.stdout);
    result = await runCli(["--project", dir, "add-task", "T-sqlite", "--initiative", "core", "--title", "Use SQLite", "--body", "stored with the node", "--acceptance", "it works", "--blocked-by", "", "--as", "worker"]);
    assert.equal(result.code, 0, result.stdout);

    result = await runCli(["--project", dir, "state", "export"]);
    assert.equal(result.code, 0, result.stdout);
    const exported = JSON.parse(result.stdout);
    assert.equal(exported.version, 1);
    assert.equal(exported.nodes["T-sqlite"].body, "stored with the node");
    assert.equal(exported.initiatives.core.desc, "SQLite project");
    assert.ok(exported.log.length >= 2);
    result = await runCli(["--project", dir, "state"]);
    assert.equal(result.code, 0, result.stdout);
    assert.ok(JSON.parse(result.stdout).nodes["T-sqlite"]);

    const { listProjectIds, stateFile } = await import("../src/storage/state.ts");
    const file = stateFile(dir);
    await fs.access(file);
    await assert.rejects(fs.access(jsonStateFilePath(dir)), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(path.dirname(file), "revision-ledger.json")), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(path.dirname(file), ".lock")), { code: "ENOENT" });
    assert.ok((await listProjectIds()).includes(path.basename(path.dirname(file))));
  } finally { await rmTempProject(dir); }
});

async function assertContentAddressedBodies(file, body) {
  const { Database } = await import(SQLITE_MODULE);
  const database = new Database(file);
  try {
    const bodies = database.query("SELECT hash, body FROM node_body").all();
    assert.deepEqual(bodies, [{ hash: crypto.createHash("sha256").update(body).digest("hex"), body }]);
    const nodes = database.query("SELECT id, data, body_hash FROM nodes ORDER BY id").all();
    assert.equal(nodes.length, 2);
    for (const node of nodes) {
      assert.equal(JSON.parse(node.data).body, null);
      assert.equal(node.body_hash, bodies[0].hash);
    }
  } finally { database.close(); }
}

test("SQLite stores bodies by content hash and show/context hydrate exact text", async () => {
  const dir = await createTempProject();
  const body = "línea 1\nexact body 🌱\n";
  const node = { id: "T-body-a", kind: "resolvable", subkind: "task", title: "A", body, status: "open", initiative: "core" };
  const state = {
    ...canonicalState(),
    initiatives: { core: { desc: "Bodies", created_at: "2026-10-20T00:00:00.000Z" } },
    nodes: { [node.id]: node, "T-body-b": { ...node, id: "T-body-b", title: "B" } },
  };
  try {
    const { readState, stateFile, writeState } = await import("../src/storage/state.ts");
    await writeState(dir, state);
    await assertContentAddressedBodies(stateFile(dir), body);
    assert.equal((await readState(dir)).nodes[node.id].body, body);
    for (const command of ["show", "context"]) {
      const result = await runCli(["--project", dir, command, node.id]);
      assert.equal(result.code, 0, result.stdout);
      const output = JSON.parse(result.stdout);
      if (command === "show") { assert.deepEqual(output, { type: "task", node }); }
      else { assert.equal(output.node.body, body); }
    }
  } finally { await rmTempProject(dir); }
});

test("SQLite status does not query the content-addressed bodies table", async () => {
  const dir = await createTempProject();
  try {
    const { stateFile, writeState } = await import("../src/storage/state.ts");
    await writeState(dir, {
      ...canonicalState(),
      initiatives: { core: { desc: "Bodies", created_at: "2026-10-20T00:00:00.000Z" } },
      nodes: { "T-body": { id: "T-body", kind: "resolvable", subkind: "task", title: "Body", body: "not for status", status: "open", initiative: "core" } },
    });
    const { Database } = await import(SQLITE_MODULE);
    const database = new Database(stateFile(dir));
    try { assert.equal(database.query("SELECT COUNT(*) AS count FROM node_body").get().count, 1); }
    finally { database.close(); }
    const originalQuery = Database.prototype.query;
    const bodyReads: string[] = [];
    Database.prototype.query = function (sql, ...args) {
      if (/\bSELECT\b/i.test(sql) && /\bnode_body\b/i.test(sql)) { bodyReads.push(sql); }
      return originalQuery.call(this, sql, ...args);
    };
    try {
      const result = await runCli(["--project", dir, "status"]);
      assert.equal(result.code, 0, result.stdout);
      assert.deepEqual(bodyReads, []);
    } finally { Database.prototype.query = originalQuery; }
  } finally { await rmTempProject(dir); }
});

async function seedInlineSchemaOneDatabase(file, state) {
  const { Database } = await import(SQLITE_MODULE);
  const database = new Database(file, { create: true });
  try {
    database.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE nodes (id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE edges (position INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE initiatives (name TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE log (position INTEGER PRIMARY KEY, data TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
    const insertMeta = database.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries({
      version: state.version,
      revision: state.revision,
      extras: {},
      __root_order: Object.keys(state),
    })) { insertMeta.run(key, JSON.stringify(value)); }
    database.prepare("INSERT INTO nodes (id, position, data) VALUES (?, ?, ?)").run("T-legacy", 0, JSON.stringify(state.nodes["T-legacy"]));
  } finally { database.close(); }
}

async function seedSchemaTwoDatabase(file, state) {
  const { Database } = await import(SQLITE_MODULE);
  const database = new Database(file, { create: true });
  try {
    database.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE nodes (id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, data TEXT NOT NULL, body_hash TEXT);
      CREATE TABLE node_body (hash TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE edges (position INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE initiatives (name TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE log (position INTEGER PRIMARY KEY, data TEXT NOT NULL);
      PRAGMA user_version = 2;
    `);
    const insertMeta = database.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries({
      version: state.version,
      revision: state.revision,
      extras: {},
      __root_order: Object.keys(state),
    })) { insertMeta.run(key, JSON.stringify(value)); }
    database.prepare("INSERT INTO log (position, data) VALUES (0, ?)").run(JSON.stringify(state.log[0]));
  } finally { database.close(); }
}

test("SQLite v2 migration preserves state and requires a fresh snapshot for old history", async () => {
  const dir = await createTempProject();
  const initial = { ...canonicalState(), revision: 42, log: [{ action: "before-sync" }] };
  try {
    const { readState, stateFile } = await import("../src/storage/state.ts");
    const { readSqliteChangesSince, writeSqliteState } = await import("../src/storage/sqlite/store.ts");
    const file = stateFile(dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await seedSchemaTwoDatabase(file, initial);
    assert.deepEqual(await readState(dir), initial);
    assert.equal((await readSqliteChangesSince(file, 41)).reset_required, true);

    const event = { action: "after-sync", agent: "alice" };
    await writeSqliteState(file, { ...initial, revision: 43, log: [...initial.log, event] });
    const changes = await readSqliteChangesSince(file, 42);
    assert.equal(changes.reset_required, false);
    assert.deepEqual(changes.changes.map(({ entry }) => entry), [event]);
  } finally { await rmTempProject(dir); }
});

test("SQLite upgrades inline schema-1 bodies without changing the exported state", async () => {
  const dir = await createTempProject();
  const body = "legacy inline body";
  const expected = {
    ...canonicalState(),
    nodes: { "T-legacy": { id: "T-legacy", kind: "resolvable", subkind: "task", title: "Legacy", body, status: "open" } },
  };
  try {
    const { readState, stateFile } = await import("../src/storage/state.ts");
    const file = stateFile(dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await seedInlineSchemaOneDatabase(file, expected);
    assert.deepEqual(await readState(dir), expected);
    const { Database } = await import(SQLITE_MODULE);
    const database = new Database(file);
    try {
      assert.equal(database.query("PRAGMA user_version").get().user_version, 3);
      const row = database.query("SELECT data, body_hash FROM nodes WHERE id = ?").get("T-legacy");
      assert.equal(JSON.parse(row.data).body, null);
      assert.equal(database.query("SELECT body FROM node_body WHERE hash = ?").get(row.body_hash).body, body);
    } finally { database.close(); }
  } finally { await rmTempProject(dir); }
});

test("a project with only tasks.json is rejected with explicit migration guidance", async () => {
  const { readState } = await import("../src/storage/state.ts");
  const dir = await createTempProject();
  try {
    await writeLegacyJsonState(dir, canonicalState());
    await assert.rejects(readState(dir), (error: Error & { code?: string }) => {
      assert.equal(error.code, "CLIMIER_SQLITE_MIGRATION_REQUIRED");
      assert.match(error.message, /climier state migrate/);
      return true;
    });
  } finally { await rmTempProject(dir); }
});
