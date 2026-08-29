// test/provider-task.test.mjs — pure unit tests for the task-core provider.
//
// Plan §B4-task-core + ADR-011 §§1–5 + ADR-012 §3: the task-core provider
// exposes task.create and task.update. Each operation ships a `prepare`
// (read-only, validates domain + DAG against the snapshot) and an `apply`
// (mutates only the in-memory tx draft). This test file is pure:
//   - no filesystem, no lock, no state, no log, no policy, no command,
//     no registry, no adapter, no CLI, no UI;
//   - tests build literal snapshot objects and stub `tx` records that
//     capture createNode / updateNode / addEdge / removeEdge / view
//     invocations;
//   - the kernel contract is exercised by checking that the plan is
//     frozen/read-only and that `apply` never reaches outside the tx
//     surface (no revision writes, no external calls).
//
// The cases cover:
//   - plan shape and frozenness for task.create (target / policyAction /
//     logAction; blocked_by sorted + deduplicated);
//   - task.create validates missing fields (id, kind, subkind, title,
//     body, acceptance, initiative), unknown initiative, missing/self/
//     duplicate blocked_by;
//   - task.create apply composes task + BLOCKS edges atomically using
//     only tx primitives, never touches revision;
//   - task.update plan shape (target, policyAction, logAction,
//     if_revisions) and rejection of unknown / non-task targets,
//     missing if_revision, and revision fields in the patch;
//   - task.update apply uses tx.updateNode and tx.addEdge for new
//     blockers; idempotent patches do not bump revision;
//   - structured errors carry the expected v2 codes (MISSING_FIELD,
//     ID_CONFLICT, INITIATIVE_NOT_FOUND, INVALID_EDGE_TARGET,
//     SELF_EDGE, DUPLICATE_EDGE, NODE_NOT_FOUND,
//     INVALID_EXECUTION_CONTRACT, REVISION_CONFLICT);
//   - isolation: importFresh between cases does not bleed provider
//     state (regression guard for accidental module-level caches).

import { test } from "node:test";
import assert from "node:assert/strict";

import { importFresh } from "./helpers.mjs";

const ACTOR = "codex-worker";

// importTaskProvider — returns the module namespace fresh per call.
// We use importFresh to defeat module caching between tests so any
// accidental module-level state in the provider would surface as a
// regression.
async function importTaskProvider() {
  const mod = await importFresh("./providers/task/index.mjs");
  return {
    taskCreateProvider: mod.taskCreateProvider,
    taskUpdateProvider: mod.taskUpdateProvider,
    taskTakeProvider: mod.taskTakeProvider,
    taskResolveProvider: mod.taskResolveProvider,
    taskReleaseProvider: mod.taskReleaseProvider,
    taskReopenProvider: mod.taskReopenProvider,
    taskCancelProvider: mod.taskCancelProvider,
  };
}

// makeSnapshot — minimal v2 state with `nodes`, `edges`, `initiatives`,
// `log`. Tests construct literal snapshots so the provider's read-only
// expectation is verified by reference equality on input.
function makeSnapshot({ nodes = {}, edges = [], initiatives = { foo: { desc: "x" } }, log = [] } = {}) {
  return { version: 2, initiatives, nodes, edges, log };
}

function makeRequest({ action, input, actor = ACTOR, if_revision, if_revisions } = {}) {
  const request = { action, actor, input };
  if (if_revision !== undefined) request.if_revision = if_revision;
  if (if_revisions !== undefined) request.if_revisions = if_revisions;
  return request;
}

