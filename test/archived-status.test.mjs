// archived-status.test.mjs: the persisted status is "archived" (renamed from "skipped").
// All these tests should fail BEFORE the rename and pass AFTER it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importFresh } from "./helpers.mjs";

test("derive: archived task counts as satisfied (does not block downstream)", async () => {
  const { derive } = await importFresh("../src/dag.mjs");
  const s = {
    version: 1,
    tasks: {
      T1: { id: "T1", status: "archived" },
      T2: { id: "T2", depends_on: ["T1"] },
    },
    decisions: {},
    gotchas: {},
    initiatives: {},
    log: [],
  };
  const d = derive(s);
  assert.ok(d.ready.includes("T2"), `expected T2 to be ready when T1 is archived, got ready=${JSON.stringify(d.ready)} blocked=${JSON.stringify(d.blocked)}`);
});

test("statusOf: returns 'archived' for a task with status archived", async () => {
  const { statusOf } = await importFresh("../src/dag.mjs");
  const s = { version: 1, tasks: { T1: { id: "T1", status: "archived" } }, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
  assert.equal(statusOf(s, "T1"), "archived");
});

test("derive: archived task itself is not in ready/blocked lists", async () => {
  const { derive } = await importFresh("../src/dag.mjs");
  const s = { version: 1, tasks: { T1: { id: "T1", status: "archived" } }, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
  const d = derive(s);
  assert.ok(!d.ready.includes("T1"));
  assert.ok(!d.blocked.includes("T1"));
});
