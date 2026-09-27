import assert from "node:assert/strict";
import { importFresh } from "../../helpers.mjs";

const ACTOR = "codex-worker";

// importTaskProvider — returns the module namespace fresh per call.
// We use importFresh to defeat module caching between tests so any
// accidental module-level state in the provider would surface as a
// regression.
export async function importTaskProvider() {
  const mod = await importFresh("./providers/task/index.mjs");
  return {
    taskCreateProvider: mod.taskCreateProvider,
    taskUpdateProvider: mod.taskUpdateProvider,
    taskTakeProvider: mod.taskTakeProvider,
    taskReleaseProvider: mod.taskReleaseProvider,
    taskReopenProvider: mod.taskReopenProvider,
    taskCancelProvider: mod.taskCancelProvider,
  };
}

// makeSnapshot — minimal v2 state with `nodes`, `edges`, `initiatives`,
// `log`. Tests construct literal snapshots so the provider's read-only
// expectation is verified by reference equality on input.
export function makeSnapshot({ nodes = {}, edges = [], initiatives = { foo: { desc: "x" } }, log = [] } = {}) {
  return { version: 2, initiatives, nodes, edges, log };
}

export function makeRequest({ action, input, actor = ACTOR, if_revision, if_revisions } = {}) {
  const request = { action, actor, input };
  if (if_revision !== undefined) {
    request.if_revision = if_revision;
  }
  if (if_revisions !== undefined) {
    request.if_revisions = if_revisions;
  }
  return request;
}

export function makeInputCreate(overrides = {}) {
  return {
    id: "T-x",
    initiative: "foo",
    title: "do thing",
    body: "details",
    acceptance: "done when ok",
    blocked_by: [],
    ...overrides,
  };
}

export function makeInputUpdate(overrides = {}) {
  return {
    id: "T-x",
    changes: { title: "renamed" },
    if_revision: 1,
    ...overrides,
  };
}

function cloneNodes(initialNodes) {
  const nodes = {};
  if (initialNodes && typeof initialNodes === "object") {
    for (const [id, node] of Object.entries(initialNodes)) {
      const cloned = { ...node };
      delete cloned.revision;
      nodes[id] = cloned;
    }
  }
  return nodes;
}

function makeTxState({ existingNode, initialNodes }) {
  const nodes = cloneNodes(initialNodes);
  if (existingNode) {
    nodes[existingNode.id] = { ...existingNode };
    delete nodes[existingNode.id].revision;
  }
  return { nodes, created: [], updated: [], addedEdges: [], removedEdges: [] };
}

function createNode(calls, state, input) {
  calls.createNode.push(input);
  state.nodes[input.id] = { ...input };
  delete state.nodes[input.id].revision;
  state.created.push({ id: input.id, node: { ...state.nodes[input.id] } });
  return { ...state.nodes[input.id] };
}

function updateNode(calls, state, id, patch) {
  calls.updateNode.push({ id, patch });
  const current = state.nodes[id];
  if (!current) {
    const err = new Error(`txStub: node ${id} not found`);
    err.code = "NODE_NOT_FOUND";
    throw err;
  }
  if ("revision" in patch) {
    const err = new Error(`txStub: patch for ${id} must not carry 'revision'`);
    err.code = "INVALID_EXECUTION_CONTRACT";
    throw err;
  }
  state.nodes[id] = { ...current, ...patch };
  delete state.nodes[id].revision;
  state.updated.push({ id, node: { ...state.nodes[id] } });
  return { ...state.nodes[id] };
}

function requireEdgeNodes(state, edge) {
  const fromNode = state.nodes[edge.from];
  const toNode = state.nodes[edge.to];
  if (!fromNode || !toNode) {
    const missing = !fromNode ? edge.from : edge.to;
    const err = new Error(`txStub: edge ${edge.type} ${edge.from} -> ${edge.to} references missing node '${missing}'`);
    err.code = "INVALID_EDGE_TARGET";
    err.details = { from: edge.from, to: edge.to, type: edge.type, missing };
    throw err;
  }
  return { fromNode, toNode };
}

function rejectSelfEdge(edge) {
  if (edge.from === edge.to) {
    const err = new Error(`txStub: edge ${edge.from} -> ${edge.to} is a self-edge`);
    err.code = "SELF_EDGE";
    err.details = { from: edge.from, to: edge.to, type: edge.type };
    throw err;
  }
}

function rejectInvalidBlocks({ fromNode, toNode, edge }) {
  if (edge.type === "BLOCKS" && (fromNode.kind !== "resolvable" || toNode.kind !== "resolvable")) {
    const err = new Error("txStub: BLOCKS requires both ends to be resolvable");
    err.code = "INVALID_EDGE_KIND";
    err.details = { from: edge.from, to: edge.to, type: edge.type };
    throw err;
  }
}