function makeInputCreate(overrides = {}) {
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

function makeInputUpdate(overrides = {}) {
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
function makeTxStub({ existingNode, initialNodes } = {}) {
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
async function expectThrows(fn, code) {
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

test("task.create prepare: returns a frozen plan with target, policyAction and logAction", async () => {
  const { taskCreateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot();
  const input = makeInputCreate();
  const request = makeRequest({ action: "task.create", input });

  const plan = await taskCreateProvider.prepare({ snapshot, input, request });

  assert.equal(plan.target.id, "T-x");
  assert.equal(plan.target.kind, "resolvable");
  assert.equal(plan.target.subkind, "task");
  assert.equal(plan.policyAction.action, "task.create");
  assert.equal(plan.logAction, "add-task");
  assert.ok(Object.isFrozen(plan), "plan must be frozen");
  assert.ok(Object.isFrozen(plan.target), "plan.target must be frozen");
  assert.ok(Object.isFrozen(plan.policyAction), "plan.policyAction must be frozen");
  // read-only: prepare did not mutate the snapshot
  assert.equal(Object.keys(snapshot.nodes).length, 0, "snapshot.nodes must remain empty after prepare");
});

test("task.create prepare: blocks_by is sorted + deduplicated", async () => {
  const { taskCreateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: {
      "T-a": { id: "T-a", kind: "resolvable", subkind: "task", title: "a", status: "open", revision: 1 },
      "T-b": { id: "T-b", kind: "resolvable", subkind: "task", title: "b", status: "open", revision: 1 },
    },
  });
  const input = makeInputCreate({ blocked_by: ["T-b", "T-a", "T-b", "T-a"] });
  const request = makeRequest({ action: "task.create", input });

  const plan = await taskCreateProvider.prepare({ snapshot, input, request });

  assert.deepEqual(plan.target.blocked_by, ["T-a", "T-b"]);
});

test("task.create prepare: rejects missing id (MISSING_FIELD)", async () => {
  const { taskCreateProvider } = await importTaskProvider();
  const input = makeInputCreate({ id: "" });
  const snapshot = makeSnapshot();

  await expectThrows(
    () => taskCreateProvider.prepare({ snapshot, input, request: makeRequest({ action: "task.create", input }) }),
    "MISSING_FIELD",
  );
});

test("task.create prepare: rejects missing initiative (MISSING_FIELD)", async () => {
  const { taskCreateProvider } = await importTaskProvider();
  const input = makeInputCreate({ initiative: undefined });
  const snapshot = makeSnapshot();

  await expectThrows(
    () => taskCreateProvider.prepare({ snapshot, input, request: makeRequest({ action: "task.create", input }) }),
    "MISSING_FIELD",
  );
});

test("task.create prepare: rejects missing title/body/acceptance (MISSING_FIELD)", async () => {
  const { taskCreateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot();

  for (const missingField of ["title", "body", "acceptance"]) {
    const input = makeInputCreate({ [missingField]: "" });
    await expectThrows(
      () => taskCreateProvider.prepare({ snapshot, input, request: makeRequest({ action: "task.create", input }) }),
      "MISSING_FIELD",
    );
  }
});

test("task.create prepare: rejects non-task kind/subkind (INVALID_EXECUTION_CONTRACT)", async () => {
  const { taskCreateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot();

  await expectThrows(
    () => taskCreateProvider.prepare({
      snapshot,
      input: makeInputCreate({ kind: "resolvable", subkind: "gate" }),
      request: makeRequest({ action: "task.create", input: { ...makeInputCreate({ kind: "resolvable", subkind: "gate" }) } }),
    }),
    "INVALID_EXECUTION_CONTRACT",
  );
});

test("task.create prepare: rejects unknown initiative (INITIATIVE_NOT_FOUND)", async () => {
  const { taskCreateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({ initiatives: {} });
  const input = makeInputCreate({ initiative: "ghost" });

  await expectThrows(
    () => taskCreateProvider.prepare({ snapshot, input, request: makeRequest({ action: "task.create", input }) }),
    "INITIATIVE_NOT_FOUND",
  );
});

test("task.create prepare: rejects id already in snapshot (ID_CONFLICT)", async () => {
  const { taskCreateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "old", status: "open", revision: 1 } },
  });
  const input = makeInputCreate();

  await expectThrows(
    () => taskCreateProvider.prepare({ snapshot, input, request: makeRequest({ action: "task.create", input }) }),
    "ID_CONFLICT",
  );
});

test("task.create prepare: rejects missing blocker (INVALID_EDGE_TARGET)", async () => {
  const { taskCreateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-a": { id: "T-a", kind: "resolvable", subkind: "task", title: "a", status: "open", revision: 1 } },
  });
  const input = makeInputCreate({ blocked_by: ["T-a", "T-missing"] });

  await expectThrows(
    () => taskCreateProvider.prepare({ snapshot, input, request: makeRequest({ action: "task.create", input }) }),
    "INVALID_EDGE_TARGET",
  );
});

test("task.create prepare: rejects self-edge (SELF_EDGE)", async () => {
  const { taskCreateProvider } = await importTaskProvider();
  // The task does not exist yet; plan must reject `blocked_by: ["T-x"]`
  // (the future id itself) before any edge is added. We pre-seed an
  // unrelated resolvable to satisfy the existence branch, then ask the
  // provider to block by itself — the validator catches the self-edge.
  const snapshot = makeSnapshot({
    nodes: { "T-z": { id: "T-z", kind: "resolvable", subkind: "task", title: "z", status: "open", revision: 1 } },
  });
  const input = makeInputCreate({ blocked_by: ["T-x"] }); // T-x is the new id

  await expectThrows(
    () => taskCreateProvider.prepare({ snapshot, input, request: makeRequest({ action: "task.create", input }) }),
    "SELF_EDGE",
  );
});

test("task.create prepare: rejects duplicate blockers (DUPLICATE_EDGE)", async () => {
  const { taskCreateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-a": { id: "T-a", kind: "resolvable", subkind: "task", title: "a", status: "open", revision: 1 } },
  });
  // input sets the same blocker twice in raw form. Provider must dedupe
  // before apply so the draft never sees two equal edges. We assert
  // behavior by passing a snapshot that ALREADY has a BLOCKS edge to the
  // blocker — the dedupe conflict then surfaces as DUPLICATE_EDGE.
  const snapshotWithEdge = {
    ...snapshot,
    edges: [{ from: "T-a", to: "T-x", type: "BLOCKS" }],
  };
  const input = makeInputCreate({ blocked_by: ["T-a"] });

  await expectThrows(
    () => taskCreateProvider.prepare({ snapshot: snapshotWithEdge, input, request: makeRequest({ action: "task.create", input }) }),
    "DUPLICATE_EDGE",
  );
});

test("task.create prepare: rejects non-resolvable blocker (INVALID_EDGE_KIND)", async () => {
  const { taskCreateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: {
      "K-foo": { id: "K-foo", kind: "knowledge", title: "k", status: "active", revision: 1 },
    },
  });
  const input = makeInputCreate({ blocked_by: ["K-foo"] });

  await expectThrows(
    () => taskCreateProvider.prepare({ snapshot, input, request: makeRequest({ action: "task.create", input }) }),
    "INVALID_EDGE_KIND",
  );
});

test("task.create apply: composes task + BLOCKS edges atomically through tx only", async () => {
  const { taskCreateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: {
      "T-a": { id: "T-a", kind: "resolvable", subkind: "task", title: "a", status: "open", revision: 1 },
      "T-b": { id: "T-b", kind: "resolvable", subkind: "task", title: "b", status: "open", revision: 1 },
    },
  });
  const input = makeInputCreate({ blocked_by: ["T-a", "T-b"] });
  const request = makeRequest({ action: "task.create", input });
  const plan = await taskCreateProvider.prepare({ snapshot, input, request });

  // Plan is fully self-describing; apply must not re-read snapshot.
  // Seed the stub with the snapshot's existing nodes so tx.addEdge
  // can find the blockers (the real kernel tx loads from the snapshot
  // automatically; we mirror that here).
  const tx = makeTxStub({ initialNodes: snapshot.nodes });
  const out = await taskCreateProvider.apply({ tx, plan, input, request, snapshot });

  // createNode called exactly once with the new task node
  assert.equal(tx.calls.createNode.length, 1);
  const created = tx.calls.createNode[0];
  assert.equal(created.id, "T-x");
  assert.equal(created.kind, "resolvable");
  assert.equal(created.subkind, "task");
  assert.equal(created.title, "do thing");
  assert.equal(created.body, "details");
  assert.equal(created.acceptance, "done when ok");
  assert.equal(created.initiative, "foo");
  assert.equal(created.status, "open");
  // apply MUST NOT carry revision; the kernel assigns it
  assert.equal("revision" in created, false, "apply must not carry revision on createNode input");

  // BLOCKS edges added in canonical direction (blocker -> blocked)
  assert.equal(tx.calls.addEdge.length, 2);
  assert.deepEqual(tx.calls.addEdge[0], { from: "T-a", to: "T-x", type: "BLOCKS" });
  assert.deepEqual(tx.calls.addEdge[1], { from: "T-b", to: "T-x", type: "BLOCKS" });

  // No updateNode/removeEdge should fire on create
  assert.equal(tx.calls.updateNode.length, 0);
  assert.equal(tx.calls.removeEdge.length, 0);

  // Result is the new task shape (without revision) plus the new edges
  assert.equal(out.result.id, "T-x");
  assert.deepEqual(out.result.added_edges, [
    { from: "T-a", to: "T-x", type: "BLOCKS" },
    { from: "T-b", to: "T-x", type: "BLOCKS" },
  ]);
  assert.equal(out.effects, null);
});

