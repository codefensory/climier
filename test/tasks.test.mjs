// tasks: list with filters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("tasks: lists all tasks with their derived status", async () => {
  const { default: tasks } = await importFresh("./commands/tasks.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "a", initiative: "x" };
      s.tasks.T2 = { id: "T2", title: "b", initiative: "y" };
      s.tasks.T3 = { id: "T3", title: "c", initiative: "x", status: "done" };
      return s;
    });
    const out = await tasks({ statePath: dir, flags: {} });
    assert.equal(out.length, 3);
  } finally {
    await rmTempProject(dir);
  }
});

test("tasks: --initiative filter", async () => {
  const { default: tasks } = await importFresh("./commands/tasks.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", initiative: "x" };
      s.tasks.T2 = { id: "T2", initiative: "y" };
      return s;
    });
    const out = await tasks({ statePath: dir, flags: { initiative: "x" } });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "T1");
  } finally {
    await rmTempProject(dir);
  }
});

test("tasks: --status filter (ready|in_progress|done|blocked)", async () => {
  const { default: tasks } = await importFresh("./commands/tasks.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" }; // ready
      s.tasks.T2 = { id: "T2", status: "in_progress" };
      s.tasks.T3 = { id: "T3", status: "done" };
      s.tasks.T4 = { id: "T4", depends_on: ["T3"], status: "done" };
      return s;
    });
    const out = await tasks({ statePath: dir, flags: { status: "ready" } });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "T1");
  } finally {
    await rmTempProject(dir);
  }
});
