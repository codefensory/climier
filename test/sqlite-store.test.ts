import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createTempProject,
  rmTempProject,
  runCli,
  writeCanonicalState,
} from "./helpers.ts";

const canonicalState = () => ({
  version: 1,
  fence_generation: 1,
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

async function withBackend(backend, fn) {
  const previous = process.env.CLIMIER_STATE_BACKEND;
  if (backend === null) { delete process.env.CLIMIER_STATE_BACKEND; }
  else { process.env.CLIMIER_STATE_BACKEND = backend; }
  try {
    return await fn();
  } finally {
    if (previous === undefined) { delete process.env.CLIMIER_STATE_BACKEND; }
    else { process.env.CLIMIER_STATE_BACKEND = previous; }
  }
}

test("SQLite state store creates, mutates, and reads canonical state", async () => {
  const { readState, updateState, writeState } = await import("../src/storage/state.ts");
  const dir = await createTempProject();
  try {
    await withBackend("sqlite", async () => {
      const initial = canonicalState();
      await writeState(dir, initial);
      assert.deepEqual(await readState(dir), initial);

      const expected = await updateState(dir, mutateCanonicalState);
      assert.deepEqual(await readState(dir), expected);
      assert.equal(expected.nodes["T-sqlite"].body, "body is content-addressed");
    });
  } finally {
    await rmTempProject(dir);
  }
});

async function exportState(projectDir, backend) {
  const result = await runCli(["--project", projectDir, "state", "export"], { env: { CLIMIER_STATE_BACKEND: backend } });
  assert.equal(result.code, 0, result.stdout);
  return result.stdout;
}

async function assertSqliteDatabase(file) {
  const sqliteModule = "bun:sqlite";
  const { Database } = await import(sqliteModule);
  const database = new Database(file);
  try {
    assert.equal(database.query("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(database.query("PRAGMA user_version").get().user_version, 2);
    const { SQLITE_PRAGMAS } = await import("../src/storage/sqlite/schema.ts");
    assert.match(SQLITE_PRAGMAS, /PRAGMA synchronous = NORMAL/i);
    assert.match(SQLITE_PRAGMAS, /PRAGMA busy_timeout = 5000/i);
    const tables = database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name);
    for (const table of ["meta", "nodes", "node_body", "edges", "initiatives", "log"]) { assert.ok(tables.includes(table), table); }
    const storedNode = database.query("SELECT data, body_hash FROM nodes WHERE id = ?").get("T-export");
    assert.equal(JSON.parse(storedNode.data).body, null);
    assert.equal(database.query("SELECT body FROM node_body WHERE hash = ?").get(storedNode.body_hash).body, "body");
  } finally {
    database.close();
  }
}

test("state export returns the complete schema-1 state for SQLite and JSON backends", async () => {
  const sqliteDir = await createTempProject();
  const jsonDir = await createTempProject();
  const state = {
    ...canonicalState(),
    revision: 3,
    initiatives: { core: { desc: "Export test", created_at: "2026-10-20T00:00:00.000Z" } },
    nodes: { "T-export": { id: "T-export", kind: "resolvable", subkind: "task", title: "Export", body: "body", status: "open" } },
    log: [{ action: "add-task", node: "T-export" }],
    plugins: { "plugin.test": { data: { kept: true } } },
  };
  try {
    const { writeState, stateFile } = await import("../src/storage/state.ts");
    await writeCanonicalState(jsonDir, state);
    const jsonExport = await exportState(jsonDir, "json");
    const expected = JSON.parse(jsonExport);
    await withBackend("sqlite", () => writeState(sqliteDir, expected));
    const sqliteExport = await exportState(sqliteDir, "sqlite");
    assert.deepEqual(JSON.parse(sqliteExport), expected);
    assert.equal(sqliteExport, jsonExport);

    const sqliteFile = path.join(process.env.CLIMIER_HOME!, "projects", path.basename(path.dirname(stateFile(sqliteDir))), "state.sqlite");
    await fs.access(sqliteFile);
    await assertSqliteDatabase(sqliteFile);
  } finally {
    await rmTempProject(sqliteDir);
    await rmTempProject(jsonDir);
  }
});

test("SQLite backend supports normal CLI creation, mutation, reads, and export", async () => {
  const dir = await createTempProject();
  const env = { CLIMIER_STATE_BACKEND: "sqlite" };
  try {
    let result = await runCli(["--project", dir, "init"], { env });
    assert.equal(result.code, 0, result.stdout);
    result = await runCli(["--project", dir, "add-initiative", "core", "--desc", "SQLite project", "--as", "worker"], { env });
    assert.equal(result.code, 0, result.stdout);
    result = await runCli(["--project", dir, "add-task", "T-sqlite", "--initiative", "core", "--title", "Use SQLite", "--body", "stored with the node", "--acceptance", "it works", "--blocked-by", "", "--as", "worker"], { env });
    assert.equal(result.code, 0, result.stdout);

    result = await runCli(["--project", dir, "state", "export"], { env });
    assert.equal(result.code, 0, result.stdout);
    const exported = JSON.parse(result.stdout);
    assert.equal(exported.version, 1);
    assert.equal(exported.nodes["T-sqlite"].body, "stored with the node");
    assert.equal(exported.initiatives.core.desc, "SQLite project");
    assert.ok(exported.log.length >= 2);

    result = await runCli(["--project", dir, "state"], { env });
    assert.equal(result.code, 0, result.stdout);
    assert.ok(JSON.parse(result.stdout).nodes["T-sqlite"]);

    const { listProjectIds, stateFile, sqliteStateFile } = await import("../src/storage/state.ts");
    const jsonFile = stateFile(dir);
    const sqliteFile = sqliteStateFile(dir);
    await fs.access(sqliteFile);
    await assert.rejects(fs.access(jsonFile), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(path.dirname(jsonFile), "revision-ledger.json")), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(path.dirname(jsonFile), ".lock")), { code: "ENOENT" });
    await withBackend("sqlite", async () => assert.ok((await listProjectIds()).includes(path.basename(path.dirname(sqliteFile)))));
  } finally {
    await rmTempProject(dir);
  }
});

async function assertContentAddressedBodies(file, body) {
  const sqliteModule = "bun:sqlite";
  const { Database } = await import(sqliteModule);
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
  } finally {
    database.close();
  }
}

