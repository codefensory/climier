import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, readState as readStateHelper, rmTempProject, writeState as writeStateHelper, importFresh } from "../../helpers.mjs";
import { bootstrapProject, importKernel, createTaskProvider, updateNodeProvider } from "./helpers.mjs";

test("kernel.mutate: provider cannot set 'revision' on a node (tx layer rejects it)", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    const provider = {
      prepare: async ({ snapshot }) => ({
        target: { id: "T2", kind: "resolvable", subkind: "task" },
        policyAction: null,
      }),
      apply: async ({ tx }) => {
        // The provider intentionally tries to seed revision=99 — the
        // tx must reject this so the kernel owns revision assignment
        // (ADR-011 §2).
        tx.createNode({
          id: "T2",
          kind: "resolvable",
          subkind: "task",
          title: "evil",
          status: "open",
          revision: 99,
        });
        return { result: null };
      },
    };
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: { action: "task.create", actor: "alice", input: {} },
        provider,
      });
    } catch (err) { caught = err; }
    assert.ok(caught, "tx must reject provider carrying 'revision'");
    assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT", "tx surfaces INVALID_EXECUTION_CONTRACT");
    const after = await readStateHelper(dir);
    assert.equal(after.nodes.T2, undefined, "no T2 persisted");
    assert.equal(after.log.length, 0);
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel.mutate: existing-node revision is bumped exactly once even on multi-field patch", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    // Provider applies 3 patches to T1 — the kernel must bump revision
    // only once (not once per patch). ADR-011 §2.
    const provider = {
      prepare: async ({ snapshot }) => ({
        target: { id: "T1", kind: "resolvable", subkind: "task" },
        policyAction: null,
      }),
      apply: async ({ tx }) => {
        tx.updateNode("T1", { title: "first" });
        tx.updateNode("T1", { tags: ["a", "b"] });
        tx.updateNode("T1", { domain: "kernel" });
        return { result: null };
      },
    };
    const out = await mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 3 } },
      provider,
    });
    assert.equal(out.idempotent, false);
    const after = await readStateHelper(dir);
    assert.equal(after.nodes.T1.revision, 4, "revision bumps once per apply");
    assert.equal(after.nodes.T1.title, "first");
    assert.deepEqual(after.nodes.T1.tags, ["a", "b"]);
    assert.equal(after.nodes.T1.domain, "kernel");
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel.mutate: edges added and removed in the same apply; only-changed-edge skip bumps node revisions", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    // Provider replaces the existing edge G1->T1 with a new edge T1->T1
    // (will fail because of SELF_EDGE detection — chosen for the noop
    // proof). Better: swap to a different in-snapshot node. Swap
    // G1->T1 with G1->T1-redirected; we add G1->NEW and remove G1->T1.
    const provider = {
      prepare: async ({ snapshot }) => ({
        target: { id: "G1", kind: "resolvable", subkind: "gate" },
        policyAction: null,
      }),
      apply: async ({ tx }) => {
        tx.removeEdge({ from: "G1", to: "T1", type: "BLOCKS" });
        tx.addEdge({ from: "T1", to: "G1", type: "BLOCKS" }); // reverse direction
        return { result: null, effects: null };
      },
    };
    const out = await mutate({
      projectDir: dir,
      request: { action: "edge.swap", actor: "alice", input: {} },
      provider,
    });
    assert.equal(out.idempotent, false, "edge swap is not idempotent");
    assert.equal(out.diff.removed_edges.length, 1);
    assert.equal(out.diff.added_edges.length, 1);
    // No node was changed (only edges moved) — node revisions stay put.
    const after = await readStateHelper(dir);
    assert.equal(after.nodes.T1.revision, 3);
    assert.equal(after.nodes.G1.revision, 3);
    assert.deepEqual(after.edges, [{ from: "T1", to: "G1", type: "BLOCKS" }]);
    assert.equal(after.log.length, 1);
    assert.equal(after.log[0].edges && after.log[0].edges.added.length, 1);
    assert.equal(after.log[0].edges.removed.length, 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel provider diff fences created and modified nodes above state revision", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await writeStateHelper(dir, {
      version: 4,
      revision: 12,
      initiatives: { kernel: { desc: "kernel", created_at: "2026-01-01T00:00:00.000Z" } },
      nodes: {
        T1: { id: "T1", kind: "resolvable", subkind: "task", title: "before", initiative: "kernel", status: "open", revision: 4 },
      },
      edges: [],
      log: [],
    });

    await mutate({
      projectDir: dir,
      request: { action: "task.create", actor: "alice", input: {} },
      provider: createTaskProvider({ id: "T2", title: "new" }),
    });
    let state = await readStateHelper(dir);
    assert.equal(state.nodes.T2.revision, 14);
    assert.equal(state.revision, 14);

    await mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: {} },
      provider: updateNodeProvider({ id: "T1", newTitle: "after" }).provider,
    });
    state = await readStateHelper(dir);
    assert.equal(state.nodes.T1.revision, 15);
    assert.equal(state.revision, 15);
    assert.ok(state.revision >= Math.max(...Object.values(state.nodes).map((node) => node.revision)));
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel mutation diff helpers are extracted and preserve deterministic diff shapes", async () => {
  const diff = await importFresh("./kernel/mutation/diff.mjs");
  const snapshot = {
    nodes: {
      T1: { id: "T1", title: "same", revision: 3 },
      T2: { id: "T2", title: "old", revision: 1 },
    },
    edges: [{ from: "T1", to: "T2", type: "BLOCKS" }],
    initiatives: { kernel: { desc: "kernel" } },
  };
  const draft = {
    nodes: {
      T1: { id: "T1", title: "same" },
      T2: { id: "T2", title: "new" },
      T3: { id: "T3", title: "created" },
    },
    edges: [
      { from: "T1", to: "T2", type: "BLOCKS" },
      { from: "T2", to: "T3", type: "BLOCKS" },
    ],
    initiatives: {
      kernel: { desc: "kernel" },
      auth: { desc: "auth" },
    },
  };

  assert.equal(typeof diff.assignRevisionsAndDiff, "function");
  assert.equal(typeof diff.computeEdgeDiff, "function");
  assert.equal(typeof diff.computeInitiativeDiff, "function");
  assert.equal(typeof diff.deepEqualNodes, "function");
  assert.deepEqual(diff.assignRevisionsAndDiff(snapshot, draft), {
    next: {
      T1: { id: "T1", title: "same", revision: 3 },
      T2: { id: "T2", title: "new", revision: 2 },
      T3: { id: "T3", title: "created", revision: 1 },
    },
    removed: [],
    created: [{ id: "T3", node: { id: "T3", title: "created", revision: 1 } }],
    updated: [{ id: "T2", node: { id: "T2", title: "new", revision: 2 } }],
  });
  assert.deepEqual(diff.computeEdgeDiff(snapshot.edges, draft.edges), {
    added: [{ from: "T2", to: "T3", type: "BLOCKS" }],
    removed: [],
  });
  assert.deepEqual(diff.computeInitiativeDiff(snapshot.initiatives, draft.initiatives), {
    created: [{ name: "auth", initiative: { desc: "auth" } }],
    updated: [],
  });
});

