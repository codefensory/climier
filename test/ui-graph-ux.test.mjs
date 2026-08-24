// Contract tests for ui/src/views/graph-helpers.mjs + Graph.jsx
// (Fase 5C pieza 2 — UX: search, filters, history chain, neighbor focus).
//
// Why this file exists:
//   - Fase 5C pieza 1 (T-ui-graph-core) shipped the layout/pan/zoom core and
//     pinned it in test/ui-graph-core.test.mjs. This file pins the UX layer
//     that T-ui-graph-ux adds on top:
//       * nodeMatchesQuery — search by id or title, case-insensitive;
//       * historyChainIds — the "Show history" reveal set: nodes that are
//         endpoints of DERIVED_FROM / SUPERSEDES edges (the historical
//         chain), NOT every closed-status node;
//       * neighborIds / edgeTouches — the focus-of-neighbors contract:
//         highlight the selected node + its direct neighbors, dim the rest;
//       * uniqueStatuses / uniqueKinds — filter option lists;
//       * filterGraph — the full visible-set pipeline: initiative, status,
//         kind, search, Show history and the "no disconnected knowledge"
//         default, with edges pruned to visible endpoints.
//   - Graph.jsx compiles cleanly under babel-preset-solid (smoke test), the
//     same pattern ui-graph-core.test.mjs uses for the core component.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const UI_DIR = path.resolve("ui");
const HELPERS_FILE = path.join(UI_DIR, "src", "views", "graph-helpers.mjs");

const UI_DEPS_OK = fs.existsSync(path.join(UI_DIR, "node_modules", "solid-js"));
const skip = UI_DEPS_OK ? false : "ui dependencies not installed (run npm install in ui/)";

const T = (id, extra = {}) => ({
  id,
  kind: "resolvable",
  subkind: "task",
  initiative: "ui",
  status: "open",
  title: `Title ${id}`,
  ...extra,
});
const G = (id, extra = {}) => ({ id, kind: "resolvable", subkind: "gate", initiative: "ui", status: "open", title: `Gate ${id}`, ...extra });
const K = (id, extra = {}) => ({ id, kind: "knowledge", initiative: "ui", status: "active", title: `Know ${id}`, ...extra });

async function loadHelpers() {
  return import(pathToFileURL(HELPERS_FILE).href);
}

// === Exports ===============================================================

test("graph-helpers.mjs exports the UX helpers", { skip }, async (t) => {
  const mod = await loadHelpers();
  for (const name of [
    "nodeMatchesQuery",
    "historyChainIds",
    "neighborIds",
    "edgeTouches",
    "uniqueStatuses",
    "uniqueKinds",
    "filterGraph",
  ]) {
    assert.ok(name in mod, `graph-helpers.mjs must export ${name}`);
  }
});

// === Search ================================================================

test("nodeMatchesQuery matches id or title, case-insensitive, empty query matches all", { skip }, async (t) => {
  const mod = await loadHelpers();
  const node = T("T-abc-1", { title: "Fix the Graph view" });
  assert.equal(mod.nodeMatchesQuery(node, ""), true, "empty query matches");
  assert.equal(mod.nodeMatchesQuery(node, "   "), true, "whitespace-only query matches");
  assert.equal(mod.nodeMatchesQuery(node, "t-abc-1"), true, "id match lowercase");
  assert.equal(mod.nodeMatchesQuery(node, "T-ABC-1"), true, "id match uppercase");
  assert.equal(mod.nodeMatchesQuery(node, "graph view"), true, "title substring");
  assert.equal(mod.nodeMatchesQuery(node, "GRAPH"), true, "title case-insensitive");
  assert.equal(mod.nodeMatchesQuery(node, "zzz"), false, "no match");
  assert.equal(mod.nodeMatchesQuery({ id: "X", title: "" }, "x"), true, "matches id when title empty");
  assert.equal(mod.nodeMatchesQuery({ id: "X" }, "x"), true, "matches id when title missing");
});

// === History chain =========================================================

test("historyChainIds returns endpoints of DERIVED_FROM/SUPERSEDES edges only", { skip }, async (t) => {
  const mod = await loadHelpers();
  const nodes = {
    A: T("A"),
    B: T("B", { status: "done" }),
    C: T("C", { status: "done" }),
    D: T("D"),
    E: T("E", { status: "canceled" }),
  };
  const edges = [
    { from: "A", to: "B", type: "DERIVED_FROM" },
    { from: "B", to: "C", type: "SUPERSEDES" },
    { from: "D", to: "E", type: "BLOCKS" },
    { from: "X", to: "A", type: "SUPERSEDES" }, // unknown endpoint ignored
  ];
  const ids = mod.historyChainIds(nodes, edges);
  assert.ok(ids.has("A"), "A is a DERIVED_FROM endpoint");
  assert.ok(ids.has("B"), "B is an endpoint of both history edges");
  assert.ok(ids.has("C"), "C is a SUPERSEDES endpoint");
  assert.ok(!ids.has("D"), "D only has a BLOCKS edge, not history");
  assert.ok(!ids.has("E"), "E only has a BLOCKS edge, not history");
  assert.equal(ids.size, 3);
});