async function assertBodyReadCommands(dir, node, body) {
  const { readState } = await import("../src/storage/state.ts");
  const read = await withBackend("sqlite", async () => readState(dir));
  assert.equal(read.nodes[node.id].body, body);
  for (const command of ["show", "context"]) {
    const result = await runCli(["--project", dir, command, node.id], { env: { CLIMIER_STATE_BACKEND: "sqlite" } });
    assert.equal(result.code, 0, result.stdout);
    const output = JSON.parse(result.stdout);
    if (command === "show") { assert.deepEqual(output, { type: "task", node }); }
    else { assert.equal(output.node.body, body); }
  }
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
    const { writeState, sqliteStateFile } = await import("../src/storage/state.ts");
    await withBackend("sqlite", () => writeState(dir, state));
    await assertContentAddressedBodies(sqliteStateFile(dir), body);
    await assertBodyReadCommands(dir, node, body);
  } finally {
    await rmTempProject(dir);
  }
});

test("SQLite status does not query the content-addressed bodies table", async () => {
  const dir = await createTempProject();
  try {
    const { writeState } = await import("../src/storage/state.ts");
    await withBackend("sqlite", () => writeState(dir, {
      ...canonicalState(),
      initiatives: { core: { desc: "Bodies", created_at: "2026-10-20T00:00:00.000Z" } },
      nodes: { "T-body": { id: "T-body", kind: "resolvable", subkind: "task", title: "Body", body: "not for status", status: "open", initiative: "core" } },
    }));

    const sqliteModule = "bun:sqlite";
    const { Database } = await import(sqliteModule);
    const { sqliteStateFile } = await import("../src/storage/state.ts");
    const setupDatabase = new Database(sqliteStateFile(dir));
    try {
      assert.equal(setupDatabase.query("SELECT COUNT(*) AS count FROM node_body").get().count, 1);
    } finally {
      setupDatabase.close();
    }
    const originalQuery = Database.prototype.query;
    const bodyReads: string[] = [];
    Database.prototype.query = function (sql, ...args) {
      if (/\bSELECT\b/i.test(sql) && /\bnode_body\b/i.test(sql)) { bodyReads.push(sql); }
      return originalQuery.call(this, sql, ...args);
    };
    try {
      const result = await runCli(["--project", dir, "status"], { env: { CLIMIER_STATE_BACKEND: "sqlite" } });
      assert.equal(result.code, 0, result.stdout);
      assert.deepEqual(bodyReads, []);
    } finally {
      Database.prototype.query = originalQuery;
    }
  } finally {
    await rmTempProject(dir);
  }
});