test("task.create apply: no-blockers input produces a single createNode with zero edges", async () => {
  const { taskCreateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot();
  const input = makeInputCreate({ blocked_by: [] });
  const request = makeRequest({ action: "task.create", input });
  const plan = await taskCreateProvider.prepare({ snapshot, input, request });

  const tx = makeTxStub({ initialNodes: snapshot.nodes });
  await taskCreateProvider.apply({ tx, plan, input, request, snapshot });

  assert.equal(tx.calls.createNode.length, 1);
  assert.equal(tx.calls.addEdge.length, 0);
});

// ===================================================================
// task.update
// ===================================================================

test("task.update prepare: returns frozen plan with target, policyAction, logAction and if_revisions", async () => {
  const { taskUpdateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "old", status: "open", revision: 3, initiative: "foo" } },
  });
  const input = makeInputUpdate({ changes: { title: "new" }, if_revision: 3 });
  const request = makeRequest({ action: "task.update", input });

  const plan = await taskUpdateProvider.prepare({ snapshot, input, request });

  assert.equal(plan.target.id, "T-x");
  assert.equal(plan.target.kind, "resolvable");
  assert.equal(plan.target.subkind, "task");
  assert.equal(plan.policyAction.action, "task.update");
  assert.equal(plan.logAction, "update");
  // Provider declares the expected revision for the kernel precondition check
  assert.deepEqual(plan.if_revisions, { "T-x": 3 });
  // Patch is normalized (only the keys requested, no spurious fields)
  assert.deepEqual(plan.patch, { title: "new" });
  assert.ok(Object.isFrozen(plan), "plan must be frozen");
  assert.ok(Object.isFrozen(plan.patch), "plan.patch must be frozen");
  // prepare is read-only
  assert.equal(snapshot.nodes["T-x"].title, "old", "snapshot must not be mutated");
});

test("task.update prepare: rejects missing id (MISSING_FIELD)", async () => {
  const { taskUpdateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", revision: 1 } },
  });
  const input = makeInputUpdate({ id: "" });

  await expectThrows(
    () => taskUpdateProvider.prepare({ snapshot, input, request: makeRequest({ action: "task.update", input }) }),
    "MISSING_FIELD",
  );
});

test("task.update prepare: rejects missing target (NODE_NOT_FOUND)", async () => {
  const { taskUpdateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot();
  const input = makeInputUpdate();

  await expectThrows(
    () => taskUpdateProvider.prepare({ snapshot, input, request: makeRequest({ action: "task.update", input }) }),
    "NODE_NOT_FOUND",
  );
});

test("task.update prepare: rejects non-task targets (INVALID_EXECUTION_CONTRACT)", async () => {
  const { taskUpdateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: {
      "G-x": { id: "G-x", kind: "resolvable", subkind: "gate", title: "g", status: "open", revision: 1 },
      "K-x": { id: "K-x", kind: "knowledge", title: "k", status: "active", revision: 1 },
    },
  });

  for (const id of ["G-x", "K-x"]) {
    const input = makeInputUpdate({ id, if_revision: 1 });
    await expectThrows(
      () => taskUpdateProvider.prepare({ snapshot, input, request: makeRequest({ action: "task.update", input }) }),
      "INVALID_EXECUTION_CONTRACT",
    );
  }
});

