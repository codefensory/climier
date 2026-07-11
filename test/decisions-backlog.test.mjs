// decisions + backlog: open decisions must report which tasks in each pool
// (ready/blocked/backlog) depend on them, so the orchestrator sees the full
// impact of `climier decide` — not just the ready/blocked slice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

// --- dag.mjs: blockedByDecisionInBacklog ---

test("blockedByDecisionInBacklog: returns a map of decisionId -> backlog tasks depending on it", async () => {
  const { derive, blockedByDecisionInBacklog } = await importFresh("./dag.mjs");
  const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  s.decisions.D1 = { id: "D1" };
  s.tasks.T1 = { id: "T1", backlog: true, depends_on: ["D1"] };
  s.tasks.T2 = { id: "T2", backlog: true, depends_on: ["D1", "T3"] };
  s.tasks.T3 = { id: "T3" };
  s.tasks.T4 = { id: "T4", backlog: true, depends_on: ["D2"] }; // different decision
  const d = derive(s);
  const m = blockedByDecisionInBacklog(s, d);
  assert.deepEqual(m.D1.sort(), ["T1", "T2"]);
  assert.equal(m.D2, undefined);
});

test("blockedByDecisionInBacklog: decided decisions do not block anything (return {})", async () => {
  const { derive, blockedByDecisionInBacklog } = await importFresh("./dag.mjs");
  const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  s.decisions.D1 = { id: "D1", status: "decided" };
  s.tasks.T1 = { id: "T1", backlog: true, depends_on: ["D1"] };
  const d = derive(s);
  const m = blockedByDecisionInBacklog(s, d);
  assert.deepEqual(m, {});
});

test("blockedByDecisionInBacklog: empty state returns {} (never throws)", async () => {
  const { blockedByDecisionInBacklog } = await importFresh("./dag.mjs");
  const { emptyState } = await importFresh("./state.mjs");
  const m = blockedByDecisionInBacklog(emptyState());
  assert.deepEqual(m, {});
});

test("blockedByDecisionInBacklog: backlog task with no decision dep is not surfaced", async () => {
  const { derive, blockedByDecisionInBacklog } = await importFresh("./dag.mjs");
  const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  s.decisions.D1 = { id: "D1" };
  s.tasks.T1 = { id: "T1", backlog: true }; // no depends_on
  const d = derive(s);
  const m = blockedByDecisionInBacklog(s, d);
  assert.deepEqual(m, {});
});

// --- status.mjs: blocked_by_decision_in_backlog ---

test("status: blocked_by_decision_in_backlog surfaces backlog tasks gated by an open decision", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1", title: "auth choice" };
      s.tasks["F2.T1"] = { id: "F2.T1", initiative: "auth", title: "implement Lucia" }; // blocked
      s.tasks["F2.T1"].depends_on = ["D1"];
      s.tasks["F2.T2"] = { id: "F2.T2", initiative: "auth", title: "migrate JWT", backlog: true };
      s.tasks["F2.T2"].depends_on = ["D1"];
      s.tasks["F2.T3"] = { id: "F2.T3", initiative: "auth", title: "consolidate", backlog: true };
      s.tasks["F2.T3"].depends_on = ["D1"];
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    assert.ok(out.blocked_by_decision_in_backlog);
    const ids = (out.blocked_by_decision_in_backlog.D1 || []).map((t) => t.id).sort();
    assert.deepEqual(ids, ["F2.T2", "F2.T3"]);
    // Existing field is unchanged: still shows the blocked (non-backlog) one.
    const blockedIds = (out.blocked_by_decision.D1 || []).map((t) => t.id);
    assert.deepEqual(blockedIds, ["F2.T1"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("status: blocked_by_decision_in_backlog is an empty object when no backlog task depends on an open decision", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1" };
      s.tasks.T1 = { id: "T1", title: "blocked", depends_on: ["D1"] };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    assert.deepEqual(out.blocked_by_decision_in_backlog, {});
  } finally {
    await rmTempProject(dir);
  }
});

// --- decisions.mjs: each open decision has a `blocks` count ---

test("decisions: open decision with 1 ready-blocked + 2 backlog-blocked tasks → blocks.ready=1, blocks.blocked=0, blocks.backlog=2", async () => {
  const { default: decisions } = await importFresh("./commands/decisions.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1", title: "auth choice" };
      s.tasks.F2_T1 = { id: "F2.T1", initiative: "auth", title: "implement Lucia" };
      s.tasks.F2_T1.depends_on = ["D1"]; // blocked (only dep is open decision)
      s.tasks.F2_T2 = { id: "F2.T2", initiative: "auth", title: "migrate JWT", backlog: true };
      s.tasks.F2_T2.depends_on = ["D1"];
      s.tasks.F2_T3 = { id: "F2.T3", initiative: "auth", title: "consolidate", backlog: true };
      s.tasks.F2_T3.depends_on = ["D1"];
      return s;
    });
    const out = await decisions({ statePath: dir, flags: {} });
    const d1 = out.find((d) => d.id === "D1");
    assert.ok(d1.blocks, "open decision should have a blocks count");
    assert.equal(d1.blocks.ready, 0);
    assert.equal(d1.blocks.blocked, 1);
    assert.equal(d1.blocks.backlog, 2);
  } finally {
    await rmTempProject(dir);
  }
});

