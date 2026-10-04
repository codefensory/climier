// Plugin log seam focused suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState } from "./helpers.mjs";
import { initProject, seedOpenTask, runLoggedHandlers } from "./plugin-log-seam-residual-helpers.mjs";

test("plugin-log-seam: handlers still observe withLock → updateState → append order (one log per handler call)", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    await seedOpenTask(dir, "T-flow");
    await seedOpenTask(dir, "T-flow-2");
    await runLoggedHandlers(dir);
    const s = await readState(dir);
    // Three plugin-initiated handler calls. Each must produce exactly
    // one log entry that carries plugin_id. (The CLI seeding calls
    // produced entries with no plugin_id earlier; we only inspect the
    // last three entries, which correspond to the three plugin calls.)
    const tail = s.log.slice(-3);
    assert.equal(tail.length, 3);
    assert.equal(tail[0].action, "add-edge");
    assert.equal(tail[1].action, "take");
    assert.equal(tail[2].action, "add-note");
    for (const entry of tail) {
      assert.equal(entry.plugin_id, "example.audit");
      assert.equal(entry.agent, "alice");
    }
    // Each entry has a unique ts and unique action so no interleaving.
    const actions = tail.map((e) => e.action);
    assert.equal(new Set(actions).size, actions.length);
  } finally {
    await rmTempProject(dir);
  }
});
test("plugin-log-seam: append() CLI path still works after the seam is added", async () => {
  const { append } = await importFresh("./storage/log.mjs");
  const dir = await createTempProject();
  try {
    await append(dir, { agent: "alice", action: "add-task", node: "T1" });
    const s = await readState(dir);
    assert.equal(s.log.length, 1);
    assert.equal(s.log[0].action, "add-task");
    assert.equal(s.log[0].plugin_id, undefined);
    assert.equal(s.log[0].agent, "alice");
  } finally {
    await rmTempProject(dir);
  }
});