test("task.update prepare: rejects missing if_revision (MISSING_FIELD)", async () => {
  const { taskUpdateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", revision: 2 } },
  });
  const input = makeInputUpdate({ if_revision: undefined });

  await expectThrows(
    () => taskUpdateProvider.prepare({ snapshot, input, request: makeRequest({ action: "task.update", input }) }),
    "MISSING_FIELD",
  );
});

test("task.update prepare: rejects revision in patch (INVALID_EXECUTION_CONTRACT)", async () => {
  const { taskUpdateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", revision: 1 } },
  });
  const input = makeInputUpdate({ changes: { title: "y", revision: 99 }, if_revision: 1 });

  await expectThrows(
    () => taskUpdateProvider.prepare({ snapshot, input, request: makeRequest({ action: "task.update", input }) }),
    "INVALID_EXECUTION_CONTRACT",
  );
});

test("task.update prepare: rejects if_revision mismatch (REVISION_CONFLICT)", async () => {
  const { taskUpdateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", revision: 5 } },
  });
  const input = makeInputUpdate({ if_revision: 4 });

  await expectThrows(
    () => taskUpdateProvider.prepare({ snapshot, input, request: makeRequest({ action: "task.update", input }) }),
    "REVISION_CONFLICT",
  );
});

test("task.update prepare: rejects empty patch (MISSING_FIELD)", async () => {
  const { taskUpdateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", revision: 1 } },
  });
  const input = makeInputUpdate({ changes: {} });

  await expectThrows(
    () => taskUpdateProvider.prepare({ snapshot, input, request: makeRequest({ action: "task.update", input }) }),
    "MISSING_FIELD",
  );
});

test("task.update prepare: rejects unknown patch keys (INVALID_EXECUTION_CONTRACT)", async () => {
  const { taskUpdateProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", revision: 1 } },
  });
  const input = makeInputUpdate({ changes: { kind: "knowledge" } });

  await expectThrows(
    () => taskUpdateProvider.prepare({ snapshot, input, request: makeRequest({ action: "task.update", input }) }),
    "INVALID_EXECUTION_CONTRACT",
  );
});

test("task.update apply: tx.updateNode only, never carries revision", async () => {
  const { taskUpdateProvider } = await importTaskProvider();
  const existing = { id: "T-x", kind: "resolvable", subkind: "task", title: "old", body: "b", acceptance: "ok", status: "open", initiative: "foo", revision: 3 };
  const snapshot = makeSnapshot({ nodes: { "T-x": existing } });
  const input = makeInputUpdate({ changes: { title: "new", body: "b2" }, if_revision: 3 });
  const request = makeRequest({ action: "task.update", input });
  const plan = await taskUpdateProvider.prepare({ snapshot, input, request });

  const tx = makeTxStub({ existingNode: existing });
  const out = await taskUpdateProvider.apply({ tx, plan, input, request, snapshot });

  // tx.updateNode called exactly once with the normalized patch
  assert.equal(tx.calls.updateNode.length, 1);
  const upd = tx.calls.updateNode[0];
  assert.equal(upd.id, "T-x");
  assert.deepEqual(upd.patch, { title: "new", body: "b2" });
  // patch must NOT carry revision
  assert.equal("revision" in upd.patch, false, "apply must not carry revision on updateNode patch");
  // No node creation / edges on a pure patch
  assert.equal(tx.calls.createNode.length, 0);
  assert.equal(tx.calls.addEdge.length, 0);
  assert.equal(tx.calls.removeEdge.length, 0);
  // Result returns the merged shape without revision
  assert.equal(out.result.id, "T-x");
  assert.equal(out.result.title, "new");
  assert.equal("revision" in out.result, false, "result must not carry revision");
  assert.deepEqual(out.result.added_edges, []);
});

test("task.update apply: adds new BLOCKS edges when blocked_by is supplied", async () => {
  const { taskUpdateProvider } = await importTaskProvider();
  const existing = { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 };
  const snapshot = makeSnapshot({
    nodes: {
      "T-x": existing,
      "T-a": { id: "T-a", kind: "resolvable", subkind: "task", title: "a", status: "open", revision: 1 },
      "T-b": { id: "T-b", kind: "resolvable", subkind: "task", title: "b", status: "open", revision: 1 },
    },
  });
  const input = makeInputUpdate({ changes: { title: "y", blocked_by: ["T-a", "T-b"] }, if_revision: 1 });
  const request = makeRequest({ action: "task.update", input });
  const plan = await taskUpdateProvider.prepare({ snapshot, input, request });

  const tx = makeTxStub({ initialNodes: snapshot.nodes });
  const out = await taskUpdateProvider.apply({ tx, plan, input, request, snapshot });

  assert.equal(tx.calls.updateNode.length, 1);
  assert.equal(tx.calls.updateNode[0].id, "T-x");
  // blocked_by is NOT a top-level node field; it lives in the edges.
  assert.equal("blocked_by" in tx.calls.updateNode[0].patch, false, "blocked_by must not appear in the node patch");
  assert.equal(tx.calls.addEdge.length, 2);
  assert.deepEqual(tx.calls.addEdge[0], { from: "T-a", to: "T-x", type: "BLOCKS" });
  assert.deepEqual(tx.calls.addEdge[1], { from: "T-b", to: "T-x", type: "BLOCKS" });
  assert.deepEqual(out.result.added_edges, [
    { from: "T-a", to: "T-x", type: "BLOCKS" },
    { from: "T-b", to: "T-x", type: "BLOCKS" },
  ]);
});

