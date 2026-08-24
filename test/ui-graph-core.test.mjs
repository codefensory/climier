// Contract tests for ui/src/views/graph-helpers.mjs + ui/src/views/Graph.jsx
// (Fase 5C pieza 1 — core: layout, pan/zoom, arrows, node labels).
//
// Why this file exists:
//   - Fase 5C ships the core graph mechanics (layout, pan/zoom, arrows,
//     node labels). The Fase 5C task body defines what those mechanics
//     must do; this test pins the contract:
//       * computeAdjacency builds incoming/outgoing Maps in one pass and
//         drops edges that point at unknown nodes without throwing;
//       * computeLayout is pure, uses the adjacency maps (no repeated
//         edge.filter scans), assigns monotonically increasing depth via
//         BLOCKS edges, and survives cycles;
//       * clipToBox terminates a line at the boundary of a target box so
//         arrowheads land on the edge, not under the shape;
//       * fitTransform picks a scale + translate that puts the whole graph
//         inside the viewport with a margin;
//       * abbreviate trims long titles with an ellipsis and keeps short
//         titles untouched;
//       * buildEdgePath produces a non-empty SVG `d` string whose
//         endpoint sits on the target box boundary;
//       * shouldShowIsolationCallout fires only when there are visible
//         nodes, no visible edges, and the full graph is non-empty;
//       * kindFor collapses the umbrella 'resolvable' kind into the real
//         dashboard kind (task / gate / knowledge).
//   - Graph.jsx compiles cleanly under babel-preset-solid (smoke test).
//
// The helpers live in graph-helpers.mjs (plain ESM, no JSX) so Node can
// import them directly. The component test compiles Graph.jsx on the fly
// the same way ui-components.test.mjs does for components.jsx, but only
// checks that the default export exists and compiles — the helper
// coverage above is what pins the actual contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const UI_DIR = path.resolve("ui");
const UI_REQUIRE = createRequire(path.join(UI_DIR, "package.json"));
const babel = UI_REQUIRE("@babel/core");

const HELPERS_FILE = path.join(UI_DIR, "src", "views", "graph-helpers.mjs");
const GRAPH_FILE = path.join(UI_DIR, "src", "views", "Graph.jsx");

const UI_DEPS_OK = fs.existsSync(path.join(UI_DIR, "node_modules", "solid-js"))
  && fs.existsSync(path.join(UI_DIR, "node_modules", "@babel", "core"));
const skip = UI_DEPS_OK ? false : "ui dependencies not installed (run npm install in ui/)";

// === Helpers module ========================================================

test("graph-helpers.mjs exists and exports the documented helpers", { skip }, async (t) => {
  assert.ok(fs.existsSync(HELPERS_FILE), `${HELPERS_FILE} must exist`);
  const mod = await import(pathToFileURL(HELPERS_FILE).href);
  for (const name of [
    "NODE_W",
    "NODE_H",
    "kindFor",
    "computeAdjacency",
    "computeLayout",
    "nodeBox",
    "clipToBox",
    "fitTransform",
    "abbreviate",
    "buildEdgePath",
    "shouldShowIsolationCallout",
  ]) {
    assert.ok(name in mod, `graph-helpers.mjs must export ${name}`);
  }
});

test("kindFor collapses 'resolvable' into the dashboard kind (task / gate / knowledge)", { skip }, async (t) => {
  const mod = await import(pathToFileURL(HELPERS_FILE).href);
  assert.equal(typeof mod.kindFor, "function");
  assert.equal(mod.kindFor({ kind: "resolvable" }), "task");
  assert.equal(mod.kindFor({ kind: "resolvable", subkind: "gate" }), "gate");
  assert.equal(mod.kindFor({ kind: "knowledge" }), "knowledge");
  assert.equal(mod.kindFor({ kind: "task" }), "task");
  assert.equal(mod.kindFor(undefined), "task");
  assert.equal(mod.kindFor(null), "task");
});

