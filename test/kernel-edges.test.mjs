// B2 — pure primitives for graph edges.
//
// ADR-011 §§2–3 + ADR-012 §3 + plan §B2:
// `src/kernel/edges.mjs` owns EDGE_TYPES, existingEdge, blocksEdge and
// validateEdge. These are the structural primitives the kernel and v2 facade
// share. No filesystem, no locks, no providers, no state mutation.
//
// Conventions:
//   - pure-function tests; import the module fresh per case for isolation;
//   - one focused assertion per test (code + details where relevant);
//   - errors come from src/contracts/errors.mjs (throwV2); message and code must be
//     preserved so existing v2 consumers keep working.

import { test } from "node:test";
import assert from "node:assert/strict";
import { importFresh } from "./helpers.mjs";

function makeState(nodes = {}, edges = []) {
  return { version: 2, nodes, edges, log: [] };
}

const resolvableTask = (id) => ({ id, kind: "resolvable", subkind: "task", title: id });
const resolvableGate = (id) => ({ id, kind: "resolvable", subkind: "gate", title: id });
const knowledgeNode = (id) => ({ id, kind: "knowledge", title: id });

// --- EDGE_TYPES ---------------------------------------------------------

test("EDGE_TYPES: lists BLOCKS, SUPERSEDES, DERIVED_FROM only", async () => {
  const { EDGE_TYPES } = await importFresh("../src/kernel/edges.mjs");
  assert.deepEqual([...EDGE_TYPES].sort(), ["BLOCKS", "DERIVED_FROM", "SUPERSEDES"]);
});

test("EDGE_TYPES: omits deprecated informational/conflict types (INFORMS, RELATES_TO, CONFLICTS_WITH)", async () => {
  const { EDGE_TYPES } = await importFresh("../src/kernel/edges.mjs");
  for (const deprecated of ["INFORMS", "RELATES_TO", "CONFLICTS_WITH"]) {
    assert.equal(EDGE_TYPES.includes(deprecated), false, `${deprecated} must be rejected`);
  }
});

// --- existingEdge -------------------------------------------------------

test("existingEdge: matches on exact (from, to, type) triple", async () => {
  const { existingEdge } = await importFresh("../src/kernel/edges.mjs");
  const state = makeState(
    { A: resolvableTask("A"), B: resolvableGate("B") },
    [{ from: "A", to: "B", type: "BLOCKS" }],
  );
  assert.equal(existingEdge(state, "A", "B", "BLOCKS"), true);
});

test("existingEdge: returns false when type differs", async () => {
  const { existingEdge } = await importFresh("../src/kernel/edges.mjs");
  const state = makeState(
    { A: resolvableTask("A"), B: resolvableGate("B") },
    [{ from: "A", to: "B", type: "BLOCKS" }],
  );
  assert.equal(existingEdge(state, "A", "B", "SUPERSEDES"), false);
});

test("existingEdge: returns false on empty edges array", async () => {
  const { existingEdge } = await importFresh("../src/kernel/edges.mjs");
  const state = makeState({ A: resolvableTask("A"), B: resolvableGate("B") }, []);
  assert.equal(existingEdge(state, "A", "B", "BLOCKS"), false);
});

test("existingEdge: detects duplicates regardless of position", async () => {
  const { existingEdge } = await importFresh("../src/kernel/edges.mjs");
  // Two edges with the same key elsewhere in the array; existingEdge only
  // reports existence, so the position of the duplicate is irrelevant.
  const state = makeState(
    { A: resolvableTask("A"), B: resolvableGate("B"), C: resolvableGate("C") },
    [
      { from: "A", to: "C", type: "BLOCKS" },
      { from: "A", to: "B", type: "BLOCKS" },
      { from: "A", to: "B", type: "BLOCKS" }, // duplicate
    ],
  );
  assert.equal(existingEdge(state, "A", "B", "BLOCKS"), true);
  assert.equal(existingEdge(state, "A", "B", "SUPERSEDES"), false);
});

test("existingEdge: handles missing edges field defensively", async () => {
  const { existingEdge } = await importFresh("../src/kernel/edges.mjs");
  const state = makeState({ A: resolvableTask("A") });
  state.edges = undefined;
  assert.equal(existingEdge(state, "A", "B", "BLOCKS"), false);
});

// --- blocksEdge ---------------------------------------------------------