test("decisions: open decision with only backlog dependents → blocks.backlog>0, others=0", async () => {
  const { default: decisions } = await importFresh("./commands/decisions.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1", title: "future" };
      s.tasks.T1 = { id: "T1", title: "deferred a", backlog: true, depends_on: ["D1"] };
      s.tasks.T2 = { id: "T2", title: "deferred b", backlog: true, depends_on: ["D1"] };
      return s;
    });
    const out = await decisions({ statePath: dir, flags: {} });
    const d1 = out.find((d) => d.id === "D1");
    assert.deepEqual(d1.blocks, { ready: 0, blocked: 0, backlog: 2 });
  } finally {
    await rmTempProject(dir);
  }
});

test("decisions: open decision with no dependents → blocks field is omitted (no noise)", async () => {
  const { default: decisions } = await importFresh("./commands/decisions.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1", title: "lone decision" };
      return s;
    });
    const out = await decisions({ statePath: dir, flags: {} });
    const d1 = out.find((d) => d.id === "D1");
    assert.equal(d1.blocks, undefined, "open decision with no dependents should not have a blocks field");
  } finally {
    await rmTempProject(dir);
  }
});

test("decisions: decided decision does not have a blocks field", async () => {
  const { default: decisions } = await importFresh("./commands/decisions.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1", title: "done", status: "decided", choice: "X" };
      s.tasks.T1 = { id: "T1", title: "still listed as dep", depends_on: ["D1"] };
      return s;
    });
    const out = await decisions({ statePath: dir, flags: {} });
    const d1 = out.find((d) => d.id === "D1");
    assert.equal(d1.blocks, undefined, "decided decision should not report blocks");
  } finally {
    await rmTempProject(dir);
  }
});

test("decisions: open decision's blocks counts are correct across all three pools (mixed scenario)", async () => {
  const { default: decisions } = await importFresh("./commands/decisions.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1", title: "x" };
      s.decisions.D2 = { id: "D2", title: "y" };
      // D1 dependents: 1 blocked + 1 backlog
      s.tasks.T1 = { id: "T1", title: "blocked by D1", depends_on: ["D1"] };
      s.tasks.T2 = { id: "T2", title: "backlog blocked by D1", backlog: true, depends_on: ["D1"] };
      // D2 dependents: 1 blocked (no backlog flag) + 1 backlog
      s.tasks.T3 = { id: "T3", title: "backlog blocked by D2", backlog: true, depends_on: ["D2"] };
      s.tasks.T4 = { id: "T4", title: "blocked by D2", depends_on: ["D2"] };
      // Already-decided decision
      s.decisions.D3 = { id: "D3", title: "done", status: "decided" };
      s.tasks.T5 = { id: "T5", title: "D3 dependent", depends_on: ["D3"] };
      return s;
    });
    const out = await decisions({ statePath: dir, flags: {} });
    const d1 = out.find((d) => d.id === "D1");
    const d2 = out.find((d) => d.id === "D2");
    const d3 = out.find((d) => d.id === "D3");
    // D1: T1 blocked, T2 backlog. → {0, 1, 1}
    assert.deepEqual(d1.blocks, { ready: 0, blocked: 1, backlog: 1 });
    // D2: T4 blocked, T3 backlog. → {0, 1, 1}
    assert.deepEqual(d2.blocks, { ready: 0, blocked: 1, backlog: 1 });
    // D3 decided → no blocks
    assert.equal(d3.blocks, undefined, "decided decision has no blocks");
  } finally {
    await rmTempProject(dir);
  }
});

test("decisions: after closing the decision with `climier decide`, its blocks field disappears (D2 closes → no more D2 in dependents)", async () => {
  // The real-world flow: D1 was open with N blocked/backlog dependents. The
  // orchestrator calls `climier decide D1 ...` (we simulate by writing status
  // directly since `decide` is a separate command). The `blocks` field on D1
  // disappears because D1 is now decided.
  const { default: decisions } = await importFresh("./commands/decisions.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1", title: "x", status: "open" };
      s.tasks.T1 = { id: "T1", title: "blocked by D1", depends_on: ["D1"] };
      s.tasks.T2 = { id: "T2", title: "backlog blocked by D1", backlog: true, depends_on: ["D1"] };
      return s;
    });
    const before = await decisions({ statePath: dir, flags: {} });
    assert.ok(before.find((d) => d.id === "D1").blocks, "open: blocks present");
    // Simulate the decide.
    await updateState(dir, (s) => {
      s.decisions.D1.status = "decided";
      s.decisions.D1.choice = "X";
      return s;
    });
    const after = await decisions({ statePath: dir, flags: {} });
    assert.equal(after.find((d) => d.id === "D1").blocks, undefined, "decided: blocks gone");
  } finally {
    await rmTempProject(dir);
  }
});
