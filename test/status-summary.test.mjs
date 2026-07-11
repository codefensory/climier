// status summary: self-describing headline + alerts + enriched fields so an
// agent can read status without making assumptions or having to assemble
// the picture from raw sections.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("status.summary: counts are accurate (ready, in_progress, blocked, backlog, done, archived, stale, open_decisions, placeholders)", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.R1 = { id: "R1", title: "ready" };
      s.tasks.R2 = { id: "R2", title: "ready 2" };
      s.tasks.B1 = { id: "B1", title: "blocked", depends_on: ["B2"] };
      s.tasks.B2 = { id: "B2", title: "blocker", status: "in_progress", claimed_by: "alice", claimed_at: Date.now() };
      s.tasks.D1 = { id: "D1", title: "done", status: "done" };
      s.tasks.A1 = { id: "A1", title: "archived", status: "archived" };
      s.tasks.BL1 = { id: "BL1", title: "backlog", backlog: true };
      s.tasks.S1 = { id: "S1", title: "stale", status: "in_progress", claimed_by: "bob", claimed_at: Date.now() - 10_000 };
      s.decisions.DX = { id: "DX", title: "open decision" };
      return s;
    });
    const out = await status({ statePath: dir, flags: { staleMs: 1000 } });
    assert.equal(out.summary.ready, 2);
    assert.equal(out.summary.in_progress, 2); // B2 (fresh) + S1 (stale)
    assert.equal(out.summary.blocked, 1);
    assert.equal(out.summary.backlog, 1);
    assert.equal(out.summary.done, 1);
    assert.equal(out.summary.archived, 1);
    assert.equal(out.summary.stale, 1);
    assert.equal(out.summary.open_decisions, 1);
    assert.equal(out.summary.placeholders, 0);
  } finally {
    await rmTempProject(dir);
  }
});

test("status.summary: text is a one-line narrative in plain English", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.R1 = { id: "R1", title: "ready" };
      s.tasks.B1 = { id: "B1", title: "blocked", depends_on: ["NONEXISTENT"] };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    assert.equal(typeof out.summary.text, "string");
    assert.match(out.summary.text, /1 ready/);
    assert.match(out.summary.text, /1 blocked/);
  } finally {
    await rmTempProject(dir);
  }
});

test("status.summary: text mentions placeholders when .OPEN tasks are blocked", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks["F2.OPEN"] = { id: "F2.OPEN", title: "phase 2 stub", depends_on: ["F0.T1"] };
      s.tasks["F0.T1"] = { id: "F0.T1", title: "first" };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    assert.equal(out.summary.placeholders, 1);
    assert.match(out.summary.text, /placeholder/);
  } finally {
    await rmTempProject(dir);
  }
});

test("status.summary: empty state has a text and zero counts", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => s);
    const out = await status({ statePath: dir, flags: {} });
    assert.equal(out.summary.ready, 0);
    assert.equal(out.summary.blocked, 0);
    assert.equal(out.summary.placeholders, 0);
    assert.equal(typeof out.summary.text, "string");
  } finally {
    await rmTempProject(dir);
  }
});

test("status.alerts: each open decision with dependents gets a decision-gate alert", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1", title: "pick db" };
      s.tasks.T1 = { id: "T1", title: "blocked by D1", depends_on: ["D1"] };
      s.decisions.D2 = { id: "D2", title: "unused" };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    const gate = out.alerts.filter((a) => a.kind === "decision-gate");
    assert.equal(gate.length, 1);
    assert.equal(gate[0].decision_id, "D1");
    assert.equal(gate[0].title, "pick db");
    assert.match(gate[0].message, /D1/);
    assert.equal(gate[0].blocks.blocked, 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("status.alerts: stale claims appear as warnings", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.S1 = { id: "S1", status: "in_progress", claimed_by: "alice", claimed_at: Date.now() - 10_000 };
      return s;
    });
    const out = await status({ statePath: dir, flags: { staleMs: 1000 } });
    const stale = out.alerts.filter((a) => a.kind === "stale-claim");
    assert.equal(stale.length, 1);
    assert.equal(stale[0].task_id, "S1");
    assert.equal(stale[0].claimed_by, "alice");
    assert.equal(stale[0].severity, "warning");
  } finally {
    await rmTempProject(dir);
  }
});

