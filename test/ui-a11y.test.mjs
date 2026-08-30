// F7a a11y + data-state audit (T-ui-a11y).
//
// What this file pins (docs/ui-redesign-plan.md section 6-Fase 7):
//   1. State-read-error is a shell-level alert: the shell (Main) surfaces
//      it as a high-priority banner regardless of the active view, and
//      views filter it out of their own per-kind alert groups to avoid
//      duplication. Pure helpers: shell.mjs `stateReadAlert` and
//      Overview.jsx `pageAlerts`.
//   2. Activity rows are keyboard-operable: the expand/collapse affordance
//      is a real <button> with an accessible name + aria-expanded, not a
//      clickable <tr> (which is unreachable by keyboard and mis-announced).
//   3. Truncated titles/previews carry an accessible tooltip (title attr)
//      in Board, Gates and Knowledge so mouse users and AT both get the
//      full text.
//   4. The server snapshot stays correct across the four data fixtures:
//      uninitialized / empty / sparse / ~200 nodes.
//
// Tests that need the ui deps skip like ui-live.test.mjs when
// ui/node_modules is missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  createTempProject,
  rmTempProject,
  writeState,
} from "./helpers.mjs";

const UI_DIR = path.resolve("ui");
const SERVER_FILE = path.resolve("ui/server/server.mjs");
const UI_DEPS_OK =
  fs.existsSync(path.resolve("ui/node_modules/express")) &&
  fs.existsSync(path.resolve("ui/node_modules/solid-js")) &&
  fs.existsSync(path.resolve("ui/node_modules/@babel/core"));
const skip = UI_DEPS_OK ? false : "ui dependencies not installed (run npm install in ui/)";

const serverMod = await import(pathToFileURL(SERVER_FILE).href);
const UI_REQUIRE = createRequire(path.join(UI_DIR, "package.json"));
const babel = UI_REQUIRE("@babel/core");

async function startServer(projectDir) {
  const started = await serverMod.start({ projectDir, port: 0, log: () => {} });
  const port = started.server.address().port;
  return { base: `http://127.0.0.1:${port}`, server: started.server };
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function getJson(url) {
  const r = await fetch(url);
  assert.equal(r.status, 200, `GET ${url} failed`);
  return r.json();
}

// === shell.mjs stateReadAlert =============================================
// The shell needs a single source of truth for "is the state file currently
// unreadable?" so every view inherits the banner. Pure helper in shell.mjs
// (already the pure shell-module home) so Main can render it without
// re-implementing the kind check.

import { stateReadAlert } from "../ui/src/shell.mjs";

test("stateReadAlert finds the state-read-error alert in the snapshot alerts", () => {
  const alerts = [
    { kind: "stale-claim", severity: "warning", node_id: "T1", message: "stale" },
    { kind: "state-read-error", severity: "error", message: "read failed" },
  ];
  const found = stateReadAlert(alerts);
  assert.ok(found, "stateReadAlert must find the state-read-error alert");
  assert.equal(found.kind, "state-read-error");
  assert.equal(found.message, "read failed");
});

test("stateReadAlert returns null when there is no state-read-error alert", () => {
  assert.equal(stateReadAlert([]), null);
  assert.equal(stateReadAlert(null), null);
  assert.equal(stateReadAlert(undefined), null);
  assert.equal(stateReadAlert([{ kind: "stale-claim", message: "stale" }]), null);
});

// === Overview pageAlerts ===================================================
// Views must not duplicate the shell-level state-read-error banner. The
// overview's grouped-alert helper stays generic; `pageAlerts` is the
// view-level filter that drops shell-owned kinds.

const tmpFiles = new Set();
function rewriteJsxImports(src) {
  let out = src;
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

async function compileJsx(file, rewrite, t) {
  const rawSource = fs.readFileSync(file, "utf8");
  const source = rewrite ? rewrite(rawSource) : rawSource;
  const out = await babel.transformAsync(source, {
    filename: file,
    sourceType: "module",
    presets: [
      [UI_REQUIRE.resolve("babel-preset-solid"), { generate: "ssr", hydratable: false }],
    ],
  });
  const dir = path.dirname(file);
  const base = path.basename(file, ".jsx");
  const tmp = path.join(dir, `.${base}.compiled.${process.pid}.${Date.now()}.mjs`);
  fs.writeFileSync(tmp, out.code, "utf8");
  tmpFiles.add(tmp);
  const cleanup = () => {
    tmpFiles.delete(tmp);
    return fs.promises.unlink(tmp).catch(() => {});
  };
  if (t && typeof t.after === "function") t.after(cleanup);
  const module = await import(pathToFileURL(tmp).href);
  return { module, cleanup };
}

process.on("exit", () => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch {}
  }
});

