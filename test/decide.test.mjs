// decide: close a decision; unblocks dependent tasks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("decide: closes decision, stores choice + rationale, marks decided", async () => {
  const { default: decide } = await importFresh("./commands/decide.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1", title: "Directus or raw Postgres?" };
      return s;
    });
    await decide({ statePath: dir, flags: { as: "orchestrator", because: "less infra" }, positional: ["D1", "raw", "postgres"] });
    const s = await readState(dir);
    assert.equal(s.decisions.D1.status, "decided");
    assert.equal(s.decisions.D1.choice, "raw postgres");
    assert.equal(s.decisions.D1.rationale, "less infra");
    assert.ok(s.decisions.D1.decided_at);
  } finally {
    await rmTempProject(dir);
  }
});

test("decide: fails if decision does not exist", async () => {
  const { default: decide } = await importFresh("./commands/decide.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(decide({ statePath: dir, flags: { as: "o" }, positional: ["NOPE", "x", "y"] }));
  } finally {
    await rmTempProject(dir);
  }
});

test("decide: after decide, dependent tasks become ready (no need to re-derive here, just persisted state)", async () => {
  const { default: decide } = await importFresh("./commands/decide.mjs");
  const { readState, derive } = await importFresh("./state.mjs");
  const { derive: dderive } = await importFresh("./dag.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1" };
      s.tasks.T1 = { id: "T1", depends_on: ["D1"] };
      return s;
    });
    await decide({ statePath: dir, flags: { as: "o", because: "r" }, positional: ["D1", "x", "y"] });
    const s = await readState(dir);
    const r = dderive(s);
    assert.deepEqual(r.ready, ["T1"]);
  } finally {
    await rmTempProject(dir);
  }
});
