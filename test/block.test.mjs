// block: mark a blocker on the currently claimed task.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("block: sets block_reason on the in_progress task; task still in_progress", async () => {
  const { default: block } = await importFresh("./commands/block.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "agent-a" };
      return s;
    });
    await block({ statePath: dir, flags: { as: "agent-a" }, positional: ["T1", "needs", "design", "decision"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.status, "in_progress");
    assert.match(s.tasks.T1.block_reason, /needs design decision/);
  } finally {
    await rmTempProject(dir);
  }
});

test("block: fails if task not in_progress", async () => {
  const { default: block } = await importFresh("./commands/block.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" };
      return s;
    });
    await assert.rejects(block({ statePath: dir, flags: { as: "a" }, positional: ["T1", "r"] }));
  } finally {
    await rmTempProject(dir);
  }
});

test("block: log entry appended", async () => {
  const { default: block } = await importFresh("./commands/block.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "agent-a" };
      return s;
    });
    await block({ statePath: dir, flags: { as: "agent-a" }, positional: ["T1", "x"] });
    const s = await readState(dir);
    assert.ok(s.log.find((e) => e.action === "block" && e.task === "T1"));
  } finally {
    await rmTempProject(dir);
  }
});
