// done: mark a claimed task complete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

async function setupClaimed(dir, id = "T1") {
  const { updateState } = await importFresh("./state.mjs");
  await updateState(dir, (s) => {
    s.tasks[id] = { id, title: "x", status: "in_progress", claimed_by: "agent-a", claimed_at: Date.now() };
    return s;
  });
}

test("done: marks done, clears claim, sets done_at and note", async () => {
  const { default: done } = await importFresh("./commands/done.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await setupClaimed(dir);
    await done({ statePath: dir, flags: { as: "agent-a" }, positional: ["T1", "shipped"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.status, "done");
    assert.equal(s.tasks.T1.done_by, "agent-a");
    assert.equal(s.tasks.T1.note, "shipped");
    assert.equal(s.tasks.T1.claimed_by, undefined);
    assert.ok(s.tasks.T1.done_at);
  } finally {
    await rmTempProject(dir);
  }
});

test("done: fails if task is not in_progress", async () => {
  const { default: done } = await importFresh("./commands/done.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" };
      return s;
    });
    await assert.rejects(done({ statePath: dir, flags: { as: "a" }, positional: ["T1", "n"] }), /not.*in.progress|not.*claimed/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("done: fails if claimed by another agent", async () => {
  const { default: done } = await importFresh("./commands/done.mjs");
  const dir = await createTempProject();
  try {
    await setupClaimed(dir);
    await assert.rejects(done({ statePath: dir, flags: { as: "agent-b" }, positional: ["T1", "n"] }), /not.*owner|not.*yours/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("done: a note is required (positional after id)", async () => {
  const { default: done } = await importFresh("./commands/done.mjs");
  const dir = await createTempProject();
  try {
    await setupClaimed(dir);
    await assert.rejects(done({ statePath: dir, flags: { as: "agent-a" }, positional: ["T1"] }), /note/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("done: log entry appended with note", async () => {
  const { default: done } = await importFresh("./commands/done.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await setupClaimed(dir);
    await done({ statePath: dir, flags: { as: "agent-a" }, positional: ["T1", "ok"] });
    const s = await readState(dir);
    const entry = s.log.find((e) => e.action === "done" && e.task === "T1");
    assert.ok(entry);
    assert.equal(entry.note, "ok");
  } finally {
    await rmTempProject(dir);
  }
});
