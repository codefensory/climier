// test/provider-core-edge.test.mjs — pure unit tests for the
// `edge.add` core provider (T-graph-kernel-provider-core-ops).
//
// Scope:
//   - prepare is read-only and validates input shape, normalizes
//     type to uppercase, rejects self-edges, missing endpoints,
//     invalid types, and duplicates already present in the
//     snapshot;
//   - apply only touches tx.addEdge (no fs/lock/state/log/handler);
//   - plan carries a frozen `target` whose `id` matches the
//     BLOCKS-direction `to` endpoint so kernel.mutate can build a
//     log entry, plus the normalized edge shape for apply.
//
// Pure: no filesystem, no lock, no state, no log, no policy, no
// command, no adapter, no CLI, no UI. Snapshots and tx stubs are
// literal JS objects.

import { test } from "node:test";
import assert from "node:assert/strict";

import { importFresh } from "./helpers.mjs";

const ACTOR = "codex-worker";

async function importEdgeProvider() {
  return importFresh("../src/providers/core/edge.mjs");
}

function makeSnapshot({ nodes = {}, edges = [], initiatives = { foo: { desc: "x" } }, log = [] } = {}) {
  return { version: 2, initiatives, nodes, edges, log };
}

function makeRequest({ input, action = "edge.add", actor = ACTOR } = {}) {
  return { action, actor, input };
}

function makeTaskNode(id, revision = 1) {
  return {
    id,
    kind: "resolvable",
    subkind: "task",
    title: `task ${id}`,
    initiative: "foo",
    status: "open",
    revision,
  };
}

// makeTxStub — captures addEdge invocations. Mirrors the structural
// validation in src/kernel/transaction.mjs#addEdge so the provider's
// happy path is exercised end-to-end without exercising real tx state.
function makeTxStub({ nodes = {} } = {}) {
  const addedEdges = [];
  return {
    calls: { addEdge: 0, view: 0 },
    addedEdges,
    addEdge(edge) {
      this.calls.addEdge += 1;
      const fromNode = nodes[edge.from];
      const toNode = nodes[edge.to];
      if (!fromNode || !toNode) {
        const err = new Error(`txStub: edge ${edge.type} ${edge.from} -> ${edge.to} references missing node`);
        err.code = "INVALID_EDGE_TARGET";
        throw err;
      }
      if (edge.from === edge.to) {
        const err = new Error(`txStub: edge ${edge.from} -> ${edge.to} is a self-edge`);
        err.code = "SELF_EDGE";
        throw err;
      }
      const dup = addedEdges.some((e) => e.from === edge.from && e.to === edge.to && e.type === edge.type);
      if (dup) {
        const err = new Error(`txStub: edge ${edge.type} ${edge.from} -> ${edge.to} already exists`);
        err.code = "DUPLICATE_EDGE";
        throw err;
      }
      addedEdges.push({ from: edge.from, to: edge.to, type: edge.type });
      return { from: edge.from, to: edge.to, type: edge.type };
    },
    view() {
      this.calls.view += 1;
      return { nodes: { ...nodes }, edges: addedEdges.slice() };
    },
  };
}