test("blocksEdge: produces the canonical BLOCKS edge shape", async () => {
  const { blocksEdge } = await importFresh("../src/kernel/edges.mjs");
  assert.deepEqual(blocksEdge("A", "B"), { from: "A", to: "B", type: "BLOCKS" });
});

test("blocksEdge: direction is 'blocker BLOCKS blocked' (first arg is the blocker)", async () => {
  const { blocksEdge } = await importFresh("../src/kernel/edges.mjs");
  const edge = blocksEdge("G-x", "T-y");
  // B is the blocked (dependent) node. Edge reads "G-x BLOCKS T-y".
  assert.equal(edge.from, "G-x");
  assert.equal(edge.to, "T-y");
  assert.equal(edge.type, "BLOCKS");
});

test("blocksEdge: returns a fresh object each call", async () => {
  const { blocksEdge } = await importFresh("../src/kernel/edges.mjs");
  const a = blocksEdge("A", "B");
  const b = blocksEdge("A", "B");
  assert.notEqual(a, b, "expected independent objects (mutation safety)");
  assert.deepEqual(a, b);
});

// --- validateEdge -------------------------------------------------------

test("validateEdge: rejects self-edge with code SELF_EDGE", async () => {
  const { validateEdge } = await importFresh("../src/kernel/edges.mjs");
  const state = makeState({ T1: resolvableTask("T1") });
  assert.throws(
    () => validateEdge(state, { from: "T1", to: "T1", type: "BLOCKS" }, "cmd"),
    (err) => err.code === "SELF_EDGE" && /self-edge/i.test(err.message),
  );
});

test("validateEdge: missing from-node is rejected with code INVALID_EDGE_TARGET", async () => {
  const { validateEdge } = await importFresh("../src/kernel/edges.mjs");
  const state = makeState({ B: resolvableGate("B") });
  assert.throws(
    () => validateEdge(state, { from: "A", to: "B", type: "BLOCKS" }, "cmd"),
    (err) => err.code === "INVALID_EDGE_TARGET" && /A/.test(err.message),
  );
});

test("validateEdge: missing to-node is rejected with code INVALID_EDGE_TARGET", async () => {
  const { validateEdge } = await importFresh("../src/kernel/edges.mjs");
  const state = makeState({ A: resolvableTask("A") });
  assert.throws(
    () => validateEdge(state, { from: "A", to: "B", type: "BLOCKS" }, "cmd"),
    (err) => err.code === "INVALID_EDGE_TARGET" && /B/.test(err.message),
  );
});

test("validateEdge: missing target details carry the offending id", async () => {
  const { validateEdge } = await importFresh("../src/kernel/edges.mjs");
  const state = makeState({ A: resolvableTask("A") });
  let caught;
  try {
    validateEdge(state, { from: "A", to: "B", type: "BLOCKS" }, "cmd");
  } catch (e) {
    caught = e;
  }
  assert.ok(caught);
  assert.equal(caught.code, "INVALID_EDGE_TARGET");
  assert.equal(caught.details.missing, "B");
  assert.equal(caught.details.from, "A");
  assert.equal(caught.details.to, "B");
  assert.equal(caught.details.type, "BLOCKS");
});

test("validateEdge: BLOCKS requires both ends to be resolvable (to is knowledge)", async () => {
  const { validateEdge } = await importFresh("../src/kernel/edges.mjs");
  const state = makeState({ T: resolvableTask("T"), K: knowledgeNode("K") });
  assert.throws(
    () => validateEdge(state, { from: "T", to: "K", type: "BLOCKS" }, "cmd"),
    (err) => err.code === "INVALID_EDGE_KIND" && /BLOCKS/.test(err.message),
  );
});

test("validateEdge: BLOCKS requires both ends to be resolvable (from is knowledge)", async () => {
  const { validateEdge } = await importFresh("../src/kernel/edges.mjs");
  const state = makeState({ T: resolvableTask("T"), K: knowledgeNode("K") });
  assert.throws(
    () => validateEdge(state, { from: "K", to: "T", type: "BLOCKS" }, "cmd"),
    (err) => err.code === "INVALID_EDGE_KIND" && /BLOCKS/.test(err.message),
  );
});

test("validateEdge: SUPERSEDES requires both ends to be the same kind", async () => {
  const { validateEdge } = await importFresh("../src/kernel/edges.mjs");
  const state = makeState({ G: resolvableGate("G"), K: knowledgeNode("K") });
  assert.throws(
    () => validateEdge(state, { from: "G", to: "K", type: "SUPERSEDES" }, "cmd"),
    (err) => err.code === "INVALID_EDGE_KIND" && /SUPERSEDES/.test(err.message),
  );
});

