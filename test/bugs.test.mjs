// Tests for the bugs identified in the audit. These must FAIL before fixes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, runCli, readState } from "./helpers.mjs";

// BUG #1: block does not verify ownership — any agent can mark a blocker on
// another agent's task. Must FAIL before the fix.
test("bug: block by a non-owner agent is rejected", async () => {
  const { default: block } = await importFresh("./commands/block.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "agent-x" };
      return s;
    });
    await assert.rejects(
      block({ statePath: dir, flags: { as: "agent-y" }, positional: ["T1", "stolen block"] }),
      /not yours|not owner|not the owner/i
    );
    // And the state should not have been modified.
    const s = await (await importFresh("./state.mjs")).readState(dir);
    assert.equal(s.tasks.T1.block_reason, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

// BUG #2: graph ignores --initiative flag. Must FAIL before fix.
test("bug: graph --initiative filter limits the output", async () => {
  const { default: graph } = await importFresh("./commands/graph.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "alpha", initiative: "x" };
      s.tasks.T2 = { id: "T2", title: "beta", initiative: "y" };
      return s;
    });
    const lines = await graph({ statePath: dir, flags: { initiative: "x" } });
    const flat = lines.join("\n");
    assert.match(flat, /T1/);
    assert.doesNotMatch(flat, /T2/);
  } finally {
    await rmTempProject(dir);
  }
});

// BUG #3: withLock crashes if .agents/tasks/ does not exist. Must FAIL before fix.
test("bug: withLock creates the directory if missing", async () => {
  const { withLock } = await importFresh("./lock.mjs");
  const os = await import("node:os");
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "climier-bug3-"));
  try {
    // No .agents/tasks/ created
    let ran = false;
    await withLock(base, async () => {
      ran = true;
    });
    assert.equal(ran, true);
    // The directory should now exist.
    const stat = await fs.stat(path.join(base, ".agents", "tasks"));
    assert.ok(stat.isDirectory());
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// BUG #4: readState throws on corrupted JSON; should return a sentinel or clear error.
test("bug: corrupted state file produces a clear error, not a SyntaxError stack", async () => {
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const file = path.join(dir, ".agents", "tasks", "tasks.json");
    await fs.writeFile(file, "{ this is not valid json :::", "utf8");
    await assert.rejects(readState(dir), /corrupt|invalid.*json|parse/i);
  } finally {
    await rmTempProject(dir);
  }
});

// BUG #5 (coverage gap that revealed a bug): add-task with a non-existent --depends-on
// should warn or fail, not silently create a task stuck forever.
test("bug: add-task rejects --depends-on pointing to non-existent id", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const { default: init } = await importFresh("./commands/init.mjs");
  const dir = await createTempProject();
  try {
    // init first so the state file exists and the validator can run.
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    await assert.rejects(
      addTask({
        statePath: dir,
        flags: { initiative: "mig", title: "x", "depends-on": "NONEXISTENT" },
        positional: ["T1"],
      }),
      /depends.*not found|unknown dep|non-existent dep/i
    );
  } finally {
    await rmTempProject(dir);
  }
});