async function expectCode(fn, code) {
  try {
    await fn();
  } catch (err) {
    assert.equal(err.code, code, `expected ${code} got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected throw with code ${code}`);
}

test("edge.add: prepare validates input shape (from, to, type)", async () => {
  const { edgeAddProvider } = await importEdgeProvider();
  const snapshot = makeSnapshot({ nodes: { a: makeTaskNode("a"), b: makeTaskNode("b") } });
  await expectCode(
    () => edgeAddProvider.prepare({ snapshot, input: {}, request: makeRequest({ input: {} }) }),
    "MISSING_FIELD",
  );
  await expectCode(
    () =>
      edgeAddProvider.prepare({
        snapshot,
        input: { from: "a" },
        request: makeRequest({ input: { from: "a" } }),
      }),
    "MISSING_FIELD",
  );
  await expectCode(
    () =>
      edgeAddProvider.prepare({
        snapshot,
        input: { from: "a", to: "b" },
        request: makeRequest({ input: { from: "a", to: "b" } }),
      }),
    "MISSING_FIELD",
  );
});

test("edge.add: prepare normalizes type to uppercase", async () => {
  const { edgeAddProvider } = await importEdgeProvider();
  const snapshot = makeSnapshot({ nodes: { a: makeTaskNode("a"), b: makeTaskNode("b") } });
  const plan = await edgeAddProvider.prepare({
    snapshot,
    input: { from: "a", to: "b", type: "blocks" },
    request: makeRequest({ input: { from: "a", to: "b", type: "blocks" } }),
  });
  assert.equal(plan.edge.type, "BLOCKS");
  assert.equal(plan.target.from, "a");
  assert.equal(plan.target.to, "b");
  assert.equal(plan.target.id, "b");
  assert.ok(Object.isFrozen(plan), "plan must be frozen");
});

test("edge.add: prepare rejects invalid type", async () => {
  const { edgeAddProvider } = await importEdgeProvider();
  const snapshot = makeSnapshot({ nodes: { a: makeTaskNode("a"), b: makeTaskNode("b") } });
  await expectCode(
    () =>
      edgeAddProvider.prepare({
        snapshot,
        input: { from: "a", to: "b", type: "INVALID" },
        request: makeRequest({ input: { from: "a", to: "b", type: "INVALID" } }),
      }),
    "INVALID_EDGE_TYPE",
  );
});

test("edge.add: prepare rejects missing endpoint", async () => {
  const { edgeAddProvider } = await importEdgeProvider();
  const snapshot = makeSnapshot({ nodes: { a: makeTaskNode("a") } });
  await expectCode(
    () =>
      edgeAddProvider.prepare({
        snapshot,
        input: { from: "a", to: "b", type: "BLOCKS" },
        request: makeRequest({ input: { from: "a", to: "b", type: "BLOCKS" } }),
      }),
    "INVALID_EDGE_TARGET",
  );
});

test("edge.add: prepare rejects self-edge", async () => {
  const { edgeAddProvider } = await importEdgeProvider();
  const snapshot = makeSnapshot({ nodes: { a: makeTaskNode("a") } });
  await expectCode(
    () =>
      edgeAddProvider.prepare({
        snapshot,
        input: { from: "a", to: "a", type: "BLOCKS" },
        request: makeRequest({ input: { from: "a", to: "a", type: "BLOCKS" } }),
      }),
    "SELF_EDGE",
  );
});

test("edge.add: prepare rejects duplicate edge already in snapshot", async () => {
  const { edgeAddProvider } = await importEdgeProvider();
  const snapshot = makeSnapshot({
    nodes: { a: makeTaskNode("a"), b: makeTaskNode("b") },
    edges: [{ from: "a", to: "b", type: "BLOCKS" }],
  });
  await expectCode(
    () =>
      edgeAddProvider.prepare({
        snapshot,
        input: { from: "a", to: "b", type: "BLOCKS" },
        request: makeRequest({ input: { from: "a", to: "b", type: "BLOCKS" } }),
      }),
    "DUPLICATE_EDGE",
  );
});

test("edge.add: apply only calls tx.addEdge once and returns the persisted edge", async () => {
  const { edgeAddProvider } = await importEdgeProvider();
  const nodes = { a: makeTaskNode("a"), b: makeTaskNode("b") };
  const snapshot = makeSnapshot({ nodes });
  const input = { from: "a", to: "b", type: "BLOCKS" };
  const plan = await edgeAddProvider.prepare({
    snapshot,
    input,
    request: makeRequest({ input }),
  });
  const tx = makeTxStub({ nodes });
  const result = await edgeAddProvider.apply({
    tx,
    plan,
    input,
    request: makeRequest({ input }),
    snapshot,
  });
  assert.equal(tx.calls.addEdge, 1, "apply must call tx.addEdge exactly once");
  assert.equal(tx.calls.view, 0, "apply must not call tx.view");
  assert.equal(result.effects, null);
  assert.deepEqual(result.result.edge, { from: "a", to: "b", type: "BLOCKS" });
  assert.deepEqual(tx.addedEdges, [{ from: "a", to: "b", type: "BLOCKS" }]);
});

test("edge.add: plan exposes policyAction and logAction for kernel.mutate", async () => {
  const { edgeAddProvider } = await importEdgeProvider();
  const nodes = { a: makeTaskNode("a"), b: makeTaskNode("b") };
  const snapshot = makeSnapshot({ nodes });
  const plan = await edgeAddProvider.prepare({
    snapshot,
    input: { from: "a", to: "b", type: "BLOCKS" },
    request: makeRequest({ input: { from: "a", to: "b", type: "BLOCKS" } }),
  });
  assert.equal(plan.policyAction.action, "edge.add");
  assert.equal(plan.policyAction.pluginId, null);
  assert.equal(plan.logAction, "add-edge");
});