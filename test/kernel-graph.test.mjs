// B2 — pure generic traversals over the v2 graph.
//
// ADR-011 §§2–3 + ADR-012 §3 + plan §B2:
// `src/kernel/graph.mjs` exposes incoming / outgoing / relations helpers
// over a v2 state shape (nodes + edges arrays). The functions are pure:
// no filesystem, no locks, no providers, no command-specific semantics.
//
// Conventions:
//   - pure-function tests; import the module fresh per case for isolation;
//   - one focused assertion per test;
//   - deterministic ordering (filter preserves snapshot insertion order).

import { test } from "node:test";
import assert from "node:assert/strict";
import { importFresh } from "./helpers.mjs";

function makeState(nodes = {}, edges = []) {
  return { version: 2, nodes, edges, log: [] };
}

// --- edgesArray (defensive accessor) ------------------------------------

test("edgesArray: returns the edges array verbatim when present", async () => {
  const { edgesArray } = await importFresh("../src/kernel/graph.mjs");
  const edges = [{ from: "A", to: "B", type: "BLOCKS" }];
  assert.deepEqual(edgesArray({ version: 2, edges, log: [] }), edges);
});

test("edgesArray: returns [] when edges field is missing or wrong type", async () => {
  const { edgesArray } = await importFresh("../src/kernel/graph.mjs");
  assert.deepEqual(edgesArray({ version: 2, log: [] }), []);
  assert.deepEqual(edgesArray({ version: 2, edges: null, log: [] }), []);
  assert.deepEqual(edgesArray({ version: 2, edges: "not-array", log: [] }), []);
});

// --- incoming -----------------------------------------------------------

test("incoming: returns edges whose 'to' matches the id (no type filter)", async () => {
  const { incoming } = await importFresh("../src/kernel/graph.mjs");
  const state = makeState({}, [
    { from: "A", to: "B", type: "BLOCKS" },
    { from: "C", to: "B", type: "SUPERSEDES" },
    { from: "B", to: "D", type: "BLOCKS" },
  ]);
  const result = incoming(state, "B");
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((e) => `${e.from}->${e.to}:${e.type}`).sort(),
    ["A->B:BLOCKS", "C->B:SUPERSEDES"],
  );
});

test("incoming: filters by type when provided", async () => {
  const { incoming } = await importFresh("../src/kernel/graph.mjs");
  const state = makeState({}, [
    { from: "A", to: "B", type: "BLOCKS" },
    { from: "C", to: "B", type: "SUPERSEDES" },
  ]);
  assert.equal(incoming(state, "B", "BLOCKS").length, 1);
  assert.equal(incoming(state, "B", "SUPERSEDES").length, 1);
  assert.equal(incoming(state, "B", "DERIVED_FROM").length, 0);
});

test("incoming: empty / missing edges yields []", async () => {
  const { incoming } = await importFresh("../src/kernel/graph.mjs");
  assert.deepEqual(incoming({ version: 2, log: [] }, "X"), []);
  assert.deepEqual(incoming({ version: 2, edges: [], log: [] }, "X"), []);
});

// --- outgoing -----------------------------------------------------------

test("outgoing: returns edges whose 'from' matches the id (no type filter)", async () => {
  const { outgoing } = await importFresh("../src/kernel/graph.mjs");
  const state = makeState({}, [
    { from: "A", to: "B", type: "BLOCKS" },
    { from: "A", to: "C", type: "SUPERSEDES" },
    { from: "B", to: "A", type: "BLOCKS" },
  ]);
  const result = outgoing(state, "A");
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((e) => `${e.from}->${e.to}:${e.type}`).sort(),
    ["A->B:BLOCKS", "A->C:SUPERSEDES"],
  );
});

test("outgoing: filters by type when provided", async () => {
  const { outgoing } = await importFresh("../src/kernel/graph.mjs");
  const state = makeState({}, [
    { from: "A", to: "B", type: "BLOCKS" },
    { from: "A", to: "C", type: "SUPERSEDES" },
  ]);
  assert.equal(outgoing(state, "A", "BLOCKS").length, 1);
  assert.equal(outgoing(state, "A", "SUPERSEDES").length, 1);
  assert.equal(outgoing(state, "A", "DERIVED_FROM").length, 0);
});