function rejectDuplicateEdge(state, edge) {
  const duplicate = state.addedEdges.some((item) => (
    item.from === edge.from && item.to === edge.to && item.type === edge.type
  ));
  if (duplicate) {
    const err = new Error(`txStub: edge ${edge.type} ${edge.from} -> ${edge.to} already exists`);
    err.code = "DUPLICATE_EDGE";
    err.details = { from: edge.from, to: edge.to, type: edge.type };
    throw err;
  }
}

function addEdge(calls, state, edge) {
  const nodes = requireEdgeNodes(state, edge);
  rejectSelfEdge(edge);
  rejectInvalidBlocks({ ...nodes, edge });
  rejectDuplicateEdge(state, edge);
  calls.addEdge.push(edge);
  state.addedEdges.push(edge);
  return { ...edge };
}

function view(state) {
  const nodes = {};
  for (const [id, node] of Object.entries(state.nodes)) {
    nodes[id] = { ...node };
    delete nodes[id].revision;
  }
  return { nodes, edges: state.addedEdges.slice() };
}

// makeTxStub — captures transaction accessor calls. It mirrors the test
// surface of src/kernel/transaction.mjs without exposing provider internals.
export function makeTxStub({ existingNode, initialNodes } = {}) {
  const calls = { createNode: [], updateNode: [], addEdge: [], removeEdge: [], view: 0 };
  const state = makeTxState({ existingNode, initialNodes });
  return {
    calls,
    state,
    getNode(id) {
      return state.nodes[id] ? { ...state.nodes[id] } : undefined;
    },
    createNode(input) {
      return createNode(calls, state, input);
    },
    updateNode(id, patch) {
      return updateNode(calls, state, id, patch);
    },
    addEdge(edge) {
      return addEdge(calls, state, edge);
    },
    removeEdge(edge) {
      calls.removeEdge.push(edge);
      state.removedEdges.push(edge);
      return { ...edge };
    },
    view() {
      calls.view += 1;
      return view(state);
    },
  };
}

export function runTaskCreateApplyTest({ tx, out }) {
  const created = tx.calls.createNode[0];
  assert.equal(tx.calls.createNode.length, 1);
  assert.deepEqual(
    Object.fromEntries(["id", "kind", "subkind", "title", "body", "acceptance", "initiative", "status"].map((key) => [key, created[key]])),
    {
      id: "T-x", kind: "resolvable", subkind: "task", title: "do thing",
      body: "details", acceptance: "done when ok", initiative: "foo", status: "open",
    },
  );
  assert.equal("revision" in created, false, "apply must not carry revision on createNode input");
  assert.deepEqual(tx.calls.addEdge, [
    { from: "T-a", to: "T-x", type: "BLOCKS" },
    { from: "T-b", to: "T-x", type: "BLOCKS" },
  ]);
  assert.equal(tx.calls.updateNode.length + tx.calls.removeEdge.length, 0);
  assert.equal(out.result.id, "T-x");
  assert.deepEqual(out.result.added_edges, tx.calls.addEdge);
  assert.equal(out.effects, null);
}

export function assertTaskUpdatePatchResult({ tx, out }) {
  assert.equal(tx.calls.updateNode.length, 1);
  const update = tx.calls.updateNode[0];
  assert.equal(update.id, "T-x");
  assert.deepEqual(update.patch, { title: "new", body: "b2" });
  assert.equal("revision" in update.patch, false, "apply must not carry revision on updateNode patch");
  assert.equal(tx.calls.createNode.length + tx.calls.addEdge.length + tx.calls.removeEdge.length, 0);
  assert.equal(out.result.id, "T-x");
  assert.equal(out.result.title, "new");
  assert.equal("revision" in out.result, false, "result must not carry revision");
  assert.deepEqual(out.result.added_edges, []);
}

// expectThrows — assert the async function throws, surfacing the
// structured v2 code (the provider reuses throwV2 so callers can
// branch on `err.code === "..."`). Returns the caught error.
export async function expectThrows(fn, code) {
  try {
    await fn();
  } catch (err) {
    if (code !== undefined) {
      assert.equal(err.code, code, `expected code ${code} got ${err.code}: ${err.message}`);
    }
    return err;
  }
  assert.fail("expected throw, got success");
}

// ===================================================================
// task.create
// ===================================================================

export function makeInputTake(overrides = {}) {
  return { id: "T-x", actor: "alice", at: "2026-01-01T00:00:00.000Z", ...overrides };
}

export function makeInputRelease(overrides = {}) {
  return { id: "T-x", actor: "alice", ...overrides };
}

export function makeInputReopen(overrides = {}) {
  return { id: "T-x", actor: "alice", reason: "rolled back", ...overrides };
}

export function makeInputCancel(overrides = {}) {
  return { id: "T-x", actor: "alice", reason: "abandoned", ...overrides };
}