test("computeAdjacency builds incoming/outgoing Maps in one pass", { skip }, async (t) => {
  const mod = await import(pathToFileURL(HELPERS_FILE).href);
  const nodes = { A: {}, B: {}, C: {}, D: {} };
  const edges = [
    { from: "A", to: "B", type: "BLOCKS" },
    { from: "A", to: "C", type: "BLOCKS" },
    { from: "B", to: "C", type: "BLOCKS" },
    { from: "D", to: "A", type: "BLOCKS" },
  ];
  const { incoming, outgoing } = mod.computeAdjacency(nodes, edges);
  assert.ok(incoming instanceof Map, "incoming must be a Map");
  assert.ok(outgoing instanceof Map, "outgoing must be a Map");
  assert.equal(incoming.get("A").length, 1);
  assert.equal(incoming.get("B").length, 1);
  assert.equal(incoming.get("C").length, 2);
  assert.equal(incoming.get("D").length, 0);
  assert.equal(outgoing.get("A").length, 2);
  assert.equal(outgoing.get("B").length, 1);
  assert.equal(outgoing.get("C").length, 0);
  // Edges referring to unknown nodes are dropped, not thrown.
  const nodes2 = { A: {} };
  const edges2 = [{ from: "X", to: "A", type: "BLOCKS" }];
  const r = mod.computeAdjacency(nodes2, edges2);
  assert.equal(r.outgoing.get("A").length, 0);
  assert.equal(r.incoming.get("A").length, 1);
});

test("computeLayout assigns monotonically increasing depth via BLOCKS edges", { skip }, async (t) => {
  const mod = await import(pathToFileURL(HELPERS_FILE).href);
  // A -> B -> C (B blocked by A; C blocked by B).
  const nodes = {
    A: { id: "A", kind: "resolvable", subkind: "task", initiative: "ui" },
    B: { id: "B", kind: "resolvable", subkind: "task", initiative: "ui" },
    C: { id: "C", kind: "resolvable", subkind: "task", initiative: "ui" },
  };
  const edges = [
    { from: "A", to: "B", type: "BLOCKS" },
    { from: "B", to: "C", type: "BLOCKS" },
  ];
  const layout = mod.computeLayout(nodes, edges);
  assert.ok(layout.pos.A, "A must have a position");
  assert.ok(layout.pos.B, "B must have a position");
  assert.ok(layout.pos.C, "C must have a position");
  assert.ok(layout.pos.B.x > layout.pos.A.x, "B (blocked) must be deeper than A");
  assert.ok(layout.pos.C.x > layout.pos.B.x, "C (blocked by B) must be deeper than B");
  assert.ok(Number.isInteger(layout.depth.A) && layout.depth.A >= 1);
  assert.ok(layout.depth.B > layout.depth.A, "depth B must be greater than depth A");
  assert.ok(layout.depth.C > layout.depth.B, "depth C must be greater than depth B");
  assert.ok(layout.width >= layout.pos.C.x, "layout width must accommodate the deepest node");
});

test("computeLayout survives cycles (no infinite recursion, every member visible)", { skip }, async (t) => {
  const mod = await import(pathToFileURL(HELPERS_FILE).href);
  // A <-> B mutual BLOCKS (shouldn't happen in practice but the layout
  // must not crash).
  const nodes = {
    A: { id: "A", kind: "resolvable", subkind: "task", initiative: "ui" },
    B: { id: "B", kind: "resolvable", subkind: "task", initiative: "ui" },
  };
  const edges = [
    { from: "A", to: "B", type: "BLOCKS" },
    { from: "B", to: "A", type: "BLOCKS" },
  ];
  const layout = mod.computeLayout(nodes, edges);
  assert.ok(layout.pos.A, "A must have a position despite the cycle");
  assert.ok(layout.pos.B, "B must have a position despite the cycle");
  assert.ok(Number.isInteger(layout.depth.A) && layout.depth.A >= 1);
  assert.ok(Number.isInteger(layout.depth.B) && layout.depth.B >= 1);
});

test("computeLayout with no edges gives every node depth 1 and assigns positions", { skip }, async (t) => {
  const mod = await import(pathToFileURL(HELPERS_FILE).href);
  const nodes = {
    A: { id: "A", kind: "resolvable", subkind: "task", initiative: "ui" },
    B: { id: "B", kind: "resolvable", subkind: "task", initiative: "ui" },
  };
  const layout = mod.computeLayout(nodes, []);
  assert.equal(layout.depth.A, 1);
  assert.equal(layout.depth.B, 1);
  assert.ok(
    layout.pos.A.x !== layout.pos.B.x || layout.pos.A.y !== layout.pos.B.y,
    "different nodes must not overlap exactly",
  );
});