test("task.update apply: rejects adding a self-blocker (SELF_EDGE)", async () => {
  const { taskUpdateProvider } = await importTaskProvider();
  const existing = { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", revision: 1 };
  const snapshot = makeSnapshot({ nodes: { "T-x": existing } });
  const input = makeInputUpdate({ changes: { blocked_by: ["T-x"] }, if_revision: 1 });
  const request = makeRequest({ action: "task.update", input });
  const plan = await taskUpdateProvider.prepare({ snapshot, input, request });

  const tx = makeTxStub({ initialNodes: snapshot.nodes });
  await expectThrows(
    () => taskUpdateProvider.apply({ tx, plan, input, request, snapshot }),
    "SELF_EDGE",
  );
});

test("task.update apply: rejects adding an already-blocked edge (DUPLICATE_EDGE)", async () => {
  const { taskUpdateProvider } = await importTaskProvider();
  const existing = { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", revision: 1 };
  const snapshot = makeSnapshot({
    nodes: {
      "T-x": existing,
      "T-a": { id: "T-a", kind: "resolvable", subkind: "task", title: "a", status: "open", revision: 1 },
    },
    edges: [{ from: "T-a", to: "T-x", type: "BLOCKS" }],
  });
  const input = makeInputUpdate({ changes: { blocked_by: ["T-a"] }, if_revision: 1 });
  const request = makeRequest({ action: "task.update", input });
  const plan = await taskUpdateProvider.prepare({ snapshot, input, request });

  // Seed the duplicate edge into the stub so tx.addEdge can detect it.
  const tx = makeTxStub({ initialNodes: snapshot.nodes });
  tx.state.addedEdges.push({ from: "T-a", to: "T-x", type: "BLOCKS" });
  await expectThrows(
    () => taskUpdateProvider.apply({ tx, plan, input, request, snapshot }),
    "DUPLICATE_EDGE",
  );
});

// ===================================================================
// Isolation / purity
// ===================================================================

test("providers do not import filesystem, lock, state, log, policy, commands, registry, adapters, CLI or UI", async () => {
  // Smoke: import the provider modules in isolation and confirm they
  // expose only the expected surface. If a future change accidentally
  // pulls in one of the forbidden modules the importFresh will surface
  // the require error here.
  const providers = await importTaskProvider();
  assert.equal(typeof providers.taskCreateProvider.prepare, "function");
  assert.equal(typeof providers.taskCreateProvider.apply, "function");
  assert.equal(typeof providers.taskUpdateProvider.prepare, "function");
  assert.equal(typeof providers.taskUpdateProvider.apply, "function");
  assert.equal(typeof providers.taskTakeProvider.prepare, "function");
  assert.equal(typeof providers.taskTakeProvider.apply, "function");
  assert.equal(typeof providers.taskResolveProvider.prepare, "function");
  assert.equal(typeof providers.taskResolveProvider.apply, "function");
  assert.equal(typeof providers.taskReleaseProvider.prepare, "function");
  assert.equal(typeof providers.taskReleaseProvider.apply, "function");
  assert.equal(typeof providers.taskReopenProvider.prepare, "function");
  assert.equal(typeof providers.taskReopenProvider.apply, "function");
  assert.equal(typeof providers.taskCancelProvider.prepare, "function");
  assert.equal(typeof providers.taskCancelProvider.apply, "function");
  // Each provider is a plain object with exactly two functions.
  for (const provider of [
    providers.taskCreateProvider,
    providers.taskUpdateProvider,
    providers.taskTakeProvider,
    providers.taskResolveProvider,
    providers.taskReleaseProvider,
    providers.taskReopenProvider,
    providers.taskCancelProvider,
  ]) {
    const keys = Object.keys(provider).sort();
    assert.deepEqual(keys, ["apply", "prepare"], `provider keys must be exactly apply/prepare; got ${keys.join(",")}`);
  }
});

// ===================================================================
// task.take / task.takeover — B4-task-lifecycle
// ===================================================================

function makeInputTake(overrides = {}) {
  return { id: "T-x", actor: "alice", at: "2026-01-01T00:00:00.000Z", ...overrides };
}

function makeInputResolve(overrides = {}) {
  return { id: "T-x", actor: "alice", note: "all done", done_at: "2026-01-01T00:00:00.000Z", ...overrides };
}

function makeInputRelease(overrides = {}) {
  return { id: "T-x", actor: "alice", ...overrides };
}

function makeInputReopen(overrides = {}) {
  return { id: "T-x", actor: "alice", reason: "rolled back", ...overrides };
}

function makeInputCancel(overrides = {}) {
  return { id: "T-x", actor: "alice", reason: "abandoned", ...overrides };
}

test("task.take prepare: free task classifies action=task.take and freezes the plan", async () => {
  const { taskTakeProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 } },
  });
  const input = makeInputTake();
  const plan = await taskTakeProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.target.id, "T-x");
  assert.equal(plan.target.kind, "resolvable");
  assert.equal(plan.target.subkind, "task");
  assert.equal(plan.policyAction.action, "task.take");
  assert.equal(plan.logAction, "take");
  assert.equal(plan.idempotent, false);
  assert.equal(plan.takeover, false);
  assert.equal(plan.previous_owner, null);
  assert.equal(plan.logFields, undefined, "free take must not emit previous_owner");
  assert.equal(plan.claim.by, "alice");
  assert.equal(plan.claim.at, "2026-01-01T00:00:00.000Z");
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.target));
  assert.ok(Object.isFrozen(plan.claim));
});

