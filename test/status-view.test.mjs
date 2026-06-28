// status view: global counts, in_progress (who), ready, blocked-by-decision, stale, gotchas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("status: shows counts and per-section lists", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", initiative: "mig", title: "a" };
      s.tasks.T2 = { id: "T2", initiative: "mig", title: "b", status: "in_progress", claimed_by: "agent-x", claimed_at: Date.now() };
      s.tasks.T3 = { id: "T3", initiative: "mig", title: "c", status: "done" };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    assert.ok(out.counts);
    assert.equal(out.counts.mig.ready, 1);
    assert.equal(out.counts.mig.in_progress, 1);
    assert.equal(out.counts.mig.done, 1);
    assert.ok(out.in_progress.find((t) => t.id === "T2" && t.claimed_by === "agent-x"));
  } finally {
    await rmTempProject(dir);
  }
});

test("status: flags claims older than staleMs as stale", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "a", claimed_at: Date.now() - 10_000 };
      return s;
    });
    const out = await status({ statePath: dir, flags: { staleMs: 1000 } });
    assert.ok(out.stale.find((t) => t.id === "T1"));
  } finally {
    await rmTempProject(dir);
  }
});

test("status: reports tasks blocked by a decision", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1" };
      s.tasks.T1 = { id: "T1", depends_on: ["D1"] };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    assert.ok(out.blocked_by_decision.D1);
    assert.ok(out.blocked_by_decision.D1.includes("T1"));
  } finally {
    await rmTempProject(dir);
  }
});

test("status: lists active gotchas", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.gotchas.G1 = { id: "G1", title: "RLS", applies_to: ["domain:db"], status: "active" };
      s.gotchas.G2 = { id: "G2", title: "old", applies_to: [], status: "resolved" };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    assert.equal(out.active_gotchas.length, 1);
    assert.equal(out.active_gotchas[0].id, "G1");
  } finally {
    await rmTempProject(dir);
  }
});