test("kernel mutation request helpers are extracted and preserved through the façade", async () => {
  const request = await importFresh("./kernel/mutation/request.mjs");
  const kernel = await importKernel();

  assert.equal(request.operationLabel({ action: "task.create" }), "kernel.mutate(task.create)");
  assert.equal(request.operationLabel({}), "kernel.mutate");
  assert.equal(request.commandLabel, request.operationLabel);
  for (const name of ["validateRequest", "validateProvider", "validatePlan"]) {
    assert.equal(typeof request[name], "function", `${name} is exported by the request boundary`);
    assert.equal(typeof kernel.__kernelInternals[name], "function", `${name} remains available through __kernelInternals`);
  }
  assert.equal(typeof kernel.__kernelInternals.commandLabel, "function");
  assert.equal(typeof kernel.__kernelInternals.operationLabel, "function");
  assert.equal(kernel.__kernelInternals.commandLabel({ action: "task.create" }), request.operationLabel({ action: "task.create" }));
  assert.equal(kernel.__kernelInternals.operationLabel({}), request.operationLabel({}));
});

test("kernel mutation execution coordinator owns the pipeline while the façade keeps compatibility helpers", async () => {
  const execute = await importFresh("./kernel/mutation/execute.mjs");
  const kernel = await importKernel();

  assert.equal(typeof execute.executeMutation, "function");
  assert.equal(typeof kernel.mutate, "function");
  assert.equal(typeof kernel.__kernelInternals.buildLogEntry, "function");
});

