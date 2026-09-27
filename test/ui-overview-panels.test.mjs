// Contract tests for the secondary panels of ui/src/views/Overview.jsx
// (docs/ui-redesign-plan.md section 5 points 6-8).
//
// What this file pins:
//   - Recent activity: the log row must resolve a real node id and title
//     (including the legacy add-node shape where the id only lives in the
//     note), drop rows whose node is gone, dedupe (action, node) pairs and
//     cap the list.
//   - Initiative rows: registered initiatives and server breakdown entries
//     merge into one row per initiative, always with a real description,
//     sorted by attention (ready + in-progress + blocked + open gates).
//   - Initiative segments: the progress bar only ever shows task states,
//     never gates or knowledge counts.
//   - Project record: the 7 record rows, each with a real navigation target.
//
// The primary contract (metrics, alerts, work now, attention blocks) lives in
// ui-overview.test.mjs. Both files compile Overview.jsx through
// ui-overview-harness.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { uiSkip as skip } from "./ui-view-compiler.mjs";
import { compileOverview } from "./ui-overview-harness.mjs";

// --- humanizeAction --------------------------------------------------------

test("humanizeAction maps known log actions and falls back to the raw action", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  assert.equal(mod.humanizeAction("take"), "Claimed");
  assert.equal(mod.humanizeAction("resolve"), "Resolved");
  assert.equal(mod.humanizeAction("add-node"), "Node added");
  assert.equal(mod.humanizeAction("deprecate-knowledge"), "Knowledge deprecated");
  assert.equal(mod.humanizeAction("future-action"), "future-action");
  assert.equal(mod.humanizeAction(""), "event");
  assert.equal(mod.humanizeAction(undefined), "event");
});

// --- activityNodeId --------------------------------------------------------

test("activityNodeId resolves add-node events from the note (legacy log shape)", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  assert.equal(mod.activityNodeId({ action: "add-node", note: "K-ui-live-state" }), "K-ui-live-state");
  assert.equal(mod.activityNodeId({ action: "add-node", node: "K-ui-live-state", note: "K-ui-live-state" }), "K-ui-live-state");
  assert.equal(mod.activityNodeId({ action: "resolve", node: "T1" }), "T1");
  assert.equal(mod.activityNodeId({ action: "add-note", task: "T2" }), "T2");
  assert.equal(mod.activityNodeId({ action: "update", node_id: "T3" }), "T3");
  assert.equal(mod.activityNodeId({ action: "resolve", note: "not an id" }), null, "note fallback is add-node only");
  assert.equal(mod.activityNodeId(null), null);
});

// --- recentActivity --------------------------------------------------------

test("recentActivity shows add-node K-ui-live-state once and resolves the title", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const nodes = { "K-ui-live-state": { id: "K-ui-live-state", title: "State file se escribe con rename atomico" } };
  const entries = [
    { action: "add-node", agent: "orchestrator", note: "K-ui-live-state", ts: "2026-08-24T19:00:00.000Z" },
    { action: "resolve", agent: "worker", node: "T-ui-tests", ts: "2026-08-24T19:00:01.000Z" },
  ];
  const out = mod.recentActivity(entries, nodes);
  const addNode = out.find((e) => e.action === "add-node");
  assert.ok(addNode, "add-node event must be present");
  assert.equal(addNode.node_id, "K-ui-live-state");
  assert.equal(addNode.node_title, "State file se escribe con rename atomico");
  assert.equal(out.filter((e) => e.node_id === "K-ui-live-state").length, 1, "no duplicate rows for the same node");
});

test("recentActivity drops gone nodes and dedupes (action, node) rows", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const nodes = { T1: { id: "T1", title: "One" }, T2: { id: "T2", title: "Two" } };
  const entries = [
    { action: "take", node: "T1", ts: "a" },
    { action: "take", node: "T1", ts: "b" }, // duplicate — collapsed
    { action: "resolve", node: "T1", ts: "c" }, // different action — kept
    { action: "add-note", node: "T2", ts: "d" },
    { action: "resolve", node: "GHOST", ts: "e" }, // node missing — dropped
  ];
  const out = mod.recentActivity(entries, nodes);
  assert.deepEqual(
    out.map((e) => `${e.action}:${e.node_id}`),
    ["take:T1", "resolve:T1", "add-note:T2"]
  );
});

test("recentActivity caps at 8 and tolerates missing inputs", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const nodes = {};
  const entries = Array.from({ length: 20 }, (_, i) => ({ action: "update", node: `T${i}`, ts: String(i) }));
  for (let i = 0; i < 20; i++) {
    nodes[`T${i}`] = { id: `T${i}`, title: `Node ${i}` };
  }
  assert.equal(mod.recentActivity(entries, nodes).length, 8);
  assert.deepEqual(mod.recentActivity(undefined, undefined), []);
  assert.deepEqual(mod.recentActivity([], {}), []);
  assert.deepEqual(mod.recentActivity(null, null), []);
});

