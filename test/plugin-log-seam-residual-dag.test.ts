// Plugin log seam focused suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState } from "./helpers.ts";
import { initProject, seedOpenTask, lastLog } from "./plugin-log-seam-residual-helpers.mjs";

test("add-edge: CLI call writes add-edge log entry without plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    await seedOpenTask(dir, "T-a");
    await seedOpenTask(dir, "T-b");
    const { default: addEdge } = await importFresh("./cli/commands/add-edge.ts");
    await addEdge({ statePath: dir, flags: { as: "alice", type: "BLOCKS" }, positional: ["T-a", "T-b"] });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "add-edge");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.node, "T-b");
    assert.equal(entry.plugin_id, undefined);
  } finally {
    await rmTempProject(dir);
  }
});
test("add-edge: ctx.pluginId propagates to the log entry as plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    await seedOpenTask(dir, "T-a");
    await seedOpenTask(dir, "T-b");
    const { default: addEdge } = await importFresh("./cli/commands/add-edge.ts");
    await addEdge({
      statePath: dir,
      flags: { as: "alice", type: "BLOCKS" },
      positional: ["T-a", "T-b"],
      pluginId: "example.audit",
    });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "add-edge");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.plugin_id, "example.audit");
  } finally {
    await rmTempProject(dir);
  }
});
test("take: CLI call writes take log entry without plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    await seedOpenTask(dir, "T-take-1");
    const { default: take } = await importFresh("./cli/commands/take.ts");
    await take({ statePath: dir, flags: { as: "alice" }, positional: ["T-take-1"], projectDir: dir });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "take");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.node, "T-take-1");
    assert.equal(entry.plugin_id, undefined);
  } finally {
    await rmTempProject(dir);
  }
});
test("take: ctx.pluginId propagates to the log entry as plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    await seedOpenTask(dir, "T-take-2");
    const { default: take } = await importFresh("./cli/commands/take.ts");
    await take({
      statePath: dir,
      flags: { as: "alice" },
      positional: ["T-take-2"],
      projectDir: dir,
      pluginId: "example.audit",
    });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "take");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.plugin_id, "example.audit");
  } finally {
    await rmTempProject(dir);
  }
});