test("revision assignment fences new, recreated, and modified nodes above the state revision", async () => {
  const revisions = await importFresh("./kernel/mutation/revisions.mjs");
  const snapshot = {
    revision: 12,
    nodes: {
      T1: { id: "T1", title: "before", revision: 4 },
      T2: { id: "T2", title: "unchanged", revision: 12 },
    },
  };
  const draft = {
    nodes: {
      T1: { id: "T1", title: "after" },
      T2: { id: "T2", title: "unchanged" },
      T3: { id: "T3", title: "new" },
      // A deleted-and-recreated id is absent from this snapshot too; its
      // revision must be fenced by state.revision, not reset to revision 1.
      T4: { id: "T4", title: "recreated" },
    },
  };

  const assigned = revisions.assignRevisionsAndDiff(snapshot, draft);
  assert.equal(assigned.next.T1.revision, 13);
  assert.equal(assigned.next.T2.revision, 12);
  assert.equal(assigned.next.T3.revision, 13);
  assert.equal(assigned.next.T4.revision, 13);
  assert.equal(revisions.deriveNextStateRevision(snapshot, assigned.next), 13);
  assert.ok(revisions.deriveNextStateRevision(snapshot, assigned.next) >=
    Math.max(...Object.values(assigned.next).map((node) => node.revision)));
});

test("kernel mutation finalization helpers are pure boundaries preserved through the façade", async () => {
  const revisions = await importFresh("./kernel/mutation/revisions.mjs");
  const validation = await importFresh("./kernel/mutation/validation.mjs");
  const logEntry = await importFresh("./kernel/mutation/log-entry.mjs");
  const kernel = await importKernel();

  for (const name of ["assignRevisionsAndDiff", "deriveTargetRevision"]) {
    assert.equal(typeof revisions[name], "function", `${name} is exported by revisions`);
    assert.equal(typeof kernel.__kernelInternals[name], "function", `${name} remains available through the façade`);
  }
  for (const name of ["assignNodeRevision", "deriveNextStateRevision"]) {
    assert.equal(typeof revisions[name], "function", `${name} is exported by revisions`);
  }
  for (const name of ["normalizeLogFields", "validateDraftStructural"]) {
    assert.equal(typeof validation[name], "function", `${name} is exported by validation`);
    assert.equal(typeof kernel.__kernelInternals[name], "function", `${name} remains available through the façade`);
  }
  assert.equal(typeof logEntry.buildLogEntry, "function");
  assert.equal(typeof kernel.__kernelInternals.buildLogEntry, "function");

  const snapshot = { nodes: { T1: { id: "T1", title: "old", revision: 2 } } };
  const draft = { nodes: { T1: { id: "T1", title: "new" } }, edges: [], initiatives: {} };
  const revisionsResult = revisions.assignRevisionsAndDiff(snapshot, draft);
  assert.equal(revisionsResult.updated[0].node.revision, 3);
  assert.equal(revisions.deriveTargetRevision(snapshot, { target: { id: "T1" } }, [], revisionsResult.updated), 3);

  validation.validateDraftStructural(draft, "test");
  assert.deepEqual(validation.normalizeLogFields({ reason: "because", ignored: true }, "test"), { reason: "because" });
  const built = logEntry.buildLogEntry(
    { action: "task.update", actor: "alice" },
    { target: { id: "T1" }, logFields: { reason: "because" } },
    [],
    revisionsResult.updated,
    [],
    [],
    [],
    3,
    null,
    { created: [], updated: [] },
  );
  assert.equal(built.action, "task.update");
  assert.equal(built.agent, "alice");
  assert.equal(built.node, "T1");
  assert.equal(built.revision, 3);
  assert.equal(built.reason, "because");
  assert.match(built.ts, /^\d{4}-\d{2}-\d{2}T/);
});