// --- initiativeRows --------------------------------------------------------

test("initiativeRows merges registered descriptions with the server breakdown", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const initiatives = {
    ui: { desc: "UI web read-only", created_at: "x" },
    v2: { desc: "V2 only", created_at: "y" },
  };
  const summary = [
    {
      initiative: "ui",
      total: 35,
      by_kind: {
        tasks: { total: 32, ready: 1, in_progress: 2, blocked: 3, backlog: 4, done: 18, archived: 0, canceled: 4 },
        gates: { open: 1 },
        knowledge: {},
      },
    },
  ];
  const rows = mod.initiativeRows(initiatives, summary);
  const byName = Object.fromEntries(rows.map((r) => [r.initiative, r]));
  assert.equal(byName.ui.desc, "UI web read-only");
  assert.equal(byName.ui.total, 32);
  assert.equal(byName.ui.by_kind.tasks.ready, 1);
  assert.equal(byName.ui.attention, 1 + 2 + 3 + 1);
  assert.ok(byName.v2, "registered initiative without nodes must produce a row");
  assert.equal(byName.v2.desc, "V2 only");
  assert.equal(byName.v2.total, 0);
  assert.equal(byName.v2.attention, 0);
});

test("initiativeRows sorts by attention first, then alphabetically", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const initiatives = { aaa: { desc: "" }, bbb: { desc: "" }, zzz: { desc: "" } };
  const summary = [
    {
      initiative: "bbb",
      total: 1,
      by_kind: { tasks: { total: 1, ready: 0, in_progress: 1, blocked: 0, backlog: 0, done: 0, archived: 0, canceled: 0 }, gates: { open: 0 } },
    },
    {
      initiative: "zzz",
      total: 5,
      by_kind: { tasks: { total: 5, ready: 0, in_progress: 0, blocked: 0, backlog: 0, done: 5, archived: 0, canceled: 0 }, gates: { open: 0 } },
    },
  ];
  const rows = mod.initiativeRows(initiatives, summary);
  assert.deepEqual(rows.map((r) => r.initiative), ["bbb", "aaa", "zzz"]);
});

test("initiativeRows tolerates missing inputs and summary-only entries", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  assert.deepEqual(mod.initiativeRows(undefined, undefined), []);
  assert.deepEqual(mod.initiativeRows({}, []), []);
  const rows = mod.initiativeRows({}, [{ initiative: "orphan", total: 2, by_kind: { tasks: { total: 2, done: 2 } } }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].initiative, "orphan");
  assert.equal(rows[0].desc, "");
});

// --- initiativeSegments ----------------------------------------------------

test("initiativeSegments builds task-state segments only (never mixes kinds)", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const row = {
    by_kind: {
      tasks: { ready: 1, in_progress: 2, blocked: 0, backlog: 3, done: 4, archived: 0, canceled: 5 },
      gates: { open: 9 },
      knowledge: { active: 7 },
    },
  };
  const segs = mod.initiativeSegments(row);
  assert.deepEqual(segs.map((s) => s.label), ["Ready", "In progress", "Blocked", "Backlog", "Done", "Archived", "Canceled"]);
  assert.deepEqual(segs.map((s) => s.count), [1, 2, 0, 3, 4, 0, 5]);
  assert.ok(!segs.some((s) => s.count === 9 || s.count === 7), "gates/knowledge must not leak into the task bar");
  const empty = mod.initiativeSegments(undefined);
  assert.equal(empty.length, 7);
  assert.ok(empty.every((s) => s.count === 0));
});

// --- projectRecord ---------------------------------------------------------

test("projectRecord returns the 7 record rows with real navigation targets", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const s = { done: 25, archived: 2, canceled: 9, superseded: 1, resolved_gates: 2, active_knowledge: 3, deprecated_knowledge: 1 };
  const rows = mod.projectRecord(s);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map((r) => r.label), ["Done", "Archived", "Canceled", "Superseded", "Resolved gates", "Active knowledge", "Deprecated knowledge"]);
  for (const r of rows) {
    assert.ok(["tasks", "gates", "knowledge"].includes(r.nav), `${r.label} must navigate to a real route`);
  }
  assert.equal(rows.find((r) => r.key === "done").value, 25);
  assert.equal(rows.find((r) => r.key === "deprecated_knowledge").value, 1);
});

test("projectRecord tolerates a missing summary (all zeros, real navs)", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  for (const empty of [undefined, null, {}]) {
    const rows = mod.projectRecord(empty);
    assert.equal(rows.length, 7);
    assert.ok(rows.every((r) => r.value === 0));
    assert.ok(rows.every((r) => ["tasks", "gates", "knowledge"].includes(r.nav)));
  }
});