async function seedInlineSchemaOneDatabase(file, state) {
  const sqliteModule = "bun:sqlite";
  const { Database } = await import(sqliteModule);
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
      fence_generation: state.fence_generation,
      revision: state.revision,
      extras: {},
      __root_order: Object.keys(state),
    })) { insertMeta.run(key, JSON.stringify(value)); }
    database.prepare("INSERT INTO nodes (id, position, data) VALUES (?, ?, ?)").run("T-legacy", 0, JSON.stringify(state.nodes["T-legacy"]));
  } finally {
    database.close();
  }
}

async function assertMigratedBody(file, body) {
  const sqliteModule = "bun:sqlite";
  const { Database } = await import(sqliteModule);
  const database = new Database(file);
  try {
    assert.equal(database.query("PRAGMA user_version").get().user_version, 2);
    const row = database.query("SELECT data, body_hash FROM nodes WHERE id = ?").get("T-legacy");
    assert.equal(JSON.parse(row.data).body, null);
    assert.equal(database.query("SELECT body FROM node_body WHERE hash = ?").get(row.body_hash).body, body);
  } finally {
    database.close();
  }
}

test("SQLite upgrades inline schema-1 bodies without changing the exported state", async () => {
  const dir = await createTempProject();
  const body = "legacy inline body";
  const expected = {
    ...canonicalState(),
    nodes: { "T-legacy": { id: "T-legacy", kind: "resolvable", subkind: "task", title: "Legacy", body, status: "open" } },
  };
  try {
    const { sqliteStateFile, readState } = await import("../src/storage/state.ts");
    const file = sqliteStateFile(dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await seedInlineSchemaOneDatabase(file, expected);
    const actual = await withBackend("sqlite", async () => readState(dir));
    assert.deepEqual(actual, expected);
    await assertMigratedBody(file, body);
  } finally {
    await rmTempProject(dir);
  }
});

async function assertReadBackendParity(jsonDir, sqliteDir) {
  for (const args of [["status"], ["context", "T-parity"], ["history", "T-parity"]]) {
    const json = await runCli(["--project", jsonDir, ...args], { env: { CLIMIER_STATE_BACKEND: "json" } });
    const sqlite = await runCli(["--project", sqliteDir, ...args], { env: { CLIMIER_STATE_BACKEND: "sqlite" } });
    assert.equal(json.code, 0, json.stdout);
    assert.equal(sqlite.code, 0, sqlite.stdout);
    assert.equal(sqlite.stdout, json.stdout, `${args.join(" ")} differs between JSON and SQLite`);
  }
}

test("status, context, and history output is byte-identical across SQLite and JSON", async () => {
  const sqliteDir = await createTempProject();
  const jsonDir = await createTempProject();
  const state = {
    ...canonicalState(),
    revision: 4,
    initiatives: { core: { desc: "Parity", created_at: "2026-10-20T00:00:00.000Z" } },
    nodes: { "T-parity": { id: "T-parity", kind: "resolvable", subkind: "task", title: "Parity", body: "full body", status: "open", initiative: "core", revision: 5 } },
    log: [{ action: "created", node: "T-parity", at: "2026-10-20T00:00:00.000Z" }],
  };
  try {
    const expected = await writeCanonicalState(jsonDir, state);
    const { writeState } = await import("../src/storage/state.ts");
    await withBackend("sqlite", () => writeState(sqliteDir, expected));
    await assertReadBackendParity(jsonDir, sqliteDir);
  } finally {
    await rmTempProject(sqliteDir);
    await rmTempProject(jsonDir);
  }
});

test("SQLite selection refuses to import an existing JSON project implicitly", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, canonicalState());
    const result = await runCli(["--project", dir, "state", "export"], { env: { CLIMIER_STATE_BACKEND: "sqlite" } });
    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.stdout).error.message, /automatic import is disabled/);
  } finally {
    await rmTempProject(dir);
  }
});

test("JSON remains the default backend", async () => {
  const { readState } = await import("../src/storage/state.ts");
  const dir = await createTempProject();
  const initial = canonicalState();
  try {
    await withBackend(null, async () => {
      const seeded = await writeCanonicalState(dir, initial);
      assert.deepEqual(await readState(dir), seeded);
    });
  } finally {
    await rmTempProject(dir);
  }
});