const OVERVIEW_FILE = path.join(UI_DIR, "src", "views", "Overview.jsx");

test("Overview.jsx exports pageAlerts and it drops shell-level alerts", { skip }, async (t) => {
  const { module: mod } = await compileJsx(OVERVIEW_FILE, rewriteJsxImports, t);
  assert.equal(typeof mod.pageAlerts, "function", "pageAlerts must be exported");
  const alerts = [
    { kind: "stale-claim", severity: "warning", node_id: "T1", message: "stale" },
    { kind: "state-read-error", severity: "error", message: "read failed" },
  ];
  const page = mod.pageAlerts(alerts);
  assert.deepEqual(
    page.map((a) => a.kind),
    ["stale-claim"],
    "state-read-error belongs to the shell banner, not the page alert groups",
  );
  assert.deepEqual(mod.pageAlerts([]), []);
  assert.deepEqual(mod.pageAlerts(null), []);
});

// === Activity keyboard operability =========================================
// The expand/collapse affordance must be a real <button> (keyboard
// reachable, correct accessible name). We extract `ActivityRow` so the
// contract is testable without a DOM.

function rewriteActivityImports(src) {
  let out = src;
  out = out.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']\.\.\/store\.jsx["'];?/g,
    () => "const useStore = () => ({ select: () => {} });",
  );
  out = out.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']\.\.\/api\.js["'];?/g,
    () => "const getActivity = async () => ({ entries: [], total: 0, facets: { actions: [], agents: [] } });",
  );
  out = out.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']\.\.\/components\.jsx["'];?/g,
    (_m, names) => {
      const list = names
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      const stubLines = list
        .map((n) => {
          if (n === "fmtTime") return `const fmtTime = () => "just now";`;
          return `const ${n} = () => null;`;
        })
        .join("\n");
      return stubLines;
    },
  );
  return out;
}

const ACTIVITY_FILE = path.join(UI_DIR, "src", "views", "Activity.jsx");

test("Activity.jsx exports ActivityRow with a real expand/collapse button", { skip }, async (t) => {
  const { module: mod } = await compileJsx(ACTIVITY_FILE, rewriteActivityImports, t);
  assert.equal(typeof mod.ActivityRow, "function", "ActivityRow must be exported for keyboard testing");
  const { renderToString } = await UI_REQUIRE("solid-js/web");

  const entry = {
    ts: new Date().toISOString(),
    action: "take",
    agent: "alice",
    node_id: "T1",
    node_title: "Skeleton",
    note: "claimed by alice for the a11y pass",
  };

  const collapsed = renderToString(() =>
    mod.ActivityRow({ entry, expanded: false, onToggle: () => {}, onSelect: () => {} }),
  );
  // The expand affordance is a <button> (keyboard reachable) with the
  // accessible name and aria-expanded; it must NOT be a clickable <tr>.
  assert.ok(collapsed.includes("<button"), "ActivityRow must render a real <button> for expand");
  assert.ok(!/<tr[^>]*tabindex/.test(collapsed), "expand must not rely on a focusable <tr>");
  assert.match(collapsed, /aria-label="Expand full note"/, "expand button must have an accessible name");
  assert.match(collapsed, /aria-expanded="false"/, "collapsed row must advertise aria-expanded=false");
  assert.ok(collapsed.includes("claimed by alice for the a11y pass"), "note preview stays visible");

  const expanded = renderToString(() =>
    mod.ActivityRow({ entry, expanded: true, onToggle: () => {}, onSelect: () => {} }),
  );
  assert.match(expanded, /aria-label="Collapse full note"/, "expanded button announces collapse");
  assert.match(expanded, /aria-expanded="true"/, "expanded row must advertise aria-expanded=true");
  assert.ok(expanded.includes("Full note"), "expanded row must render the full-note section");
});

