// state.mjs: read/write/atomic-write the tasks.json state file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, writeState, readState, importFresh } from "./helpers.mjs";

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
    const sample = { version: 1, tasks: { T1: { id: "T1", title: "x" } } };
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
      s.tasks = s.tasks || {};
      s.tasks.T1 = { id: "T1", title: "first" };
      return s;
    });
    await updateState(dir, (s) => {
      s.tasks.T1.title = "second";
      return s;
    });
    const back = await readState(dir);
    assert.equal(back.tasks.T1.title, "second");
  } finally {
    await rmTempProject(dir);
  }
});

test("updateState creates file if missing", async () => {
  const { updateState, readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks = { T1: { id: "T1" } };
      return s;
    });
    const back = await readState(dir);
    assert.ok(back.tasks.T1);
  } finally {
    await rmTempProject(dir);
  }
});

test("updateState does not corrupt file on mutator error (atomic write)", async () => {
  const { updateState, readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks = { T1: { id: "T1", ok: true } };
      return s;
    });
    await assert.rejects(() =>
      updateState(dir, (s) => {
        throw new Error("boom");
      })
    );
    const back = await readState(dir);
    assert.deepEqual(back.tasks.T1, { id: "T1", ok: true });
  } finally {
    await rmTempProject(dir);
  }
});

test("emptyState returns a valid empty schema", async () => {
  const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  assert.equal(s.version, 1);
  assert.deepEqual(s.tasks, {});
  assert.deepEqual(s.decisions, {});
  assert.deepEqual(s.gotchas, {});
  assert.deepEqual(s.initiatives, {});
  assert.deepEqual(s.log, []);
});
