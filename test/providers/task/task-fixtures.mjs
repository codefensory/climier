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
  if (if_revision !== undefined) request.if_revision = if_revision;
  if (if_revisions !== undefined) request.if_revisions = if_revisions;
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

// makeTxStub — captures createNode / updateNode / addEdge / removeEdge
// / view calls. The provider must mutate only via these accessors; this
// stub exposes the same shape as src/kernel/transaction.mjs's draft.
// `initialNodes` is the draft's starting map (typically the snapshot's
// nodes for update paths, or empty for create paths). `existingNode` is
// retained as a backwards-compatible shorthand for tests that only need
// to seed the target.
export function makeTxStub({ existingNode, initialNodes } = {}) {
  const created = [];
  const updated = [];
  const addedEdges = [];
  const removedEdges = [];
  const nodes = {};
  if (initialNodes && typeof initialNodes === "object") {
    for (const [id, node] of Object.entries(initialNodes)) {
      const cloned = { ...node };
      delete cloned.revision;
      nodes[id] = cloned;
    }
  }
  if (existingNode) {
    nodes[existingNode.id] = { ...existingNode };
    delete nodes[existingNode.id].revision;
  }
  return {
    calls: { createNode: [], updateNode: [], addEdge: [], removeEdge: [], view: 0 },
    state: { nodes, created, updated, addedEdges, removedEdges },
    getNode(id) {
      return this.state.nodes[id] ? { ...this.state.nodes[id] } : undefined;
    },
    createNode(input) {
      this.calls.createNode.push(input);
      this.state.nodes[input.id] = { ...input };
      delete this.state.nodes[input.id].revision;
      this.state.created.push({ id: input.id, node: { ...this.state.nodes[input.id] } });
      return { ...this.state.nodes[input.id] };
    },
    updateNode(id, patch) {
      this.calls.updateNode.push({ id, patch });
      const cur = this.state.nodes[id];
      if (!cur) {
        const err = new Error(`txStub: node ${id} not found`);
        err.code = "NODE_NOT_FOUND";
        throw err;
      }
      if ("revision" in patch) {
        const err = new Error(`txStub: patch for ${id} must not carry 'revision'`);
        err.code = "INVALID_EXECUTION_CONTRACT";
        throw err;
      }
      this.state.nodes[id] = { ...cur, ...patch };
      delete this.state.nodes[id].revision;
      this.state.updated.push({ id, node: { ...this.state.nodes[id] } });
      return { ...this.state.nodes[id] };
    },
    addEdge(edge) {
      // Mirror src/kernel/transaction.mjs#addEdge structural validation
      // so the provider's `apply` can rely on tx.addEdge to enforce
      // self-edge / missing-target / kind / duplicate / type contracts
      // without duplicating that logic in the provider.
      const fromNode = this.state.nodes[edge.from];
      const toNode = this.state.nodes[edge.to];
      if (!fromNode || !toNode) {
        const missing = !fromNode ? edge.from : edge.to;
        const err = new Error(`txStub: edge ${edge.type} ${edge.from} -> ${edge.to} references missing node '${missing}'`);
        err.code = "INVALID_EDGE_TARGET";
        err.details = { from: edge.from, to: edge.to, type: edge.type, missing };
        throw err;
      }
      if (edge.from === edge.to) {
        const err = new Error(`txStub: edge ${edge.from} -> ${edge.to} is a self-edge`);
        err.code = "SELF_EDGE";
        err.details = { from: edge.from, to: edge.to, type: edge.type };
        throw err;
      }
      if (edge.type === "BLOCKS") {
        if (fromNode.kind !== "resolvable" || toNode.kind !== "resolvable") {
          const err = new Error(`txStub: BLOCKS requires both ends to be resolvable`);
          err.code = "INVALID_EDGE_KIND";
          err.details = { from: edge.from, to: edge.to, type: edge.type };
          throw err;
        }
      }
      const dup = this.state.addedEdges.some((e) => e.from === edge.from && e.to === edge.to && e.type === edge.type);
      if (dup) {
        const err = new Error(`txStub: edge ${edge.type} ${edge.from} -> ${edge.to} already exists`);
        err.code = "DUPLICATE_EDGE";
        err.details = { from: edge.from, to: edge.to, type: edge.type };
        throw err;
      }
      this.calls.addEdge.push(edge);
      this.state.addedEdges.push(edge);
      return { ...edge };
    },
    removeEdge(edge) {
      this.calls.removeEdge.push(edge);
      this.state.removedEdges.push(edge);
      return { ...edge };
    },
    view() {
      this.calls.view += 1;
      const nodesOut = {};
      for (const [id, node] of Object.entries(this.state.nodes)) {
        nodesOut[id] = { ...node };
        delete nodesOut[id].revision;
      }
      return { nodes: nodesOut, edges: this.state.addedEdges.slice() };
    },
  };
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