// === Truncation tooltips (source-level contract) ==========================
// The truncated title/preview elements in Board / Gates / Knowledge must
// carry a title attribute so the full text is reachable for mouse users and
// for assistive tech. Source greps pin the pattern (same technique as
// test/ui-shell-layout.test.mjs for App.jsx).

test("Board card and gate-card truncated text carries a title tooltip", () => {
  const src = fs.readFileSync(path.join(UI_DIR, "src", "views", "Board.jsx"), "utf8");
  // Card title (line-clamped) -> full title tooltip.
  assert.match(
    src,
    /line-clamp-2[^>]*text-ink"[\s\S]*?title=\{n\(\)\.title\}/,
    "Board card title must expose the full title via title= tooltip",
  );
  // Principal blocker callout title.
  assert.match(
    src,
    /line-clamp-1 text-ink[\s\S]*?title=\{props\.principalBlocker\.title\}/,
    "Board blocker callout must expose the full blocker title",
  );
  // Open-gates rail card title.
  assert.match(
    src,
    /line-clamp-2[^>]*font-semibold[\s\S]*?title=\{gate\(\)\.title\}/,
    "Open gates rail card title must expose the full title",
  );
});

test("Gates rows expose full title and rationale preview via title tooltip", () => {
  const src = fs.readFileSync(path.join(UI_DIR, "src", "views", "Gates.jsx"), "utf8");
  assert.match(
    src,
    /truncate text-\[13px\] leading-5 font-medium text-ink[\s\S]*?title=\{gate\(\)\.title\}/,
    "GateRow title must expose the full title via title= tooltip",
  );
  assert.match(
    src,
    /line-clamp-2[\s\S]*?title=\{previewLines\(gate\(\)\.resolution\.rationale, 2\)\}/,
    "GateRow resolution preview must expose the full rationale via title= tooltip",
  );
});

test("Knowledge card body preview exposes the full body via title tooltip", () => {
  const src = fs.readFileSync(path.join(UI_DIR, "src", "views", "Knowledge.jsx"), "utf8");
  assert.match(
    src,
    /whitespace-pre-wrap text-\[13px\] leading-5 text-body["'][\s\S]*?title=\{k\(\)\.body\}/,
    "Knowledge body preview must expose the full body via title= tooltip",
  );
});

// === Data fixtures =========================================================
// The four fixtures the plan requires: uninitialized / empty / sparse /
// ~200 nodes. The server snapshot must stay well-formed in every case so
// the views have the data they need (correct initialized flag, zero-safe
// summary, derived pools that match the graph).

function emptyState() {
  return {
    version: 2,
    nodes: {},
    edges: [],
    initiatives: {},
    log: [],
  };
}

function sparseState() {
  return {
    version: 2,
    nodes: {
      "S.T1": { id: "S.T1", kind: "resolvable", subkind: "task", title: "First sparse task", initiative: "sparse", status: "open", revision: 1 },
      "S.T2": { id: "S.T2", kind: "resolvable", subkind: "task", title: "Second sparse task", initiative: "sparse", status: "open", revision: 1 },
      "S.G1": { id: "S.G1", kind: "resolvable", subkind: "gate", title: "Sparse gate", initiative: "sparse", status: "open", purpose: "decision", revision: 1 },
      "S.K1": { id: "S.K1", kind: "knowledge", title: "Sparse knowledge", initiative: "sparse", status: "active", knowledge_type: "fact", revision: 1 },
    },
    edges: [
      { from: "S.T1", to: "S.T2", type: "BLOCKS" },
      { from: "S.G1", to: "S.T2", type: "BLOCKS" },
    ],
    initiatives: { sparse: { desc: "Sparse fixture", created_at: "2026-01-01T00:00:00.000Z" } },
    log: [
      { action: "add-node", node: "S.T1", agent: "fixture", ts: new Date().toISOString(), note: "S.T1" },
    ],
  };
}

function bigState(count = 200) {
  const nodes = {};
  const edges = [];
  for (let i = 0; i < count; i++) {
    const id = `B-${String(i).padStart(3, "0")}`;
    const initiative = i % 3 === 0 ? "alpha" : i % 3 === 1 ? "beta" : "gamma";
    nodes[id] = {
      id,
      kind: "resolvable",
      subkind: "task",
      title: `Fixture task ${i} with a descriptive title long enough to exercise truncation in every view`,
      initiative,
      status: "open",
      revision: 1,
    };
    if (i > 0) edges.push({ from: `B-${String(i - 1).padStart(3, "0")}`, to: id, type: "BLOCKS" });
  }
  nodes["B-GATE"] = { id: "B-GATE", kind: "resolvable", subkind: "gate", title: "Fixture gate", initiative: "alpha", status: "open", purpose: "decision", revision: 1 };
  nodes["B-KNOW"] = { id: "B-KNOW", kind: "knowledge", title: "Fixture knowledge", initiative: "beta", status: "active", knowledge_type: "fact", revision: 1 };
  return { version: 2, nodes, edges, initiatives: { alpha: { desc: "a" }, beta: { desc: "b" }, gamma: { desc: "c" } }, log: [] };
}

test("fixture: uninitialized project reports initialized=false with zero-safe snapshot", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const snap = await getJson(`${base}/api/snapshot`);
  assert.equal(snap.project.initialized, false);
  assert.deepEqual(snap.nodes, {});
  assert.deepEqual(snap.derived, { ready: [], blocked: [], backlog: [], openGates: [] });
  assert.equal(snap.summary.total_nodes, 0);
  assert.equal(snap.summary.ready, 0);
  assert.ok(Array.isArray(snap.initiative_summary));
});

