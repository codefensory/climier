// Contract tests for ui/src/views/Overview.jsx (Fase 4 pieza core,
// T-ui-overview-core).
//
// What this file pins (docs/ui-redesign-plan.md section 5 points 1-5):
//   1. Operational status = exactly 4 metrics, fixed order, each with a
//      number, a one-line explanation and a real navigation target (nav is
//      never null — no metric card fakes a destination).
//   2. Global alerts are grouped by kind; unknown kinds still render with
//      a readable title/tone fallback.
//   3. Work now = real ready / in-progress task lists from the derived
//      pools + persisted status, limited to 4, tasks only. With the current
//      snapshot T-ui-tests must appear immediately.
//   4. Needs attention = stale / blocked / open gates / open decisions /
//      placeholders; all-zero input produces an empty array so the view
//      renders a single compact healthy line instead of dashed cards.
//   5. The view reads state from the store and components from
//      ../components.jsx only; it stays within the task's file scope.
//
// The pure helpers (buildMetrics, groupAlertsByKind, readyTasks,
// inProgressTasks, buildAttentionBlocks) are exported from Overview.jsx so
// we can test them with literal state objects, no DOM harness. The
// render-level smoke test uses the same babel-preset-solid compilation
// trick as ui-gates.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const UI_DIR = path.resolve("ui");
const UI_REQUIRE = createRequire(path.join(UI_DIR, "package.json"));
const babel = UI_REQUIRE("@babel/core");

const OVERVIEW_FILE = path.join(UI_DIR, "src", "views", "Overview.jsx");
const UI_DEPS_OK =
  fs.existsSync(path.join(UI_DIR, "node_modules", "solid-js")) &&
  fs.existsSync(path.join(UI_DIR, "node_modules", "@babel", "core"));
const skip = UI_DEPS_OK ? false : "ui dependencies not installed (run npm install in ui/)";

// Transform Overview.jsx with babel + the solid preset into a tmp file inside
// ui/src so node module resolution finds ui/node_modules for the relative
// `solid-js` import. The pure helpers live at module scope; the view's
// JSX imports are stubbed with inert values so the module compiles in a
// Node context. Mirrors test/ui-gates.test.mjs.
const tmpFiles = new Set();
function rewriteJsxImports(src) {
  let out = src;
  // Stub store imports — every named export is a callable that returns
  // empty/null signals when invoked as a hook.
  out = out.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']\.\.\/store\.jsx["'];?/g,
    (_m, names) => {
      const list = names
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      const stubLines = list
        .map((n) => {
          if (n === "useStore") {
            return `const useStore = () => ({ snapshot: () => null, select: () => {}, setRoute: () => {}, lastSuccessfulAt: () => null, refreshing: () => false, snapshotError: () => null });`;
          }
          return `const ${n} = () => null;`;
        })
        .join("\n");
      return stubLines;
    },
  );
  // Stub shell.mjs (pure helper used for the header name).
  out = out.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']\.\.\/shell\.mjs["'];?/g,
    (_m, names) => {
      const list = names
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      const stubLines = list
        .map((n) => (n === "projectDisplayName" ? `const projectDisplayName = () => "proj";` : `const ${n} = () => null;`))
        .join("\n");
      return stubLines;
    },
  );
  // Stub components imports — every named export is a no-op component that
  // returns null when rendered.
  out = out.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']\.\.\/components\.jsx["'];?/g,
    (_m, names) => {
      const list = names
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      const stubLines = list
        .map((n) => {
          if (n === "kindFor") {
            return `const kindFor = (n) => { if (!n) return "task"; if (n.kind === "knowledge") return "knowledge"; if (n.subkind === "gate") return "gate"; return "task"; };`;
          }
          return `const ${n} = () => null;`;
        })
        .join("\n");
      return stubLines;
    },
  );
  return out;
}

async function compileOverview(t) {
  const rawSource = fs.readFileSync(OVERVIEW_FILE, "utf8");
  const source = rewriteJsxImports(rawSource);
  const out = await babel.transformAsync(source, {
    filename: OVERVIEW_FILE,
    sourceType: "module",
    presets: [
      [UI_REQUIRE.resolve("babel-preset-solid"), { generate: "ssr", hydratable: false }],
    ],
  });
  const dir = path.join(UI_DIR, "src", "views");
  const file = path.join(dir, `.Overview.compiled.${process.pid}.${Date.now()}.mjs`);
  fs.writeFileSync(file, out.code, "utf8");
  tmpFiles.add(file);
  const cleanup = () => {
    tmpFiles.delete(file);
    return fs.promises.unlink(file).catch(() => {});
  };
  if (t && typeof t.after === "function") t.after(cleanup);
  const module = await import(pathToFileURL(file).href);
  return { module, cleanup };
}

process.on("exit", () => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch {}
  }
});

// --- Helpers expected to be exported by Overview.jsx ---------------------

