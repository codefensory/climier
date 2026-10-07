// Plugin log seam focused suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState } from "./helpers.ts";
import { initProject, lastLog, addTaskPair } from "./plugin-log-seam-residual-helpers.ts";

test("add-task: CLI call writes add-task log entry without plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    const { default: addTask } = await importFresh("./cli/commands/add-task.ts");
    await addTask({
      statePath: dir,
      flags: {
        as: "alice",
        initiative: "plugin-platform",
        title: "T1",
        body: "b",
        acceptance: "a",
        "blocked-by": "",
      },
      positional: ["T1"],
      projectDir: dir,
    });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "add-task");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.node, "T1");
    assert.equal(entry.plugin_id, undefined);
  } finally {
    await rmTempProject(dir);
  }
});
test("add-task: ctx.pluginId is propagated to the log entry as plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    const { default: addTask } = await importFresh("./cli/commands/add-task.ts");
    await addTask({
      statePath: dir,
      flags: {
        as: "alice",
        initiative: "plugin-platform",
        title: "T1",
        body: "b",
        acceptance: "a",
        "blocked-by": "",
      },
      positional: ["T1"],
      projectDir: dir,
      pluginId: "example.audit",
    });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "add-task");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.plugin_id, "example.audit");

    // did not duplicate: the last entry is from this call only.
  } finally {
    await rmTempProject(dir);
  }
});
test("add-task: two consecutive calls (one CLI, one plugin) produce two distinct log entries with correct attribution", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    const { default: addTask } = await importFresh("./cli/commands/add-task.ts");
    await addTaskPair(dir, addTask);
    const s = await readState(dir);
    // initV2Project calls add-initiative once (which now writes a log

    // total. The first entry is the initiative bootstrap, the next

    assert.equal(s.log.length, 3);
    assert.equal(s.log[0].action, "add-initiative");
    assert.equal(s.log[0].node, "plugin-platform");
    assert.equal(s.log[0].plugin_id, undefined);
    assert.equal(s.log[1].node, "T-cli");
    assert.equal(s.log[1].plugin_id, undefined);
    assert.equal(s.log[2].node, "T-plugin");
    assert.equal(s.log[2].plugin_id, "example.audit");
  } finally {
    await rmTempProject(dir);
  }
});
