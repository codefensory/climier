// state.mjs: read/write/atomic-write the tasks.json state file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, stateFilePath } from "./helpers.mjs";

test("readState returns null if file missing", async () => {
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const s = await readState(dir);
    assert.equal(s, null);
  } finally {
    await rmTempProject(dir);
  }
});

test("writeState then readState round-trips", async () => {
  const { writeState: ws } = await importFresh("./state.mjs");
  const { readState: rs } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const sample = { version: 2, nodes: { T1: { id: "T1", title: "x" } }, edges: [], initiatives: {}, log: [] };
    await ws(dir, sample);
    const back = await rs(dir);
    assert.deepEqual(back, sample);
  } finally {
    await rmTempProject(dir);
  }
});

test("updateState applies a mutator function and persists atomically", async () => {
  const { updateState, readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.nodes = s.nodes || {};
      s.nodes.T1 = { id: "T1", title: "first" };
      return s;
    });
    await updateState(dir, (s) => {
      s.nodes.T1.title = "second";
      return s;
    });
    const back = await readState(dir);
    assert.equal(back.nodes.T1.title, "second");
  } finally {
    await rmTempProject(dir);
  }
});

test("updateState creates file if missing", async () => {
  const { updateState, readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.nodes = { T1: { id: "T1" } };
      return s;
    });
    const back = await readState(dir);
    assert.ok(back.nodes.T1);
  } finally {
    await rmTempProject(dir);
  }
});

test("updateState does not corrupt file on mutator error (atomic write)", async () => {
  const { updateState, readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.nodes = { T1: { id: "T1", ok: true } };
      return s;
    });
    await assert.rejects(() =>
      updateState(dir, (s) => {
        throw new Error("boom");
      })
    );
    const back = await readState(dir);
    assert.deepEqual(back.nodes.T1, { id: "T1", ok: true });
  } finally {
    await rmTempProject(dir);
  }
});

test("emptyState returns a valid empty v2 schema", async () => {
  const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  assert.equal(s.version, 2);
  assert.deepEqual(s.nodes, {});
  assert.deepEqual(s.edges, []);
  assert.deepEqual(s.initiatives, {});
  assert.deepEqual(s.log, []);
  // No v1 collections.
  assert.equal(s.tasks, undefined);
  assert.equal(s.decisions, undefined);
  assert.equal(s.gotchas, undefined);
});

// === v1-unsupported behavior =================================================

test("readState throws STATE_V1_UNSUPPORTED with migration steps on a v1 file", async () => {
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    // Bootstrap a v1 state file directly (bypassing writeState, which
    // would now reject it). This mirrors the on-disk reality of a v1
    // project someone is trying to migrate from.
    const fs = await import("node:fs/promises");
    const file = stateFilePath(dir);
    const path = await import("node:path");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      tasks: { T1: { id: "T1", title: "x" } },
      decisions: {}, gotchas: {}, initiatives: {}, log: [],
    }), "utf8");
    let caught;
    try { await readState(dir); } catch (e) { caught = e; }
    assert.ok(caught, "readState should throw on a v1 file");
    assert.equal(caught.code, "STATE_V1_UNSUPPORTED");
    assert.ok(caught.details, "must expose structured details");
    assert.equal(caught.details.version, 1);
    assert.ok(Array.isArray(caught.details.migration_steps) && caught.details.migration_steps.length >= 3,
      "details.migration_steps must list the migration path");
    assert.match(caught.details.hint || "", /init --force/i);
    assert.match(caught.message, /backup/i);
    assert.match(caught.message, /init --force/i);
  } finally { await rmTempProject(dir); }
});

test("readState throws CLIMIER_INCOMPATIBLE_VERSION on a v3+ file", async () => {
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = stateFilePath(dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 3, nodes: {}, edges: [], initiatives: {}, log: [] }), "utf8");
    let caught;
    try { await readState(dir); } catch (e) { caught = e; }
    assert.equal(caught.code, "CLIMIER_INCOMPATIBLE_VERSION");
  } finally { await rmTempProject(dir); }
});

test("writeState rejects a v1-shaped object with a clear error", async () => {
  const { writeState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const v1 = { version: 1, tasks: {}, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
    let caught;
    try { await writeState(dir, v1); } catch (e) { caught = e; }
    assert.ok(caught, "writeState must reject v1");
    assert.match(caught.message, /version 1 is no longer supported/i);
  } finally { await rmTempProject(dir); }
});

test("writeState rejects a v2 object missing the v2 collections", async () => {
  const { writeState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const bad = { version: 2, nodes: {}, edges: [] };
    let caught;
    try { await writeState(dir, bad); } catch (e) { caught = e; }
    assert.ok(caught, "writeState must reject missing collections");
    assert.match(caught.message, /missing '(initiatives|log)' collection/);
  } finally { await rmTempProject(dir); }
});

test("updateState throws STATE_V1_UNSUPPORTED on a v1 file", async () => {
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = stateFilePath(dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      version: 1, tasks: {}, decisions: {}, gotchas: {}, initiatives: {}, log: [],
    }), "utf8");
    let caught;
    try {
      await updateState(dir, (s) => {
        s.tasks = { T1: { id: "T1" } };
        return s;
      });
    } catch (e) { caught = e; }
    assert.equal(caught.code, "STATE_V1_UNSUPPORTED");
    assert.equal(caught.details.version, 1);
  } finally { await rmTempProject(dir); }
});