const REQUIRED_EXPORTS = [
  "buildMetrics",
  "groupAlertsByKind",
  "readyTasks",
  "inProgressTasks",
  "buildAttentionBlocks",
  "humanizeAction",
  "activityNodeId",
  "recentActivity",
  "initiativeRows",
  "initiativeSegments",
  "projectRecord",
];

test("Overview.jsx exports the pure helpers the contract depends on", { skip }, async (t) => {
  assert.ok(fs.existsSync(OVERVIEW_FILE), `${OVERVIEW_FILE} must exist`);
  const { module: mod } = await compileOverview(t);
  for (const name of REQUIRED_EXPORTS) {
    assert.equal(typeof mod[name], "function", `expected ${name} to be exported as a function`);
  }
  assert.equal(typeof mod.default, "function", "Overview.jsx must export the view as default");
});

// --- buildMetrics --------------------------------------------------------

test("buildMetrics returns exactly the 4 primary metrics in fixed order", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const m = mod.buildMetrics({ ready: 3, in_progress: 2, blocked: 1, backlog: 4 });
  assert.equal(m.length, 4);
  assert.deepEqual(
    m.map((x) => x.label),
    ["Ready", "In progress", "Blocked", "Backlog"],
    "metric order must be Ready / In progress / Blocked / Backlog",
  );
  assert.equal(m[0].value, 3);
  assert.equal(m[1].value, 2);
  assert.equal(m[2].value, 1);
  assert.equal(m[3].value, 4);
});

test("buildMetrics gives every metric a one-line explanation and a real nav target", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const m = mod.buildMetrics({});
  for (const x of m) {
    assert.ok(x.explanation && x.explanation.length > 0, `${x.label} must carry an explanation`);
    assert.ok(x.nav, `${x.label} must have a navigation destination (no fake clickable)`);
  }
});

test("buildMetrics tolerates a missing/empty summary (all zeros, never NaN)", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  for (const empty of [undefined, null, {}]) {
    const m = mod.buildMetrics(empty);
    assert.equal(m.length, 4);
    for (const x of m) {
      assert.equal(x.value, 0, `${x.label} value must default to 0`);
    }
  }
});

// --- groupAlertsByKind ---------------------------------------------------

test("groupAlertsByKind groups alerts by kind preserving first-seen order", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const alerts = [
    { kind: "stale-claim", node_id: "T1", message: "stale" },
    { kind: "state-read-error", message: "read failed" },
    { kind: "stale-claim", node_id: "T2", message: "also stale" },
  ];
  const groups = mod.groupAlertsByKind(alerts);
  assert.deepEqual(groups.map(([k]) => k), ["stale-claim", "state-read-error"]);
  assert.equal(groups[0][1].length, 2);
  assert.equal(groups[1][1].length, 1);
});

test("groupAlertsByKind buckets unknown/missing kinds safely", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  assert.deepEqual(mod.groupAlertsByKind(undefined), []);
  assert.deepEqual(mod.groupAlertsByKind(null), []);
  const groups = mod.groupAlertsByKind([{ message: "no kind" }, null, {}]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0][0], "unknown");
  assert.equal(groups[0][1].length, 3);
});

// --- readyTasks ----------------------------------------------------------

test("readyTasks surfaces T-ui-tests from the derived pool immediately", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const derived = { ready: ["T-ui-tests", "T-other"], blocked: [], backlog: [], openGates: [] };
  const nodes = {
    "T-ui-tests": { id: "T-ui-tests", subkind: "task", title: "Tests del comando ui" },
    "T-other": { id: "T-other", subkind: "task", title: "Other" },
    "G-open": { id: "G-open", subkind: "gate", title: "Gate" }, // not a task
  };
  const list = mod.readyTasks(derived, nodes);
  const ids = list.map((n) => n.id);
  assert.deepEqual(ids, ["T-ui-tests", "T-other"]);
  assert.equal(list[0].title, "Tests del comando ui");
});

test("readyTasks excludes non-task nodes (gates) and respects the limit", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const derived = { ready: ["T1", "T2", "T3", "T4", "T5", "G1"] };
  const nodes = {
    T1: { id: "T1", subkind: "task" },
    T2: { id: "T2", subkind: "task" },
    T3: { id: "T3", subkind: "task" },
    T4: { id: "T4", subkind: "task" },
    T5: { id: "T5", subkind: "task" },
    G1: { id: "G1", subkind: "gate" },
  };
  assert.equal(mod.readyTasks(derived, nodes).length, 4);
  assert.equal(mod.readyTasks(derived, nodes, 10).length, 5, "higher limit includes all tasks");
  assert.deepEqual(mod.readyTasks(undefined, undefined), []);
  assert.deepEqual(mod.readyTasks({ ready: [] }, {}), []);
});

// --- inProgressTasks -----------------------------------------------------