test("clipToBox terminates the line at the target box boundary (not the center)", { skip }, async (t) => {
  const mod = await import(pathToFileURL(HELPERS_FILE).href);
  // Line from (0, 0) heading right toward (200, 0); box at (150, -10)-(170, 10).
  // The boundary hit should be at x=150, y=0.
  const box = { left: 150, right: 170, top: -10, bottom: 10 };
  const p = mod.clipToBox(0, 0, 200, 0, box);
  assert.equal(Math.round(p.x), 150);
  assert.equal(Math.round(p.y), 0);

  // Diagonal into the top-left corner of a box at (50, 50)-(150, 150):
  // coming from (-50, -50) toward (100, 100), the line should exit at
  // (50, 50) (the corner).
  const corner = mod.clipToBox(-50, -50, 100, 100, { left: 50, right: 150, top: 50, bottom: 150 });
  assert.ok(Math.abs(corner.x - 50) < 1e-6, `corner x must be 50, got ${corner.x}`);
  assert.ok(Math.abs(corner.y - 50) < 1e-6, `corner y must be 50, got ${corner.y}`);

  // When the segment is fully inside the box, the parameter clamps to 1
  // and the endpoint is returned unchanged.
  const inside = mod.clipToBox(60, 60, 70, 70, box);
  assert.equal(Math.round(inside.x), 70);
  assert.equal(Math.round(inside.y), 70);

  // Degenerate: zero-length segment returns the endpoint.
  const zero = mod.clipToBox(0, 0, 0, 0, box);
  assert.equal(zero.x, 0);
  assert.equal(zero.y, 0);
});

test("fitTransform picks a scale + translate that fits the whole graph in the viewport", { skip }, async (t) => {
  const mod = await import(pathToFileURL(HELPERS_FILE).href);
  // Graph spanning world coords x=[-100, 800], y=[-50, 600].
  const layout = {
    pos: {
      A: { x: -100 + mod.NODE_W / 2, y: -50 + mod.NODE_H / 2 },
      B: { x: 800 - mod.NODE_W / 2, y: 600 - mod.NODE_H / 2 },
    },
  };
  const vw = 1000;
  const vh = 600;
  const t1 = mod.fitTransform(layout, vw, vh);
  // After applying the transform, every node box must be inside the
  // viewport (with the configured margin).
  for (const id of ["A", "B"]) {
    const p = layout.pos[id];
    const left = t1.tx + (p.x - mod.NODE_W / 2) * t1.scale;
    const right = t1.tx + (p.x + mod.NODE_W / 2) * t1.scale;
    const top = t1.ty + (p.y - mod.NODE_H / 2) * t1.scale;
    const bottom = t1.ty + (p.y + mod.NODE_H / 2) * t1.scale;
    assert.ok(left >= 0, `${id} left edge must be >= 0: ${left}`);
    assert.ok(right <= vw, `${id} right edge must be <= ${vw}: ${right}`);
    assert.ok(top >= 0, `${id} top edge must be >= 0: ${top}`);
    assert.ok(bottom <= vh, `${id} bottom edge must be <= ${vh}: ${bottom}`);
  }
  assert.ok(Number.isFinite(t1.scale) && t1.scale > 0, `scale must be a positive finite number: ${t1.scale}`);
});

test("fitTransform returns the identity transform when the layout has no nodes", { skip }, async (t) => {
  const mod = await import(pathToFileURL(HELPERS_FILE).href);
  const t1 = mod.fitTransform({ pos: {} }, 1000, 600);
  assert.equal(t1.scale, 1);
  assert.equal(t1.tx, 0);
  assert.equal(t1.ty, 0);
});

test("abbreviate trims long titles with an ellipsis and keeps short titles untouched", { skip }, async (t) => {
  const mod = await import(pathToFileURL(HELPERS_FILE).href);
  assert.equal(mod.abbreviate("hi", 30), "hi");
  assert.equal(mod.abbreviate("", 30), "");
  assert.equal(mod.abbreviate(undefined, 30), "");
  const trimmed = mod.abbreviate("a".repeat(100), 20);
  assert.ok(trimmed.length <= 20, `abbreviate must not exceed the limit (got ${trimmed.length})`);
  assert.match(trimmed, /\u2026$/, "abbreviate must end with an ellipsis when it trims");
});

test("buildEdgePath produces a non-empty SVG path whose endpoint is on the target boundary", { skip }, async (t) => {
  const mod = await import(pathToFileURL(HELPERS_FILE).href);
  const from = { x: 100, y: 100 };
  const to = { x: 400, y: 100 };
  const d = mod.buildEdgePath(from, to);
  assert.ok(typeof d === "string" && d.length > 0, `buildEdgePath must return a non-empty string: ${d}`);
  assert.ok(d.startsWith("M "), `path must start with 'M ': ${d}`);
  const coords = d.match(/[ML]\s+(-?[\d.]+)\s+(-?[\d.]+)/g);
  assert.ok(coords && coords.length >= 2, `path must contain at least M and L commands: ${d}`);
  const last = coords[coords.length - 1].split(/\s+/);
  const lastX = parseFloat(last[1]);
  const lastY = parseFloat(last[2]);
  // Line enters the target box at its left edge (to.x - NODE_W / 2).
  assert.equal(
    Math.round(lastX),
    400 - mod.NODE_W / 2,
    `arrow must land at the left edge of the target box (x=${400 - mod.NODE_W / 2}); got ${lastX}`,
  );
  assert.equal(Math.round(lastY), 100);

  // Symmetric case: line coming from the right should land at the right
  // edge of the target box.
  const d2 = mod.buildEdgePath({ x: 800, y: 100 }, { x: 400, y: 100 });
  const last2 = d2.match(/[ML]\s+(-?[\d.]+)\s+(-?[\d.]+)/g).pop().split(/\s+/);
  assert.equal(
    Math.round(parseFloat(last2[1])),
    400 + mod.NODE_W / 2,
    `arrow from the right must land at the right edge of the target box (x=${400 + mod.NODE_W / 2})`,
  );
});