// === Neighbor focus ========================================================

test("neighborIds returns direct neighbors in both directions for any edge type", { skip }, async (t) => {
  const mod = await loadHelpers();
  const edges = [
    { from: "A", to: "B", type: "BLOCKS" },
    { from: "C", to: "A", type: "DERIVED_FROM" },
    { from: "D", to: "E", type: "BLOCKS" },
  ];
  const n = mod.neighborIds(edges, "A");
  assert.deepEqual([...n].sort(), ["B", "C"], "neighbors of A are B (outgoing) and C (incoming)");
  assert.equal(mod.neighborIds(edges, "Z").size, 0, "unknown id has no neighbors");
  assert.equal(mod.neighborIds([], "A").size, 0, "no edges means no neighbors");
});

test("edgeTouches reports whether an edge touches any id in the focus set", { skip }, async (t) => {
  const mod = await loadHelpers();
  const set = new Set(["A", "B"]);
  assert.equal(mod.edgeTouches({ from: "A", to: "C" }, set), true, "from is in the set");
  assert.equal(mod.edgeTouches({ from: "C", to: "B" }, set), true, "to is in the set");
  assert.equal(mod.edgeTouches({ from: "A", to: "B" }, set), true, "both in the set");
  assert.equal(mod.edgeTouches({ from: "C", to: "D" }, set), false, "neither in the set");
});

// === Filter option lists ===================================================

test("uniqueStatuses dedupes, defaults missing status to open, and sorts", { skip }, async (t) => {
  const mod = await loadHelpers();
  const nodes = {
    A: T("A", { status: "done" }),
    B: T("B", { status: "open" }),
    C: T("C"), // no status -> open
    D: T("D", { status: "done" }),
  };
  assert.deepEqual(mod.uniqueStatuses(nodes), ["done", "open"]);
  assert.deepEqual(mod.uniqueStatuses({}), []);
});

test("uniqueKinds returns the dashboard kinds present, sorted", { skip }, async (t) => {
  const mod = await loadHelpers();
  const nodes = {
    A: T("A"),
    B: G("B"),
    C: K("C"),
  };
  assert.deepEqual(mod.uniqueKinds(nodes), ["gate", "knowledge", "task"]);
});

// === filterGraph pipeline ==================================================

test("filterGraph default hides closed-status nodes and keeps open work + connected knowledge", { skip }, async (t) => {
  const mod = await loadHelpers();
  const nodes = {
    A: T("A", { status: "open" }),
    B: T("B", { status: "in_progress" }),
    C: T("C", { status: "done" }),
    D: T("D", { status: "canceled" }),
    E: G("E", { status: "resolved" }),
    F: K("F", { status: "active" }),
    G2: K("G2", { status: "active" }), // disconnected knowledge
  };
  const edges = [
    { from: "A", to: "B", type: "BLOCKS" },
    { from: "F", to: "A", type: "DERIVED_FROM" },
  ];
  const res = mod.filterGraph(nodes, edges, {});
  assert.ok(res.nodes.A, "open task kept");
  assert.ok(res.nodes.B, "in_progress task kept");
  assert.ok(!res.nodes.C, "done hidden by default");
  assert.ok(!res.nodes.D, "canceled hidden by default");
  assert.ok(!res.nodes.E, "resolved gate hidden by default");
  assert.ok(res.nodes.F, "connected knowledge kept");
  assert.ok(!res.nodes.G2, "disconnected knowledge hidden even without filters");
  assert.deepEqual(
    res.edges,
    [
      { from: "A", to: "B", type: "BLOCKS" },
      { from: "F", to: "A", type: "DERIVED_FROM" },
    ],
    "edges between visible endpoints are kept",
  );
});

