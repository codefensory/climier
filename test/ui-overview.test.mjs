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

// --- Render-level smoke ---------------------------------------------------

test("Overview.jsx default export is a Solid component (the view)", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  assert.equal(typeof mod.default, "function", "Overview.jsx default export must be a Solid component function");
});

test("Overview.jsx stays within the task file scope", { skip }, async (t) => {
  const { module: mod } = await compileOverview(t);
  const src = fs.readFileSync(OVERVIEW_FILE, "utf8");
  // Core piece: initiatives / recent activity / project record are NOT in
  // scope (they belong to T-ui-overview-context). The view must not render
  // that section in this file.
  assert.ok(!src.includes("Recent activity"), "Overview core must not render Recent activity (context piece)");
  assert.ok(!src.includes("Project record"), "Overview core must not render Project record (context piece)");
  assert.ok(!src.includes("initiative_summary"), "Overview core must not consume initiative_summary (context piece)");
  // Data flows from the store; primitives come from ../components.jsx only.
  assert.ok(src.includes('from "../store.jsx"'), "Overview.jsx must read state from the store");
  assert.ok(src.includes('from "../components.jsx"'), "Overview.jsx must use shared components");
  assert.equal(typeof mod.default, "function");
});