test("inProgressTasks lists only in_progress tasks, stable order, capped", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const nodes = {
    Tb: { id: "Tb", subkind: "task", status: "in_progress" },
    Ta: { id: "Ta", subkind: "task", status: "in_progress" },
    Tc: { id: "Tc", subkind: "task", status: "done" },
    Td: { id: "Td", subkind: "task", status: "open" },
    G1: { id: "G1", subkind: "gate", status: "in_progress" }, // gates excluded
  };
  const list = mod.inProgressTasks(nodes);
  assert.deepEqual(list.map((n) => n.id), ["Ta", "Tb"], "in-progress tasks must be id-ascending and tasks only");
  const capped = mod.inProgressTasks(
    {
      a: { id: "a", subkind: "task", status: "in_progress" },
      b: { id: "b", subkind: "task", status: "in_progress" },
      c: { id: "c", subkind: "task", status: "in_progress" },
      d: { id: "d", subkind: "task", status: "in_progress" },
      e: { id: "e", subkind: "task", status: "in_progress" },
    },
    2
  );
  assert.equal(capped.length, 2);
  assert.deepEqual(mod.inProgressTasks(undefined), []);
});

// --- buildAttentionBlocks ------------------------------------------------

test("buildAttentionBlocks returns empty when everything is healthy (zero stale/blocked/gates/decisions/placeholders)", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const out = mod.buildAttentionBlocks({
    alerts: [],
    derived: { ready: [], blocked: [], backlog: [], openGates: [] },
    nodes: {},
  });
  assert.deepEqual(out, [], "zero issues must produce no blocks (single compact healthy line)");
});

test("buildAttentionBlocks surfaces stale claims from alerts", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const out = mod.buildAttentionBlocks({
    alerts: [{ kind: "stale-claim", node_id: "T9", message: "T9 claimed by alice is stale (130m old)" }],
    derived: { ready: [], blocked: [], backlog: [], openGates: [] },
    nodes: {},
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Stale");
  assert.equal(out[0].items[0].id, "T9");
});

test("buildAttentionBlocks surfaces blocked tasks, open gates, open decisions and placeholders", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const out = mod.buildAttentionBlocks({
    alerts: [],
    derived: {
      ready: [],
      blocked: ["T-B"],
      backlog: [],
      openGates: ["G-APPROVAL"],
    },
    nodes: {
      "T-B": { id: "T-B", subkind: "task", title: "Blocked task" },
      "G-APPROVAL": { id: "G-APPROVAL", subkind: "gate", title: "Needs approval" },
      "G-DEC": { id: "G-DEC", subkind: "gate", status: "open", purpose: "decision", title: "Decide X" },
      "G-DONE": { id: "G-DONE", subkind: "gate", status: "resolved", purpose: "decision", title: "Done" },
      "T-PH": { id: "T-PH", subkind: "task", placeholder: true, title: "Placeholder idea" },
    },
  });
  const titles = out.map((b) => b.title);
  assert.ok(titles.includes("Blocked"), `expected Blocked block, got ${titles.join(",")}`);
  assert.ok(titles.includes("Open gates"), `expected Open gates block, got ${titles.join(",")}`);
  assert.ok(titles.includes("Open decisions"), `expected Open decisions block, got ${titles.join(",")}`);
  assert.ok(titles.includes("Placeholders"), `expected Placeholders block, got ${titles.join(",")}`);
  const decisions = out.find((b) => b.title === "Open decisions");
  assert.deepEqual(decisions.items.map((i) => i.id), ["G-DEC"], "only open purpose=decision gates count");
});

test("buildAttentionBlocks tolerates missing inputs", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  assert.deepEqual(mod.buildAttentionBlocks(undefined), []);
  assert.deepEqual(mod.buildAttentionBlocks({}), []);
  assert.deepEqual(mod.buildAttentionBlocks({ alerts: null, derived: null, nodes: null }), []);
});

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
  for (let i = 0; i < 20; i++) nodes[`T${i}`] = { id: `T${i}`, title: `Node ${i}` };
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

// --- Render-level smoke ---------------------------------------------------

test("Overview.jsx default export is a Solid component (the view)", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  assert.equal(typeof mod.default, "function", "Overview.jsx default export must be a Solid component function");
});

test("Overview.jsx covers the full Fase 4 contract and stays within its file scope", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const src = fs.readFileSync(OVERVIEW_FILE, "utf8");
  // Context piece (T-ui-overview-context) is now part of this file:
  assert.ok(src.includes("Recent activity"), "Overview must render Recent activity (point 7)");
  assert.ok(src.includes("Project record"), "Overview must render Project record (point 8)");
  assert.ok(src.includes("initiative_summary"), "Overview must consume initiative_summary (point 6)");
  assert.ok(src.includes("ProgressBar"), "Overview must use the segmented ProgressBar for initiatives (point 6)");
  // Data flows from the store; primitives come from ../components.jsx only.
  // The import set is the whole contract surface: no server/state access,
  // no new relative imports outside ui/src.
  const imports = [...src.matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["../components.jsx", "../shell.mjs", "../store.jsx", "solid-js"].sort());
  assert.equal(typeof mod.default, "function");
});
