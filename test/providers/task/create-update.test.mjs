import { test } from "node:test";
import assert from "node:assert/strict";

import { expectThrows, importTaskProvider, makeInputCreate, makeInputUpdate, makeRequest, makeSnapshot, makeTxStub } from "./task-fixtures.mjs";

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