test("validateEdge: SUPERSEDES between two gates is accepted", async () => {
  const { validateEdge } = await importFresh("../src/kernel/edges.mjs");
  const state = makeState({ G1: resolvableGate("G1"), G2: resolvableGate("G2") });
  assert.doesNotThrow(() =>
    validateEdge(state, { from: "G1", to: "G2", type: "SUPERSEDES" }, "cmd"),
  );
});

test("validateEdge: SUPERSEDES between two knowledge nodes is accepted", async () => {
  const { validateEdge } = await importFresh("../src/kernel/edges.mjs");
  const state = makeState({ K1: knowledgeNode("K1"), K2: knowledgeNode("K2") });
  assert.doesNotThrow(() =>
    validateEdge(state, { from: "K1", to: "K2", type: "SUPERSEDES" }, "cmd"),
  );
});

test("validateEdge: DERIVED_FROM has no extra kind rule (task from knowledge accepted)", async () => {
  const { validateEdge } = await importFresh("../src/kernel/edges.mjs");
  const state = makeState({ K: knowledgeNode("K"), T: resolvableTask("T") });
  assert.doesNotThrow(() =>
    validateEdge(state, { from: "K", to: "T", type: "DERIVED_FROM" }, "cmd"),
  );
});

test("validateEdge: rejects unknown edge types with code INVALID_EDGE_TYPE", async () => {
  const { validateEdge } = await importFresh("../src/kernel/edges.mjs");
  const state = makeState({ T: resolvableTask("T"), G: resolvableGate("G") });
  assert.throws(
    () => validateEdge(state, { from: "T", to: "G", type: "INFORMS" }, "cmd"),
    (err) => err.code === "INVALID_EDGE_TYPE" && /INFORMS/.test(err.message),
  );
});

test("validateEdge: rejects RELATES_TO and CONFLICTS_WITH with code INVALID_EDGE_TYPE", async () => {
  const { validateEdge } = await importFresh("../src/kernel/edges.mjs");
  const state = makeState({ T: resolvableTask("T"), G: resolvableGate("G") });
  for (const type of ["RELATES_TO", "CONFLICTS_WITH"]) {
    assert.throws(
      () => validateEdge(state, { from: "T", to: "G", type }, "cmd"),
      (err) => err.code === "INVALID_EDGE_TYPE" && err.message.includes(type),
      `expected ${type} to be rejected with INVALID_EDGE_TYPE`,
    );
  }
});

test("validateEdge: commandName is reflected in error messages", async () => {
  const { validateEdge } = await importFresh("../src/kernel/edges.mjs");
  const state = makeState({ T1: resolvableTask("T1") });
  assert.throws(
    () => validateEdge(state, { from: "T1", to: "T1", type: "BLOCKS" }, "my-command"),
    (err) => err.message.startsWith("my-command:"),
  );
});

test("validateEdge: handles missing state.nodes field defensively", async () => {
  const { validateEdge } = await importFresh("../src/kernel/edges.mjs");
  // Caller with no nodes map at all; any edge endpoint must be flagged.
  assert.throws(
    () =>
      validateEdge({ version: 2, edges: [], log: [] }, { from: "A", to: "B", type: "BLOCKS" }, "cmd"),
    (err) => err.code === "INVALID_EDGE_TARGET",
  );
});

// --- direction BLOCKS ---------------------------------------------------

test("validateEdge: BLOCKS direction is preserved — from=blocker, to=blocked (both ends required to be resolvable)", async () => {
  const { validateEdge } = await importFresh("../src/kernel/edges.mjs");
  // The original BLOCKS direction is from-blocker to-blocked; reversing the
  // ends changes which side the validation looks at. Both must be resolvable.
  const state = makeState({ A: resolvableTask("A"), B: resolvableGate("B") });
  // A (task) BLOCKS B (gate): valid (both resolvable).
  assert.doesNotThrow(() =>
    validateEdge(state, { from: "A", to: "B", type: "BLOCKS" }, "cmd"),
  );
  // B (gate) BLOCKS A (task): also valid (both resolvable).
  assert.doesNotThrow(() =>
    validateEdge(state, { from: "B", to: "A", type: "BLOCKS" }, "cmd"),
  );
});