test("outgoing: empty / missing edges yields []", async () => {
  const { outgoing } = await importFresh("../src/kernel/graph.mjs");
  assert.deepEqual(outgoing({ version: 2, log: [] }, "X"), []);
  assert.deepEqual(outgoing({ version: 2, edges: [], log: [] }, "X"), []);
});

// --- relations ----------------------------------------------------------

test("relations: returns outgoing edges of a given type", async () => {
  const { relations } = await importFresh("../src/kernel/graph.mjs");
  const state = makeState({}, [
    { from: "A", to: "B", type: "INFORMS" },
    { from: "A", to: "C", type: "INFORMS" },
    { from: "A", to: "D", type: "BLOCKS" },
  ]);
  const result = relations(state, "A", "INFORMS");
  assert.equal(result.length, 2);
  for (const edge of result) assert.equal(edge.type, "INFORMS");
});

test("relations: requires a type argument (no implicit type)", async () => {
  const { relations } = await importFresh("../src/kernel/graph.mjs");
  const state = makeState({}, [
    { from: "A", to: "B", type: "BLOCKS" },
    { from: "A", to: "C", type: "SUPERSEDES" },
  ]);
  // Passing undefined must not collapse to "all"; relations is typed by
  // contract. The implementation must demand an explicit type.
  assert.equal(relations(state, "A", undefined).length, 0);
});

// --- determinism -------------------------------------------------------

test("traversals: preserve snapshot insertion order (deterministic)", async () => {
  const { incoming, outgoing, edgesArray } = await importFresh("../src/kernel/graph.mjs");
  // Insertion order is fixed: 1, 2, 3.
  const state = makeState({}, [
    { from: "A", to: "Z", type: "BLOCKS" },
    { from: "B", to: "Z", type: "BLOCKS" },
    { from: "C", to: "Z", type: "BLOCKS" },
  ]);
  // Run the traversal repeatedly to confirm we never sort or shuffle.
  for (let i = 0; i < 3; i++) {
    const inc = incoming(state, "Z", "BLOCKS").map((e) => e.from);
    assert.deepEqual(inc, ["A", "B", "C"]);
  }
  // outgoing order is also fixed across calls.
  const state2 = makeState({}, [
    { from: "Z", to: "A", type: "BLOCKS" },
    { from: "Z", to: "B", type: "BLOCKS" },
    { from: "Z", to: "C", type: "BLOCKS" },
  ]);
  for (let i = 0; i < 3; i++) {
    const out = outgoing(state2, "Z", "BLOCKS").map((e) => e.to);
    assert.deepEqual(out, ["A", "B", "C"]);
  }
  // Edge objects returned must be the same references across calls (pure
  // filter does not clone); this is intentional — traversals are cheap views.
  const all = edgesArray(state);
  const inc = incoming(state, "Z");
  assert.equal(inc[0], all[0]);
  assert.equal(inc[1], all[1]);
  assert.equal(inc[2], all[2]);
});

// --- integration with kernel/edges.blocksEdge --------------------------

test("integration: blocksEdge + incoming + outgoing cooperate for BLOCKS direction", async () => {
  const { blocksEdge } = await importFresh("../src/kernel/edges.mjs");
  const { incoming, outgoing } = await importFresh("../src/kernel/graph.mjs");
  // Two gates both blocking the same task; one of them also supersedes the
  // other. The kernel traversals must answer each direction independently.
  const edge1 = blocksEdge("G1", "T");
  const edge2 = blocksEdge("G2", "T");
  const edge3 = { from: "G2", to: "G1", type: "SUPERSEDES" };
  const state = makeState(
    { G1: { id: "G1", kind: "resolvable", subkind: "gate" }, G2: { id: "G2", kind: "resolvable", subkind: "gate" }, T: { id: "T", kind: "resolvable", subkind: "task" } },
    [edge1, edge2, edge3],
  );
  // incoming(T) -> edges where to === "T"
  const inc = incoming(state, "T");
  assert.equal(inc.length, 2);
  assert.deepEqual(inc.map((e) => e.from).sort(), ["G1", "G2"]);
  // outgoing(G2, "BLOCKS") -> [edge2]
  assert.equal(outgoing(state, "G2", "BLOCKS").length, 1);
  assert.equal(outgoing(state, "G2", "BLOCKS")[0].to, "T");
  // outgoing(G2, "SUPERSEDES") -> [edge3]
  assert.equal(outgoing(state, "G2", "SUPERSEDES")[0].to, "G1");
});