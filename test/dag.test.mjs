// dag.mjs: derive ready/blocked/open from state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importFresh } from "./helpers.mjs";

test("derive: empty state -> nothing ready, nothing blocked", async () => {
  const { derive } = await importFresh("./dag.mjs"); const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  const r = derive(s);
  assert.deepEqual(r.ready, []);
  assert.deepEqual(r.blocked, []);
  assert.deepEqual(r.openDecisions, []);
});

test("derive: a task with no deps and not in_progress is ready", async () => {
  const { derive } = await importFresh("./dag.mjs"); const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  s.tasks.T1 = { id: "T1", title: "free task" };
  const r = derive(s);
  assert.deepEqual(r.ready, ["T1"]);
  assert.deepEqual(r.blocked, []);
});

test("derive: a task whose dep is open is blocked; dep done -> ready", async () => {
  const { derive } = await importFresh("./dag.mjs"); const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  s.tasks.T1 = { id: "T1" };
  s.tasks.T2 = { id: "T2", depends_on: ["T1"] };
  let r = derive(s);
  assert.deepEqual(r.ready, ["T1"]);
  assert.deepEqual(r.blocked, ["T2"]);

  s.tasks.T1.status = "done";
  r = derive(s);
  assert.deepEqual(r.ready, ["T2"]);
  assert.deepEqual(r.blocked, []);
});

test("derive: in_progress is neither ready nor blocked", async () => {
  const { derive } = await importFresh("./dag.mjs"); const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  s.tasks.T1 = { id: "T1", status: "in_progress" };
  const r = derive(s);
  assert.deepEqual(r.ready, []);
  assert.deepEqual(r.blocked, []);
});

test("derive: done is neither ready nor blocked", async () => {
  const { derive } = await importFresh("./dag.mjs"); const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  s.tasks.T1 = { id: "T1", status: "done" };
  const r = derive(s);
  assert.deepEqual(r.ready, []);
  assert.deepEqual(r.blocked, []);
});

test("derive: skipped counts as satisfied (does not block downstream)", async () => {
  const { derive } = await importFresh("./dag.mjs"); const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  s.tasks.T1 = { id: "T1", status: "skipped" };
  s.tasks.T2 = { id: "T2", depends_on: ["T1"] };
  const r = derive(s);
  assert.deepEqual(r.ready, ["T2"]);
});

test("derive: a decision that is open blocks tasks depending on it", async () => {
  const { derive } = await importFresh("./dag.mjs"); const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  s.decisions.D1 = { id: "D1" };
  s.tasks.T1 = { id: "T1", depends_on: ["D1"] };
  const r = derive(s);
  assert.deepEqual(r.openDecisions, ["D1"]);
  assert.deepEqual(r.blocked, ["T1"]);
  assert.deepEqual(r.ready, []);

  s.decisions.D1.status = "decided";
  const r2 = derive(s);
  assert.deepEqual(r2.openDecisions, []);
  assert.deepEqual(r2.ready, ["T1"]);
});

test("derive: missing dep id surfaces as a blocked task (no crash)", async () => {
  const { derive } = await importFresh("./dag.mjs"); const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  s.tasks.T1 = { id: "T1", depends_on: ["NONEXISTENT"] };
  const r = derive(s);
  assert.deepEqual(r.blocked, ["T1"]);
});

test("derive: multiple deps AND semantics", async () => {
  const { derive } = await importFresh("./dag.mjs"); const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  s.tasks.T1 = { id: "T1" };
  s.tasks.T2 = { id: "T2" };
  s.tasks.T3 = { id: "T3", depends_on: ["T1", "T2"] };
  let r = derive(s);
  assert.deepEqual(r.ready.sort(), ["T1", "T2"]);
  assert.deepEqual(r.blocked, ["T3"]);

  s.tasks.T1.status = "done";
  r = derive(s);
  assert.deepEqual(r.ready, ["T2"]);
  assert.deepEqual(r.blocked, ["T3"]);

  s.tasks.T2.status = "done";
  r = derive(s);
  assert.deepEqual(r.ready, ["T3"]);
  assert.deepEqual(r.blocked, []);
});

test("derive: cycles do not crash; cycle members stay blocked", async () => {
  const { derive } = await importFresh("./dag.mjs"); const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  s.tasks.A = { id: "A", depends_on: ["B"] };
  s.tasks.B = { id: "B", depends_on: ["A"] };
  const r = derive(s);
  assert.ok(r.blocked.includes("A"));
  assert.ok(r.blocked.includes("B"));
  assert.deepEqual(r.ready, []);
});

test("blockedByDecision: returns decision->task map for blocked tasks", async () => {
  const { derive, blockedByDecision } = await importFresh("./dag.mjs"); const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  s.decisions.D1 = { id: "D1" };
  s.tasks.T1 = { id: "T1", depends_on: ["D1"] };
  s.tasks.T2 = { id: "T2", depends_on: ["D1", "T3"] };
  s.tasks.T3 = { id: "T3" };
  const r = derive(s);
  const m = blockedByDecision(s, r);
  assert.deepEqual(m.D1.sort(), ["T1", "T2"]);
});
