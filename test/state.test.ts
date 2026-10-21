import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, writeLegacyJsonState } from "./helpers.ts";

type StateError = { code?: string; message: string; details?: { version?: number; file?: string; hint?: string } };

test("readState returns null if the SQLite database is missing", async () => {
  const { readState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try { assert.equal(await readState(dir), null); }
  finally { await rmTempProject(dir); }
});

test("tasks.json-only projects require explicit migration", async () => {
  const { readState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {
    await writeLegacyJsonState(dir, { version: 1, nodes: {}, edges: [], initiatives: {}, log: [], revision: 0 });
    await assert.rejects(readState(dir), (error) => {
      const stateError = error as StateError;
      return stateError.code === "CLIMIER_SQLITE_MIGRATION_REQUIRED" && /climier state migrate/.test(stateError.message);
    });
  } finally { await rmTempProject(dir); }
});

test("emptyState returns a valid empty canonical schema", async () => {
  const { emptyState } = await importFresh("./storage/state.ts");
  const state = emptyState();
  assert.equal(state.version, 1);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.nodes, {});
  assert.deepEqual(state.edges, []);
  assert.deepEqual(state.initiatives, {});
  assert.deepEqual(state.log, []);
  assert.equal("fence_generation" in state, false);
});

test("writeState and readState round-trip canonical state through SQLite", async () => {
  const { readState, writeState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  const canonical = {
    version: 1,
    revision: 4,
    nodes: { T1: { id: "T1", kind: "resolvable", subkind: "task", title: "stored", status: "open", revision: 4 } },
    edges: [],
    initiatives: { work: { desc: "work", created_at: "2026-01-01T00:00:00.000Z" } },
    log: [],
  };
  try {
    await writeState(dir, canonical);
    assert.deepEqual(await readState(dir), canonical);
  } finally { await rmTempProject(dir); }
});

test("unknown schema versions are rejected on write", async () => {
  const { writeState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {
    await assert.rejects(writeState(dir, { version: 6, nodes: {}, edges: [], initiatives: {}, log: [], revision: 0 }), /SQLite store requires canonical schema-1 state/);
  } finally { await rmTempProject(dir); }
});

test("writeState rejects incomplete canonical schema", async () => {
  const { writeState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {
    await assert.rejects(writeState(dir, { version: 1, nodes: {}, edges: [], initiatives: {} }), /missing 'log' collection/);
  } finally { await rmTempProject(dir); }
});

test("writeState rejects the pre-canonical shape", async () => {
  const { writeState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {
    await assert.rejects(writeState(dir, { version: 1, tasks: {}, decisions: {}, gotchas: {}, initiatives: {}, log: [] }), /missing 'nodes' collection/);
  } finally { await rmTempProject(dir); }
});
