// claim: atomic reserve of a ready task.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, writeState, importFresh } from "./helpers.mjs";

async function setup(dir, taskOverrides = {}) {
  const { updateState, readState } = await importFresh("./state.mjs");
  await updateState(dir, (s) => {
    s.tasks.T1 = { id: "T1", title: "task one", ...taskOverrides };
    return s;
  });
  return { readState };
}

test("claim: success on ready task marks in_progress, sets claimed_by and claimed_at", async () => {
  const { default: claim } = await importFresh("./commands/claim.mjs");
  const dir = await createTempProject();
  try {
    const { readState } = await setup(dir);
    const out = await claim({ statePath: dir, flags: { as: "agent-a" }, positional: ["T1"] });
    assert.equal(out.task.id, "T1");
    assert.equal(out.task.claimed_by, "agent-a");
    assert.ok(out.task.claimed_at);
    const s = await readState(dir);
    assert.equal(s.tasks.T1.status, "in_progress");
  } finally {
    await rmTempProject(dir);
  }
});

test("claim: fails if task does not exist", async () => {
  const { default: claim } = await importFresh("./commands/claim.mjs");
  const dir = await createTempProject();
  try {
    await setup(dir);
    await assert.rejects(claim({ statePath: dir, flags: { as: "a" }, positional: ["NOPE"] }), /not found/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("claim: fails if task is blocked (dep not done)", async () => {
  const { default: claim } = await importFresh("./commands/claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" };
      s.tasks.T2 = { id: "T2", depends_on: ["T1"] };
      return s;
    });
    await assert.rejects(claim({ statePath: dir, flags: { as: "a" }, positional: ["T2"] }), /not ready/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("claim: fails if already claimed by another agent", async () => {
  const { default: claim } = await importFresh("./commands/claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "agent-x" };
      return s;
    });
    await assert.rejects(claim({ statePath: dir, flags: { as: "agent-y" }, positional: ["T1"] }), /in progress|claimed/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("claim: same agent claiming again fails (must release first)", async () => {
  const { default: claim } = await importFresh("./commands/claim.mjs");
  const dir = await createTempProject();
  try {
    await setup(dir);
    await claim({ statePath: dir, flags: { as: "a" }, positional: ["T1"] });
    await assert.rejects(claim({ statePath: dir, flags: { as: "a" }, positional: ["T1"] }));
  } finally {
    await rmTempProject(dir);
  }
});

test("claim: log entry appended", async () => {
  const { default: claim } = await importFresh("./commands/claim.mjs");
  const dir = await createTempProject();
  try {
    const { readState } = await setup(dir);
    await claim({ statePath: dir, flags: { as: "agent-a" }, positional: ["T1"] });
    const s = await readState(dir);
    const entry = s.log.find((e) => e.action === "claim" && e.task === "T1");
    assert.ok(entry);
    assert.equal(entry.agent, "agent-a");
  } finally {
    await rmTempProject(dir);
  }
});