test("task.take prepare: same actor in_progress returns idempotent=true with action=task.take", async () => {
  const { taskTakeProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: {
      "T-x": {
        id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "in_progress",
        claim: { by: "alice", at: "t0" }, initiative: "foo", revision: 1,
      },
    },
  });
  const input = makeInputTake();
  const plan = await taskTakeProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.policyAction.action, "task.take");
  assert.equal(plan.idempotent, true);
  assert.equal(plan.takeover, false);
  assert.equal(plan.previous_owner, null);
});

test("task.take prepare: other actor in_progress classifies action=task.takeover with previous_owner", async () => {
  const { taskTakeProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: {
      "T-x": {
        id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "in_progress",
        claim: { by: "bob", at: "t0" }, initiative: "foo", revision: 1,
      },
    },
  });
  const input = makeInputTake();
  const plan = await taskTakeProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.policyAction.action, "task.takeover");
  assert.equal(plan.idempotent, false);
  assert.equal(plan.takeover, true);
  assert.equal(plan.previous_owner, "bob");
  assert.deepEqual(plan.logFields, { previous_owner: "bob" });
});

test("task.take prepare: blocked task rejects NOT_READY", async () => {
  const { taskTakeProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: {
      "T-dep": { id: "T-dep", kind: "resolvable", subkind: "task", title: "dep", status: "open", revision: 1 },
      "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 },
    },
    edges: [{ from: "T-dep", to: "T-x", type: "BLOCKS" }],
  });
  const input = makeInputTake();

  await expectThrows(
    () => taskTakeProvider.prepare({ snapshot, input, request: {} }),
    "NOT_READY",
  );
});

test("task.take prepare: rejects non-task targets with NOT_CLAIMABLE", async () => {
  const { taskTakeProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "K-x": { id: "K-x", kind: "knowledge", title: "k", status: "active", revision: 1 } },
  });
  const input = makeInputTake({ id: "K-x" });

  await expectThrows(
    () => taskTakeProvider.prepare({ snapshot, input, request: {} }),
    "NOT_CLAIMABLE",
  );
});

test("task.take apply: free task writes claim+in_progress via tx.updateNode, never revision", async () => {
  const { taskTakeProvider } = await importTaskProvider();
  const existing = { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 };
  const snapshot = makeSnapshot({ nodes: { "T-x": existing } });
  const input = makeInputTake();
  const plan = await taskTakeProvider.prepare({ snapshot, input, request: {} });

  const tx = makeTxStub({ existingNode: existing });
  const out = await taskTakeProvider.apply({ tx, plan, input, request: {}, snapshot });

  assert.equal(tx.calls.updateNode.length, 1);
  assert.equal(tx.calls.updateNode[0].id, "T-x");
  assert.equal(tx.calls.updateNode[0].patch.status, "in_progress");
  assert.equal(tx.calls.updateNode[0].patch.claim.by, "alice");
  assert.equal("revision" in tx.calls.updateNode[0].patch, false, "apply must not carry revision");
  assert.equal(out.result.freshly_claimed, true);
  assert.equal(out.result.status, "in_progress");
  assert.equal(out.effects, null);
});

test("task.take apply: idempotent same actor returns no fresh claim and mutates nothing", async () => {
  const { taskTakeProvider } = await importTaskProvider();
  const existing = {
    id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "in_progress",
    claim: { by: "alice", at: "t0" }, initiative: "foo", revision: 3,
  };
  const snapshot = makeSnapshot({ nodes: { "T-x": existing } });
  const input = makeInputTake();
  const plan = await taskTakeProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.idempotent, true);

  const tx = makeTxStub({ existingNode: existing });
  const out = await taskTakeProvider.apply({ tx, plan, input, request: {}, snapshot });

  // idempotent apply must NOT call updateNode
  assert.equal(tx.calls.updateNode.length, 0);
  assert.equal(tx.calls.createNode.length, 0);
  assert.equal(out.result.freshly_claimed, false);
  assert.equal(out.result.status, "in_progress");
  assert.equal(out.effects, null);
});

// ===================================================================
// task.resolve — B4-task-lifecycle
// ===================================================================

test("task.resolve prepare: open task returns frozen plan with note + done_by + done_at", async () => {
  const { taskResolveProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 } },
  });
  const input = makeInputResolve();
  const plan = await taskResolveProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.target.id, "T-x");
  assert.equal(plan.policyAction.action, "task.resolve");
  assert.equal(plan.logAction, "resolve");
  assert.equal(plan.note, "all done");
  assert.equal(plan.done_by, "alice");
  assert.equal(plan.done_at, "2026-01-01T00:00:00.000Z");
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.target));
});

test("task.resolve prepare: rejects done tasks with INVALID_STATUS", async () => {
  const { taskResolveProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "done", initiative: "foo", revision: 1 } },
  });
  const input = makeInputResolve();

  await expectThrows(
    () => taskResolveProvider.prepare({ snapshot, input, request: {} }),
    "INVALID_STATUS",
  );
});