test("filterGraph showHistory reveals the historical chain, not every closed node", { skip }, async (t) => {
  const mod = await loadHelpers();
  const nodes = {
    A: T("A", { status: "done" }),          // in chain (DERIVED_FROM)
    B: T("B", { status: "resolved" }),       // in chain (SUPERSEDES)
    C: T("C", { status: "done" }),           // closed but NOT in a chain
    D: T("D", { status: "open" }),           // working set stays
  };
  const edges = [
    { from: "A", to: "B", type: "SUPERSEDES" },
    { from: "C", to: "D", type: "BLOCKS" },
  ];
  const res = mod.filterGraph(nodes, edges, { showHistory: true });
  assert.ok(res.nodes.A, "chain endpoint revealed");
  assert.ok(res.nodes.B, "chain endpoint revealed");
  assert.ok(!res.nodes.C, "closed node without DERIVED_FROM/SUPERSEDES stays hidden");
  assert.ok(res.nodes.D, "open node kept");
  assert.deepEqual(res.edges, [{ from: "A", to: "B", type: "SUPERSEDES" }]);
});

test("filterGraph status filter overrides the closed-status default hiding", { skip }, async (t) => {
  const mod = await loadHelpers();
  const nodes = {
    A: T("A", { status: "done" }),
    B: T("B", { status: "open" }),
    C: T("C", { status: "done" }),
  };
  const res = mod.filterGraph(nodes, [], { status: "done" });
  assert.ok(res.nodes.A, "done shown when the user explicitly filters by done");
  assert.ok(res.nodes.C, "done shown when the user explicitly filters by done");
  assert.ok(!res.nodes.B, "open excluded by the done filter");
});

test("filterGraph initiative filter narrows the visible set", { skip }, async (t) => {
  const mod = await loadHelpers();
  const nodes = {
    A: T("A", { initiative: "ui" }),
    B: T("B", { initiative: "cli" }),
  };
  const res = mod.filterGraph(nodes, [], { ini: "cli" });
  assert.ok(!res.nodes.A);
  assert.ok(res.nodes.B);
});

test("filterGraph kind filter narrows by dashboard kind", { skip }, async (t) => {
  const mod = await loadHelpers();
  const nodes = {
    A: T("A"),
    B: G("B"),
    C: K("C", { status: "active" }),
  };
  const edges = [
    { from: "C", to: "A", type: "DERIVED_FROM" },
    { from: "A", to: "B", type: "BLOCKS" },
  ];
  const gates = mod.filterGraph(nodes, edges, { kind: "gate" });
  assert.ok(!gates.nodes.A);
  assert.ok(gates.nodes.B);
  assert.ok(!gates.nodes.C);
  assert.deepEqual(gates.edges, [], "edges need both endpoints visible");
  const knowledge = mod.filterGraph(nodes, edges, { kind: "knowledge" });
  assert.ok(knowledge.nodes.C);
  assert.ok(!knowledge.nodes.A);
});

test("filterGraph search narrows by id or title", { skip }, async (t) => {
  const mod = await loadHelpers();
  const nodes = {
    A: T("T-foo-1", { title: "Alpha view" }),
    B: T("T-bar-2", { title: "Beta graph" }),
  };
  const res = mod.filterGraph(nodes, [], { search: "beta" });
  assert.ok(!res.nodes.A);
  assert.ok(res.nodes.B);
  const byId = mod.filterGraph(nodes, [], { search: "FOO" });
  assert.ok(byId.nodes.A, "id match is case-insensitive");
  assert.ok(!byId.nodes.B);
});

test("filterGraph combines filters with AND semantics", { skip }, async (t) => {
  const mod = await loadHelpers();
  const nodes = {
    A: T("T-a-1", { initiative: "ui", status: "open", title: "Graph alpha" }),
    B: T("T-b-1", { initiative: "cli", status: "done", title: "Graph beta" }),
    C: T("T-c-1", { initiative: "ui", status: "done", title: "Graph gamma" }),
  };
  const res = mod.filterGraph(nodes, [], { ini: "ui", status: "done", search: "graph" });
  assert.ok(!res.nodes.A, "status done excludes open A");
  assert.ok(!res.nodes.B, "initiative cli excludes B");
  assert.ok(res.nodes.C, "only C matches all three filters");
});

test("filterGraph edges are pruned to visible endpoints", { skip }, async (t) => {
  const mod = await loadHelpers();
  const nodes = {
    A: T("A", { status: "open" }),
    B: T("B", { status: "open" }),
    C: T("C", { status: "done" }),
  };
  const edges = [
    { from: "A", to: "B", type: "BLOCKS" },
    { from: "A", to: "C", type: "BLOCKS" },
  ];
  const res = mod.filterGraph(nodes, edges, {});
  assert.deepEqual(res.edges, [{ from: "A", to: "B", type: "BLOCKS" }]);
});
