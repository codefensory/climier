// pre-claim depends_on_detail: structured data about each dep so the agent
// doesn't have to assemble the picture from a free-text blocker string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("pre-claim: depends_on_detail lists each dep with id, kind, status, title", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "first" };
      s.tasks.T2 = { id: "T2", title: "second", depends_on: ["T1", "D1"] };
      s.decisions.D1 = { id: "D1", title: "pick x" };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: {}, positional: ["T2"] });
    assert.ok(Array.isArray(out.depends_on_detail));
    assert.equal(out.depends_on_detail.length, 2);
    const t1 = out.depends_on_detail.find((d) => d.id === "T1");
    assert.equal(t1.kind, "task");
    assert.equal(t1.status, "ready");
    assert.equal(t1.title, "first");
    const d1 = out.depends_on_detail.find((d) => d.id === "D1");
    assert.equal(d1.kind, "decision");
    assert.equal(d1.status, "open");
    assert.equal(d1.title, "pick x");
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: depends_on_detail includes claimed_by for in_progress task deps", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "in flight", status: "in_progress", claimed_by: "alice", claimed_at: Date.now() };
      s.tasks.T2 = { id: "T2", title: "waits", depends_on: ["T1"] };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: {}, positional: ["T2"] });
    const t1 = out.depends_on_detail[0];
    assert.equal(t1.kind, "task");
    assert.equal(t1.status, "in_progress");
    assert.equal(t1.claimed_by, "alice");
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: depends_on_detail marks unknown deps with kind=unknown", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "x", depends_on: ["GHOST"] };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: {}, positional: ["T1"] });
    const ghost = out.depends_on_detail[0];
    assert.equal(ghost.kind, "unknown");
    assert.equal(ghost.id, "GHOST");
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: ready task with no deps has empty depends_on_detail", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "ready" };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: {}, positional: ["T1"] });
    assert.deepEqual(out.depends_on_detail, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: ready task with satisfied deps surfaces the deps (so agent sees what was already done)", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "first", status: "done" };
      s.tasks.T2 = { id: "T2", title: "second", depends_on: ["T1"] };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: {}, positional: ["T2"] });
    assert.equal(out.derived_status, "ready");
    assert.equal(out.depends_on_detail.length, 1);
    assert.equal(out.depends_on_detail[0].status, "done");
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: decision dep with status=decided shows it in depends_on_detail (not a blocker)", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1", title: "done", status: "decided", choice: "X" };
      s.tasks.T1 = { id: "T1", title: "x", depends_on: ["D1"] };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: {}, positional: ["T1"] });
    assert.equal(out.derived_status, "ready");
    const d1 = out.depends_on_detail[0];
    assert.equal(d1.kind, "decision");
    assert.equal(d1.status, "decided");
  } finally {
    await rmTempProject(dir);
  }
});