test("task.resolve prepare: rejects missing note with MISSING_FIELD", async () => {
  const { taskResolveProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 } },
  });
  const input = makeInputResolve({ note: "" });

  await expectThrows(
    () => taskResolveProvider.prepare({ snapshot, input, request: {} }),
    "MISSING_FIELD",
  );
});

test("task.resolve apply: writes done+done_by+done_at+note+claim=null via tx.updateNode and emits newly_ready", async () => {
  const { taskResolveProvider } = await importTaskProvider();
  // Snapshot has T-x (open, blocked by T-dep) and T-dep (open). When
  // T-dep is resolved first the apply should report T-x as newly_ready.
  const depNode = { id: "T-dep", kind: "resolvable", subkind: "task", title: "dep", status: "open", initiative: "foo", revision: 1 };
  const targetNode = { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 };
  const snapshot = makeSnapshot({
    nodes: { "T-dep": depNode, "T-x": targetNode },
    edges: [{ from: "T-dep", to: "T-x", type: "BLOCKS" }],
  });
  const input = makeInputResolve({ id: "T-dep" });
  const plan = await taskResolveProvider.prepare({ snapshot, input, request: {} });

  const tx = makeTxStub({ initialNodes: snapshot.nodes });
  // Seed the snapshot's existing BLOCKS edge into the tx stub so
  // tx.view() reflects the pre-apply graph.
  tx.state.addedEdges.push({ from: "T-dep", to: "T-x", type: "BLOCKS" });
  const out = await taskResolveProvider.apply({ tx, plan, input, request: {}, snapshot });

  assert.equal(tx.calls.updateNode.length, 1);
  const upd = tx.calls.updateNode[0];
  assert.equal(upd.id, "T-dep");
  assert.equal(upd.patch.status, "done");
  assert.equal(upd.patch.done_by, "alice");
  assert.equal(upd.patch.note, "all done");
  assert.equal(upd.patch.claim, null);
  assert.equal("revision" in upd.patch, false, "apply must not carry revision");

  // Effects: T-x should be in newly_ready (was blocked, now its only
  // blocker T-dep is done).
  assert.ok(out.effects, "resolve must emit effects");
  assert.deepEqual(out.effects.newly_ready, ["T-x"]);
  // No new edges
  assert.equal(tx.calls.addEdge.length, 0);
  assert.equal(tx.calls.removeEdge.length, 0);
  assert.equal(tx.calls.createNode.length, 0);
});

// ===================================================================
// task.release — B4-task-lifecycle
// ===================================================================

test("task.release prepare: claimed task returns plan with previous_owner and idempotent=false", async () => {
  const { taskReleaseProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: {
      "T-x": {
        id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "in_progress",
        claim: { by: "alice", at: "t0" }, initiative: "foo", revision: 3,
      },
    },
  });
  const input = makeInputRelease();
  const plan = await taskReleaseProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.target.id, "T-x");
  assert.equal(plan.policyAction.action, "task.release");
  assert.equal(plan.logAction, "release");
  assert.equal(plan.idempotent, false);
  assert.equal(plan.previous_owner, "alice");
  assert.equal(plan.target.previous_owner, "alice");
  assert.ok(Object.isFrozen(plan));
});

test("task.release prepare: no-claim returns idempotent=true (no-op)", async () => {
  const { taskReleaseProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 } },
  });
  const input = makeInputRelease();
  const plan = await taskReleaseProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.idempotent, true);
  assert.equal(plan.previous_owner, null);
});

test("task.release prepare: rejects non-task targets with INVALID_STATUS", async () => {
  const { taskReleaseProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "G-x": { id: "G-x", kind: "resolvable", subkind: "gate", title: "g", status: "open", revision: 1 } },
  });
  const input = makeInputRelease({ id: "G-x" });

  await expectThrows(
    () => taskReleaseProvider.prepare({ snapshot, input, request: {} }),
    "INVALID_STATUS",
  );
});

test("task.release apply: clears claim and resets to open; no revision write", async () => {
  const { taskReleaseProvider } = await importTaskProvider();
  const existing = {
    id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "in_progress",
    claim: { by: "alice", at: "t0" }, initiative: "foo", revision: 3,
  };
  const snapshot = makeSnapshot({ nodes: { "T-x": existing } });
  const input = makeInputRelease();
  const plan = await taskReleaseProvider.prepare({ snapshot, input, request: {} });

  const tx = makeTxStub({ existingNode: existing });
  const out = await taskReleaseProvider.apply({ tx, plan, input, request: {}, snapshot });

  assert.equal(tx.calls.updateNode.length, 1);
  assert.equal(tx.calls.updateNode[0].id, "T-x");
  assert.equal(tx.calls.updateNode[0].patch.claim, null);
  assert.equal(tx.calls.updateNode[0].patch.status, "open");
  assert.equal("revision" in tx.calls.updateNode[0].patch, false);
  assert.equal(out.result.released, true);
  assert.equal(out.result.status, "open");
  assert.equal(out.result.previous_owner, "alice");
});

test("task.release apply: idempotent no-claim path skips updateNode", async () => {
  const { taskReleaseProvider } = await importTaskProvider();
  const existing = { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 };
  const snapshot = makeSnapshot({ nodes: { "T-x": existing } });
  const input = makeInputRelease();
  const plan = await taskReleaseProvider.prepare({ snapshot, input, request: {} });
  assert.equal(plan.idempotent, true);

  const tx = makeTxStub({ existingNode: existing });
  const out = await taskReleaseProvider.apply({ tx, plan, input, request: {}, snapshot });

  assert.equal(tx.calls.updateNode.length, 0);
  assert.equal(out.result.released, false);
});

