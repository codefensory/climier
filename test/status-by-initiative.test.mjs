// status.by_initiative: status groups the summary by registered initiative
// so the orchestrator can see per-stream activity without having to
// re-aggregate from the raw sections.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("status.by_initiative: present when there are registered initiatives", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.initiatives["migration"] = { desc: "the move" };
      s.initiatives["maintenance"] = { desc: "chores" };
      s.tasks.T1 = { id: "T1", title: "ready", initiative: "migration" };
      s.tasks.T2 = { id: "T2", title: "done", initiative: "migration", status: "done" };
      s.tasks.T3 = { id: "T3", title: "ready", initiative: "maintenance" };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    assert.ok(Array.isArray(out.summary.by_initiative));
    const names = out.summary.by_initiative.map((i) => i.name);
    assert.ok(names.includes("migration"));
    assert.ok(names.includes("maintenance"));
    const mig = out.summary.by_initiative.find((i) => i.name === "migration");
    assert.equal(mig.desc, "the move");
    assert.equal(mig.ready, 1);
    assert.equal(mig.done, 1);
    const maint = out.summary.by_initiative.find((i) => i.name === "maintenance");
    assert.equal(maint.ready, 1);
    assert.equal(maint.done, 0);
  } finally {
    await rmTempProject(dir);
  }
});

test("status.by_initiative: per-stream counts include in_progress, blocked, backlog, archived", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.initiatives["x"] = { desc: "" };
      s.initiatives["y"] = { desc: "" };
      s.tasks.R1 = { id: "R1", title: "r", initiative: "x" };
      s.tasks.IP1 = { id: "IP1", title: "ip", initiative: "x", status: "in_progress", claimed_by: "a", claimed_at: Date.now() };
      s.tasks.B1 = { id: "B1", title: "b", initiative: "x", depends_on: ["BLOCKER"] };
      s.tasks.BL1 = { id: "BL1", title: "bl", initiative: "y", backlog: true };
      s.tasks.AR1 = { id: "AR1", title: "ar", initiative: "y", status: "archived" };
      s.tasks.D1 = { id: "D1", title: "d", initiative: "y", status: "done" };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    const x = out.summary.by_initiative.find((i) => i.name === "x");
    const y = out.summary.by_initiative.find((i) => i.name === "y");
    assert.equal(x.ready, 1);
    assert.equal(x.in_progress, 1);
    assert.equal(x.blocked, 1);
    assert.equal(x.backlog, 0);
    assert.equal(x.archived, 0);
    assert.equal(x.done, 0);
    assert.equal(y.ready, 0);
    assert.equal(y.backlog, 1);
    assert.equal(y.archived, 1);
    assert.equal(y.done, 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("status.by_initiative: sorted by activity desc (ready+in_progress), ties broken by name", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.initiatives["a"] = { desc: "" };
      s.initiatives["b"] = { desc: "" };
      s.initiatives["c"] = { desc: "" };
      s.tasks.A1 = { id: "A1", title: "t", initiative: "a" };
      s.tasks.A2 = { id: "A2", title: "t", initiative: "a" };
      s.tasks.B1 = { id: "B1", title: "t", initiative: "b" };
      // a: 2 active, b: 1 active, c: 0 active
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    const order = out.summary.by_initiative.map((i) => i.name);
    assert.deepEqual(order, ["a", "b", "c"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("status.by_initiative: omitted when --initiative filter is passed", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.initiatives["x"] = { desc: "" };
      s.initiatives["y"] = { desc: "" };
      s.tasks.T1 = { id: "T1", title: "t", initiative: "x" };
      s.tasks.T2 = { id: "T2", title: "t", initiative: "y" };
      return s;
    });
    const out = await status({ statePath: dir, flags: { initiative: "x" } });
    // The filter already picked a single initiative; the breakdown would
    // be redundant, so we omit it.
    assert.equal(out.summary.by_initiative, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("status.by_initiative: empty state has no by_initiative field", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const out = await status({ statePath: dir, flags: {} });
    assert.equal(out.summary.by_initiative, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("status.by_initiative: counts open decisions per initiative", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.initiatives["x"] = { desc: "" };
      s.tasks.T1 = { id: "T1", title: "t", initiative: "x", depends_on: ["D1"] };
      s.decisions.D1 = { id: "D1", title: "open", initiative: "x" };
      s.decisions.D2 = { id: "D2", title: "decided", initiative: "x", status: "decided" };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    const x = out.summary.by_initiative.find((i) => i.name === "x");
    assert.equal(x.open_decisions, 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("status.by_initiative: counts stale claims per initiative", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.initiatives["x"] = { desc: "" };
      s.initiatives["y"] = { desc: "" };
      s.tasks.IP1 = { id: "IP1", title: "t", initiative: "x", status: "in_progress", claimed_by: "a", claimed_at: Date.now() - 100_000 };
      s.tasks.IP2 = { id: "IP2", title: "t", initiative: "y", status: "in_progress", claimed_by: "b", claimed_at: Date.now() };
      return s;
    });
    const out = await status({ statePath: dir, flags: { staleMs: 1000 } });
    const x = out.summary.by_initiative.find((i) => i.name === "x");
    const y = out.summary.by_initiative.find((i) => i.name === "y");
    assert.equal(x.stale, 1);
    assert.equal(y.stale, 0);
  } finally {
    await rmTempProject(dir);
  }
});
