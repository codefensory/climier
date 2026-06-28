// gotchas.mjs: resolve gotchas by domain/task id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importFresh } from "./helpers.mjs";

test("forTask: returns gotchas matching task domain", async () => {
  const { forTask } = await importFresh("./gotchas.mjs");
  const state = {
    gotchas: {
      G1: { id: "G1", applies_to: ["domain:db"], title: "RLS trap", mitigation: "filter by user_id" },
      G2: { id: "G2", applies_to: ["domain:auth"], title: "guard", mitigation: "ok" },
    },
  };
  const out = forTask(state, { id: "T1", domain: "db" });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "G1");
});

test("forTask: returns gotchas matching task id directly", async () => {
  const { forTask } = await importFresh("./gotchas.mjs");
  const state = {
    gotchas: {
      G1: { id: "G1", applies_to: ["T1"], title: "specific", mitigation: "ok" },
    },
  };
  const out = forTask(state, { id: "T1", domain: "db" });
  assert.equal(out.length, 1);
});

test("forTask: filters out resolved gotchas", async () => {
  const { forTask } = await importFresh("./gotchas.mjs");
  const state = {
    gotchas: {
      G1: { id: "G1", applies_to: ["domain:db"], title: "open", status: "active" },
      G2: { id: "G2", applies_to: ["domain:db"], title: "done", status: "resolved" },
    },
  };
  const out = forTask(state, { id: "T1", domain: "db" });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "G1");
});

test("forTask: missing task domain -> no gotchas", async () => {
  const { forTask } = await importFresh("./gotchas.mjs");
  const state = { gotchas: { G1: { id: "G1", applies_to: ["domain:db"] } } };
  const out = forTask(state, { id: "T1" });
  assert.equal(out.length, 0);
});