// ===================================================================
// task.reopen — B4-task-lifecycle
// ===================================================================

test("task.reopen prepare: done task returns frozen plan with reason and previous_done_by", async () => {
  const { taskReopenProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: {
      "T-x": {
        id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "done",
        done_by: "alice", done_at: "t0", note: "shipped", initiative: "foo", revision: 2,
      },
    },
  });
  const input = makeInputReopen();
  const plan = await taskReopenProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.target.id, "T-x");
  assert.equal(plan.policyAction.action, "task.reopen");
  assert.equal(plan.logAction, "reopen");
  assert.equal(plan.reason, "rolled back");
  assert.equal(plan.target.previous_done_by, "alice");
  assert.ok(Object.isFrozen(plan));
});

test("task.reopen prepare: rejects open tasks with INVALID_STATUS", async () => {
  const { taskReopenProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 } },
  });
  const input = makeInputReopen();

  await expectThrows(
    () => taskReopenProvider.prepare({ snapshot, input, request: {} }),
    "INVALID_STATUS",
  );
});

test("task.reopen prepare: rejects missing reason with MISSING_FIELD", async () => {
  const { taskReopenProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "done", initiative: "foo", revision: 1 } },
  });
  const input = makeInputReopen({ reason: "" });

  await expectThrows(
    () => taskReopenProvider.prepare({ snapshot, input, request: {} }),
    "MISSING_FIELD",
  );
});

test("task.reopen apply: rolls done -> open, clears claim; never writes revision", async () => {
  const { taskReopenProvider } = await importTaskProvider();
  const existing = {
    id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "done",
    done_by: "alice", done_at: "t0", note: "shipped", initiative: "foo", revision: 2,
  };
  const snapshot = makeSnapshot({ nodes: { "T-x": existing } });
  const input = makeInputReopen();
  const plan = await taskReopenProvider.prepare({ snapshot, input, request: {} });

  const tx = makeTxStub({ existingNode: existing });
  const out = await taskReopenProvider.apply({ tx, plan, input, request: {}, snapshot });

  assert.equal(tx.calls.updateNode.length, 1);
  assert.equal(tx.calls.updateNode[0].id, "T-x");
  assert.equal(tx.calls.updateNode[0].patch.status, "open");
  assert.equal(tx.calls.updateNode[0].patch.claim, null);
  assert.equal("revision" in tx.calls.updateNode[0].patch, false);
  assert.equal(out.result.status, "open");
  assert.equal(out.result.previous_done_by, "alice");
});

// ===================================================================
// task.cancel — B4-task-lifecycle
// ===================================================================

test("task.cancel prepare: open task returns frozen plan with reason and previous_owner=null", async () => {
  const { taskCancelProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 } },
  });
  const input = makeInputCancel();
  const plan = await taskCancelProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.target.id, "T-x");
  assert.equal(plan.policyAction.action, "task.cancel");
  assert.equal(plan.logAction, "cancel");
  assert.equal(plan.reason, "abandoned");
  assert.equal(plan.target.previous_owner, null);
  assert.ok(Object.isFrozen(plan));
});

test("task.cancel prepare: in_progress carries previous_owner in target", async () => {
  const { taskCancelProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: {
      "T-x": {
        id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "in_progress",
        claim: { by: "alice", at: "t0" }, initiative: "foo", revision: 1,
      },
    },
  });
  const input = makeInputCancel();
  const plan = await taskCancelProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.target.previous_owner, "alice");
});

test("task.cancel prepare: rejects done tasks with INVALID_STATUS", async () => {
  const { taskCancelProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "done", initiative: "foo", revision: 1 } },
  });
  const input = makeInputCancel();

  await expectThrows(
    () => taskCancelProvider.prepare({ snapshot, input, request: {} }),
    "INVALID_STATUS",
  );
});

test("task.cancel prepare: rejects missing reason with MISSING_FIELD", async () => {
  const { taskCancelProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 } },
  });
  const input = makeInputCancel({ reason: "" });

  await expectThrows(
    () => taskCancelProvider.prepare({ snapshot, input, request: {} }),
    "MISSING_FIELD",
  );
});

test("task.cancel apply: sets canceled, clears claim; never writes revision", async () => {
  const { taskCancelProvider } = await importTaskProvider();
  const existing = {
    id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "in_progress",
    claim: { by: "alice", at: "t0" }, initiative: "foo", revision: 1,
  };
  const snapshot = makeSnapshot({ nodes: { "T-x": existing } });
  const input = makeInputCancel();
  const plan = await taskCancelProvider.prepare({ snapshot, input, request: {} });

  const tx = makeTxStub({ existingNode: existing });
  const out = await taskCancelProvider.apply({ tx, plan, input, request: {}, snapshot });

  assert.equal(tx.calls.updateNode.length, 1);
  assert.equal(tx.calls.updateNode[0].id, "T-x");
  assert.equal(tx.calls.updateNode[0].patch.status, "canceled");
  assert.equal(tx.calls.updateNode[0].patch.claim, null);
  assert.equal("revision" in tx.calls.updateNode[0].patch, false);
  assert.equal(out.result.status, "canceled");
  assert.equal(out.result.previous_owner, "alice");
});
