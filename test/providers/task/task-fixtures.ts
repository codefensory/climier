import assert from "node:assert/strict";
import { importFresh } from "../../helpers.ts";

const ACTOR = "codex-worker";
type JsonObject = Record<string, unknown>;
type Patch = JsonObject & { status?: string; claim: { by: string; at: string } };
type FixtureNode = JsonObject & { id: string };
type FixtureEdge = { from: string; to: string; type: string };
type FixtureSnapshot = {
  version: number;
  revision: number;
  initiatives: Record<string, JsonObject>;
  nodes: Record<string, FixtureNode>;
  edges: FixtureEdge[];
  log: JsonObject[];
};
type RequestOptions = {
  action?: string;
  input?: JsonObject;
  actor?: string;
  if_revision?: number;
  if_revisions?: Record<string, number>;
};
type TxState = {
  nodes: Record<string, FixtureNode>;
  created: Array<{ id: string; node: FixtureNode }>;
  updated: Array<{ id: string; node: FixtureNode }>;
  addedEdges: FixtureEdge[];
  removedEdges: FixtureEdge[];
};
type TxCalls = {
  createNode: JsonObject[];
  updateNode: Array<{ id: string; patch: Patch }>;
  addEdge: FixtureEdge[];
  removeEdge: FixtureEdge[];
  view: number;
};
type TxStub = {
  calls: TxCalls;
  state: TxState;
  getNode: (id: string) => FixtureNode | undefined;
  createNode: (input: JsonObject & { id: string }) => FixtureNode;
  updateNode: (id: string, patch: Patch) => FixtureNode;
  addEdge: (edge: FixtureEdge) => FixtureEdge;
  removeEdge: (edge: FixtureEdge) => FixtureEdge;
  view: () => { nodes: Record<string, FixtureNode>; edges: FixtureEdge[] };
};

// importTaskProvider — returns the module namespace fresh per call.

// accidental module-level state in the provider would surface as a
// regression.
export async function importTaskProvider() {
  const mod = await importFresh("./providers/task/index.ts");
  return {
    taskCreateProvider: mod.taskCreateProvider,
    taskUpdateProvider: mod.taskUpdateProvider,
    taskTakeProvider: mod.taskTakeProvider,
    taskReleaseProvider: mod.taskReleaseProvider,
    taskReopenProvider: mod.taskReopenProvider,
    taskCancelProvider: mod.taskCancelProvider,
  };
}

// `log`. Tests construct literal snapshots so the provider's read-only
// expectation is verified by reference equality on input.
export function makeSnapshot({
  nodes = {},
  edges = [],
  initiatives = { foo: { desc: "x" } },
  log = [],
  revision = 0,
}: Partial<FixtureSnapshot> = {}): FixtureSnapshot {
  return { version: 2, revision, initiatives, nodes, edges, log };
}

export function makeRequest({ action, input, actor = ACTOR, if_revision, if_revisions }: RequestOptions = {}): RequestOptions {
  const request: RequestOptions = { action, actor, input };
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

function cloneNodes(initialNodes?: Record<string, FixtureNode>): Record<string, FixtureNode> {
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

function makeTxState({ existingNode, initialNodes }: { existingNode?: FixtureNode; initialNodes?: Record<string, FixtureNode> } = {}): TxState {
  const nodes = cloneNodes(initialNodes);
  if (existingNode) {
    nodes[existingNode.id] = { ...existingNode };
    delete nodes[existingNode.id].revision;
  }
  return { nodes, created: [], updated: [], addedEdges: [], removedEdges: [] };
}

function createNode(calls: TxCalls, state: TxState, input: JsonObject & { id: string }): FixtureNode {
  calls.createNode.push(input);
  state.nodes[input.id] = { ...input };
  delete state.nodes[input.id].revision;
  state.created.push({ id: input.id, node: { ...state.nodes[input.id] } });
  return { ...state.nodes[input.id] };
}

function updateNode(calls: TxCalls, state: TxState, id: string, patch: Patch): FixtureNode {
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

function requireEdgeNodes(state: TxState, edge: FixtureEdge): { fromNode: FixtureNode; toNode: FixtureNode } {
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

function rejectSelfEdge(edge: FixtureEdge): void {
  if (edge.from === edge.to) {
    const err = new Error(`txStub: edge ${edge.from} -> ${edge.to} is a self-edge`);
    err.code = "SELF_EDGE";
    err.details = { from: edge.from, to: edge.to, type: edge.type };
    throw err;
  }
}

function rejectInvalidBlocks({ fromNode, toNode, edge }: { fromNode: FixtureNode; toNode: FixtureNode; edge: FixtureEdge }): void {
  if (edge.type === "BLOCKS" && (fromNode.kind !== "resolvable" || toNode.kind !== "resolvable")) {
    const err = new Error("txStub: BLOCKS requires both ends to be resolvable");
    err.code = "INVALID_EDGE_KIND";
    err.details = { from: edge.from, to: edge.to, type: edge.type };
    throw err;
  }
}

function rejectDuplicateEdge(state: TxState, edge: FixtureEdge): void {
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

function addEdge(calls: TxCalls, state: TxState, edge: FixtureEdge): FixtureEdge {
  const nodes = requireEdgeNodes(state, edge);
  rejectSelfEdge(edge);
  rejectInvalidBlocks({ ...nodes, edge });
  rejectDuplicateEdge(state, edge);
  calls.addEdge.push(edge);
  state.addedEdges.push(edge);
  return { ...edge };
}

function view(state: TxState): { nodes: Record<string, FixtureNode>; edges: FixtureEdge[] } {
  const nodes = {};
  for (const [id, node] of Object.entries(state.nodes)) {
    nodes[id] = { ...node };
    delete nodes[id].revision;
  }
  return { nodes, edges: state.addedEdges.slice() };
}

// makeTxStub — captures transaction accessor calls. It mirrors the test
// surface of src/kernel/transaction.ts without exposing provider internals.
export function makeTxStub({ existingNode, initialNodes }: { existingNode?: FixtureNode; initialNodes?: Record<string, FixtureNode> } = {}): TxStub {
  const calls: TxCalls = { createNode: [], updateNode: [], addEdge: [], removeEdge: [], view: 0 };
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

// branch on `err.code === "..."`). Returns the caught error.
export async function expectThrows(
  fn: () => unknown | Promise<unknown>,
  code?: string,
): Promise<Error & { code?: string; details?: unknown }> {
  try {
    await fn();
  } catch (err) {
    if (code !== undefined) {
      const details = err instanceof Error
        ? { code: "code" in err && typeof err.code === "string" ? err.code : undefined, message: err.message }
        : { code: undefined, message: String(err) };
      assert.equal(details.code, code, `expected code ${code} got ${details.code}: ${details.message}`);
    }
    if (err instanceof Error) return err as Error & { code?: string; details?: unknown };
    return Object.assign(new Error(String(err)), { code: undefined as string | undefined });
  }
  assert.fail("expected throw, got success");
}

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