test("fixture: empty initialized project keeps zero-safe summary and no derived pools", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  await writeState(dir, emptyState());

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const snap = await getJson(`${base}/api/snapshot`);
  assert.equal(snap.project.initialized, true);
  assert.equal(snap.summary.total_nodes, 0);
  assert.deepEqual(snap.derived, { ready: [], blocked: [], backlog: [], openGates: [] });
  assert.equal(snap.summary.ready, 0);
  assert.equal(snap.summary.blocked, 0);
  assert.deepEqual(snap.alerts, []);
});

test("fixture: sparse project derives ready/blocked/gates from its tiny graph", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  await writeState(dir, sparseState());

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const snap = await getJson(`${base}/api/snapshot`);
  assert.equal(snap.project.initialized, true);
  assert.equal(snap.summary.total_nodes, 4);
  // S.T1 is ready; S.T2 is blocked by S.T1 + S.G1.
  assert.deepEqual(snap.derived.ready, ["S.T1"]);
  assert.deepEqual(snap.derived.blocked, ["S.T2"]);
  assert.deepEqual(snap.derived.openGates, ["S.G1"]);
  assert.equal(snap.summary.ready, 1);
  assert.equal(snap.summary.blocked, 1);
  assert.equal(snap.summary.open_gates, 1);
  assert.equal(snap.summary.active_knowledge, 1);
  // recent_activity normalizes the add-node entry.
  assert.ok(snap.recent_activity.some((e) => e.node_id === "S.T1" && e.node_title === "First sparse task"));
  // Node detail for the blocked task shows its incoming blockers.
  const detail = await getJson(`${base}/api/node/S.T2`);
  assert.ok(detail.blocking.some((b) => b.node && b.node.id === "S.T1"));
});

test("fixture: ~200-node project stays coherent and derivable", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  await writeState(dir, bigState(200));

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const snap = await getJson(`${base}/api/snapshot`);
  assert.equal(snap.project.initialized, true);
  assert.equal(snap.summary.total_nodes, 202); // 200 tasks + gate + knowledge
  assert.equal(Object.keys(snap.nodes).length, 202);
  // Chain B-000 -> B-001 -> ... -> B-199: only B-000 is ready, the rest
  // are blocked by their predecessor. The gate/knowledge don't land in
  // task pools.
  assert.deepEqual(snap.derived.ready, ["B-000"]);
  assert.equal(snap.derived.blocked.length, 199);
  assert.deepEqual(snap.derived.openGates, ["B-GATE"]);
  assert.equal(snap.summary.ready, 1);
  assert.equal(snap.summary.blocked, 199);
  // Knowledge is active and counted.
  assert.equal(snap.summary.active_knowledge, 1);
  // Initiative breakdown covers all three fixtures.
  assert.equal(snap.initiative_summary.length, 3);
  // Node detail stays fast and well-formed for a mid-chain node.
  const detail = await getJson(`${base}/api/node/B-100`);
  assert.ok(detail.blocking.some((b) => b.node && b.node.id === "B-099"));
});