test("shouldShowIsolationCallout fires only when there are visible nodes but no edges", { skip }, async (t) => {
  const mod = await import(pathToFileURL(HELPERS_FILE).href);
  const allNodes = {
    A: { id: "A", kind: "resolvable" },
    B: { id: "B", kind: "knowledge" },
  };
  // Empty graph: never callout.
  assert.equal(mod.shouldShowIsolationCallout({}, 0, 0), false);
  // Nodes visible, edges visible: not callout territory.
  assert.equal(mod.shouldShowIsolationCallout(allNodes, 2, 1), false);
  // Nodes visible, no edges, full graph non-empty: callout.
  assert.equal(mod.shouldShowIsolationCallout(allNodes, 2, 0), true);
  // Nodes visible, no edges, full graph empty: never (nothing to call
  // out about — the empty state handles this case).
  assert.equal(mod.shouldShowIsolationCallout({}, 1, 0), false);
});

// === Graph.jsx smoke =======================================================

// Compile the JSX file with babel-preset-solid and confirm the default
// export is a Solid component. Detailed component-level rendering would
// require a StoreProvider stub; the helper coverage above pins the
// behaviour that actually matters.
//
// Graph.jsx imports from ../store.jsx and ../components.jsx, both of
// which are JSX files Node can't load on their own. The compileGraph
// helper compiles every dependency in the same closure and rewrites the
// import paths so the tmp file resolves its own deps through sibling tmp
// files. This keeps the test self-contained.
const tmpFiles = new Set();
async function compileGraph(t, label) {
  // Map<absSourcePath, absTmpPath> — populated BEFORE the rewrite so
  // recursive imports can find sibling tmp paths.
  const compiled = new Map();
  function tmpFor(file) {
    if (!compiled.has(file)) {
      compiled.set(
        file,
        path.join(
          path.dirname(file),
          `.${path.basename(file, ".jsx")}.compiled.${process.pid}.${label}.mjs`,
        ),
      );
    }
    return compiled.get(file);
  }

  const stack = [GRAPH_FILE];
  while (stack.length) {
    const file = stack.pop();
    if (tmpFiles.has(tmpFor(file))) continue; // already compiled
    const source = fs.readFileSync(file, "utf8");
    const out = await babel.transformAsync(source, {
      filename: file,
      sourceType: "module",
      presets: [[UI_REQUIRE.resolve("babel-preset-solid"), { generate: "ssr", hydratable: false }]],
    });
    const dir = path.dirname(file);
    const myTmp = tmpFor(file);
    let code = out.code;
    code = code.replace(
      /from\s+["']([^"']+)["']/g,
      (m, spec) => {
        if (!spec.startsWith(".")) return m;
        const abs = path.resolve(dir, spec);
        if (!abs.endsWith(".jsx")) return m;
        const depTmp = tmpFor(abs);
        stack.push(abs);
        const rel = path.relative(path.dirname(myTmp), depTmp);
        return `from "${rel.startsWith(".") ? rel : "./" + rel}"`;
      },
    );
    fs.writeFileSync(myTmp, code, "utf8");
    tmpFiles.add(myTmp);
  }
  const graphTmp = tmpFor(GRAPH_FILE);
  const cleanup = () => {
    for (const f of [...tmpFiles]) {
      tmpFiles.delete(f);
      fs.promises.unlink(f).catch(() => {});
    }
  };
  if (t && typeof t.after === "function") t.after(cleanup);
  return import(pathToFileURL(graphTmp).href);
}

process.on("exit", () => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch {}
  }
});

test("Graph.jsx exists and compiles cleanly under babel-preset-solid", { skip }, async (t) => {
  assert.ok(fs.existsSync(GRAPH_FILE), `${GRAPH_FILE} must exist`);
  const mod = await compileGraph(t, "compiles");
  assert.equal(typeof mod.default, "function", "Graph.jsx must default-export a Solid component");
});
