import test from "node:test";
import assert from "node:assert/strict";
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
      "T-sqlite": { id: "T-sqlite", kind: "resolvable", subkind: "task", title: "SQLite", body: "body stays in node JSON", status: "open" },
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
      assert.equal(expected.nodes["T-sqlite"].body, "body stays in node JSON");
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
    assert.equal(database.query("PRAGMA user_version").get().user_version, 1);
    const { SQLITE_PRAGMAS } = await import("../src/storage/sqlite/schema.ts");
    assert.match(SQLITE_PRAGMAS, /PRAGMA synchronous = NORMAL/i);
    assert.match(SQLITE_PRAGMAS, /PRAGMA busy_timeout = 5000/i);
    const tables = database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name);
    for (const table of ["meta", "nodes", "edges", "initiatives", "log"]) { assert.ok(tables.includes(table), table); }
    const storedNode = database.query("SELECT data FROM nodes WHERE id = ?").get("T-export");
    assert.equal(JSON.parse(storedNode.data).body, "body");
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
  } finally {
    await rmTempProject(dir);
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