test("status.alerts: empty state has no alerts", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => s);
    const out = await status({ statePath: dir, flags: {} });
    assert.deepEqual(out.alerts, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("status.blocked: entries are objects with id, title, phase, reason.unsatisfied_deps", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "first", phase: "F0" };
      s.tasks.T2 = { id: "T2", title: "second", phase: "F0", depends_on: ["T1", "D1"] };
      s.decisions.D1 = { id: "D1", title: "pick x" };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    assert.equal(out.blocked.length, 1);
    const b = out.blocked[0];
    assert.equal(b.id, "T2");
    assert.equal(b.title, "second");
    assert.equal(b.phase, "F0");
    assert.equal(b.placeholder, false);
    assert.equal(b.reason.unsatisfied_deps.length, 2);
    const t1 = b.reason.unsatisfied_deps.find((d) => d.id === "T1");
    assert.equal(t1.kind, "task");
    assert.equal(t1.status, "ready");
    assert.equal(t1.title, "first");
    const d1 = b.reason.unsatisfied_deps.find((d) => d.id === "D1");
    assert.equal(d1.kind, "decision");
    assert.equal(d1.status, "open");
    assert.equal(d1.title, "pick x");
  } finally {
    await rmTempProject(dir);
  }
});

test("status.blocked: .OPEN suffix is marked with placeholder=true", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks["F2.OPEN"] = { id: "F2.OPEN", title: "phase 2 stub", depends_on: ["F0.T1"] };
      s.tasks["F0.T1"] = { id: "F0.T1", title: "first" };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    const ph = out.blocked.find((b) => b.id === "F2.OPEN");
    assert.ok(ph);
    assert.equal(ph.placeholder, true);
  } finally {
    await rmTempProject(dir);
  }
});

test("status.blocked: tasks with explicit placeholder=true are marked", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "placeholder-ish", placeholder: true, depends_on: ["T2"] };
      s.tasks.T2 = { id: "T2", title: "blocker" };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    const t1 = out.blocked.find((b) => b.id === "T1");
    assert.ok(t1);
    assert.equal(t1.placeholder, true);
  } finally {
    await rmTempProject(dir);
  }
});

test("status.open_decisions: entries are objects with id, title, initiative, blocks", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1", title: "pick db", initiative: "mig" };
      s.tasks.T1 = { id: "T1", title: "blocked", depends_on: ["D1"] };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    assert.equal(out.open_decisions.length, 1);
    const d = out.open_decisions[0];
    assert.equal(d.id, "D1");
    assert.equal(d.title, "pick db");
    assert.equal(d.initiative, "mig");
    assert.equal(d.blocks.blocked, 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("status.ready: includes skills, effort, domain, phase, gotcha_count", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "do db thing", phase: "F0", skills: ["ts", "sql"], effort: "m", domain: "db" };
      s.gotchas.G1 = { id: "G1", title: "RLS", applies_to: ["domain:db"], mitigation: "x" };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    const r = out.ready.find((t) => t.id === "T1");
    assert.ok(r);
    assert.deepEqual(r.skills, ["ts", "sql"]);
    assert.equal(r.effort, "m");
    assert.equal(r.domain, "db");
    assert.equal(r.phase, "F0");
    assert.equal(r.gotcha_count, 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("status.backlog: entries include reason.unsatisfied_deps for backlog tasks with unsatisfied deps", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1", title: "pick" };
      s.tasks.BL1 = { id: "BL1", title: "backlog", backlog: true, depends_on: ["D1"] };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    const bl = out.backlog.find((b) => b.id === "BL1");
    assert.ok(bl);
    assert.equal(bl.reason.unsatisfied_deps.length, 1);
    assert.equal(bl.reason.unsatisfied_deps[0].kind, "decision");
    assert.equal(bl.reason.unsatisfied_deps[0].status, "open");
  } finally {
    await rmTempProject(dir);
  }
});

test("status.ready: gotcha_count is 0 when no gotcha applies (id or domain)", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "no gotcha", domain: "ui" };
      s.gotchas.G1 = { id: "G1", title: "db gotcha", applies_to: ["domain:db"] };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    const r = out.ready.find((t) => t.id === "T1");
    assert.equal(r.gotcha_count, 0);
  } finally {
    await rmTempProject(dir);
  }
});

test("status: backward compat — blocked_by_decision still surfaces the decision→task map", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1", title: "x" };
      s.tasks.T1 = { id: "T1", title: "blocked by D1", depends_on: ["D1"] };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    assert.ok(out.blocked_by_decision.D1);
    assert.equal(out.blocked_by_decision.D1[0].id, "T1");
  } finally {
    await rmTempProject(dir);
  }
});
