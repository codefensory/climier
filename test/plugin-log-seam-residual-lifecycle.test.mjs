// Plugin log seam focused suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState, writeFencedState } from "./helpers.mjs";
import { submitAcceptTask, initProject, seedOpenTask, lastLog } from "./plugin-log-seam-residual-helpers.mjs";

test("accept (task): CLI call writes accept log entry without plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    await seedOpenTask(dir, "T-resolve-1", { status: "in_progress" });
    const state = await readState(dir);
    state.nodes["T-resolve-1"].claim = { by: "alice", at: new Date().toISOString() };
    await writeFencedState(dir, state);
    await submitAcceptTask(dir, "T-resolve-1");
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "task.accept");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.node, "T-resolve-1");
    assert.equal(entry.note, undefined);
    assert.equal(entry.plugin_id, undefined);
  } finally {
    await rmTempProject(dir);
  }
});
test("accept (task): direct CLI adapter keeps the log entry free of plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    await seedOpenTask(dir, "T-resolve-2", { status: "in_progress" });
    const state = await readState(dir);
    state.nodes["T-resolve-2"].claim = { by: "alice", at: new Date().toISOString() };
    await writeFencedState(dir, state);
    await submitAcceptTask(dir, "T-resolve-2", { as: "alice", note: "done", pluginId: "example.audit" });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "task.accept");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.plugin_id, undefined);
    assert.equal(entry.note, undefined);
  } finally {
    await rmTempProject(dir);
  }
});
test("add-note: CLI call writes add-note log entry without plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    await seedOpenTask(dir, "T-note-1");
    const { default: addNote } = await importFresh("./cli/commands/add-note.mjs");
    await addNote({
      statePath: dir,
      flags: { as: "alice" },
      positional: ["T-note-1", "context note"],
    });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "add-note");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.node, "T-note-1");
    assert.equal(entry.note, "context note");
    assert.equal(entry.plugin_id, undefined);
  } finally {
    await rmTempProject(dir);
  }
});
test("add-note: ctx.pluginId propagates to the log entry as plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    await seedOpenTask(dir, "T-note-2");
    const { default: addNote } = await importFresh("./cli/commands/add-note.mjs");
    await addNote({
      statePath: dir,
      flags: { as: "alice" },
      positional: ["T-note-2", "context note"],
      pluginId: "example.audit",
    });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "add-note");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.plugin_id, "example.audit");
  } finally {
    await rmTempProject(dir);
  }
});
