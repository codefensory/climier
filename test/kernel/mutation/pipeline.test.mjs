import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createTempProject, readState as readStateHelper, rmTempProject, stateFilePath, writeState as writeStateHelper, importFresh } from "../../helpers.mjs";
import { bootstrapProject, importKernel, createTaskProvider, updateNodeProvider } from "./helpers.mjs";

test("kernel.mutate: provider.prepare runs exactly once under the lock", async () => {
  const { mutate } = await importKernel();
  const { provider, count } = updateNodeProvider({ id: "T1", newTitle: "after-prepare-once" });
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    const out = await mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: { id: "T1" }, if_revision: { kind: "single", id: "T1", value: 3 } },
      provider,
    });
    assert.equal(out.log_entry !== null, true, "log entry must exist for a real change");
    assert.equal(count().prepare, 1, "prepare must run once");
    assert.equal(count().apply, 1, "apply must run once");
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel.mutate: provider.apply receives the tx draft (mutates tx only, never state)", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    let applySawTx = false;
    let applyHadPlan = false;
    const provider = {
      prepare: async ({ snapshot }) => ({
        target: { id: "T1", kind: "resolvable", subkind: "task" },
        policyAction: null,
        newTitle: "applied",
      }),
      apply: async ({ tx, plan }) => {
        applySawTx = tx && typeof tx.createNode === "function" && typeof tx.updateNode === "function" && typeof tx.addEdge === "function";
        applyHadPlan = Boolean(plan && plan.newTitle === "applied");
        tx.updateNode("T1", { title: "applied" });
        return { result: { ok: true }, effects: null };
      },
    };
    await mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 3 } },
      provider,
    });
    assert.ok(applySawTx, "apply must receive the tx draft");
    assert.ok(applyHadPlan, "apply must receive the plan with provider-declared fields");
    const finalState = await readStateHelper(dir);
    assert.equal(finalState.nodes.T1.title, "applied");
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// task + edges in a single mutation (B1b acceptance)
// ===================================================================

test("kernel.mutate: creates a task node + BLOCKS edges atomically under one lock", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    const provider = createTaskProvider({
      id: "T2",
      title: "second task",
      edges: [{ from: "T1", to: "T2", type: "BLOCKS" }],
    });
    const out = await mutate({
      projectDir: dir,
      request: { action: "task.create", actor: "alice", input: { id: "T2" } },
      provider,
    });
    assert.equal(out.idempotent, false);
    assert.equal(out.diff.created.length, 1);
    assert.equal(out.diff.created[0].id, "T2");
    assert.equal(out.diff.created[0].node.revision, 4, "new node starts above the fenced state revision");
    assert.equal(out.diff.added_edges.length, 1);
    assert.deepEqual(out.diff.added_edges[0], { from: "T1", to: "T2", type: "BLOCKS" });

    const finalState = await readStateHelper(dir);
    assert.equal(finalState.nodes.T2.revision, 4);
    assert.equal(finalState.nodes.T2.title, "second task");
    assert.equal(finalState.nodes.T1.revision, 3, "T1 unchanged — no revision bump");
    assert.deepEqual(finalState.edges, [
      { from: "G1", to: "T1", type: "BLOCKS" },
      { from: "T1", to: "T2", type: "BLOCKS" },
    ]);
    // Single atomic write: state.log has exactly one new entry.
    assert.equal(finalState.log.length, 1);
    assert.equal(finalState.log[0].action, "task.create");
    assert.equal(finalState.log[0].agent, "alice");
    assert.equal(finalState.log[0].node, "T2");
    assert.equal(finalState.log[0].revision, 4);
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// if_revision / if_revisions precondition under the lock
// ===================================================================

test("kernel.mutate: if_revision (single) mismatch throws REVISION_CONFLICT with no state change and no log", async () => {
  const { mutate } = await importKernel();
  const { provider, count } = updateNodeProvider({ id: "T1", newTitle: "should-not-stick" });
  const dir = await createTempProject();
  try {
    const base = await bootstrapProject(dir);
    const baseMtime = (await fs.stat(stateFilePath(dir))).mtimeMs;

    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 1 } },
        provider,
      });
    } catch (err) { caught = err; }
    assert.ok(caught, "should have thrown");
    assert.equal(caught.code, "REVISION_CONFLICT");
    assert.equal(caught.details.id, "T1");
    assert.equal(caught.details.expected, 1);
    assert.equal(caught.details.current, 3);

    const after = await readStateHelper(dir);
    assert.deepEqual(after.nodes.T1, base.nodes.T1, "no node mutation");
    assert.equal(after.log.length, 0, "no log entry on REVISION_CONFLICT");
    assert.equal(count().prepare, 1, "prepare ran once (read-only)");
    assert.equal(count().apply, 0, "apply did NOT run — precondition rejected first");
    const afterMtime = (await fs.stat(stateFilePath(dir))).mtimeMs;
    assert.equal(afterMtime, baseMtime, "state file untouched (no atomic write)");
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel.mutate: if_revision (single) match applies and bumps revision by 1", async () => {
  const { mutate } = await importKernel();
  const { provider } = updateNodeProvider({ id: "T1", newTitle: "cas-pass" });
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    const out = await mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 3 } },
      provider,
    });
    assert.equal(out.idempotent, false);
    const after = await readStateHelper(dir);
    assert.equal(after.nodes.T1.revision, 4);
    assert.equal(after.nodes.T1.title, "cas-pass");
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel.mutate: if_revisions (multi) for multiple nodes; all must match under the lock", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir, (s) => {
      s.nodes.T2 = { id: "T2", kind: "resolvable", subkind: "task", title: "second", initiative: "kernel", status: "open", revision: 7 };
    });
    // Multi-target update provider: rename both T1 and T2 in a single apply.
    const provider = {
      prepare: async ({ snapshot }) => ({
        target: { id: "T1", kind: "resolvable", subkind: "task" },
        policyAction: null,
      }),
      apply: async ({ tx }) => {
        tx.updateNode("T1", { title: "T1-multi" });
        tx.updateNode("T2", { title: "T2-multi" });
        return { result: null, effects: null };
      },
    };
    const out = await mutate({
      projectDir: dir,
      request: {
        action: "task.multi_update",
        actor: "alice",
        input: {},
          if_revision: { kind: "multi", values: { T1: 8, T2: 8 } },
      },
      provider,
    });
    assert.equal(out.idempotent, false);
    const after = await readStateHelper(dir);
    assert.equal(after.nodes.T1.revision, 9);
    assert.equal(after.nodes.T1.title, "T1-multi");
    assert.equal(after.nodes.T2.revision, 9);
    assert.equal(after.nodes.T2.title, "T2-multi");
    assert.equal(after.log.length, 1, "single multi-update emit");
    assert.equal(after.log[0].action, "task.multi_update");
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel.mutate: if_revisions (multi) mismatch throws on the offending node with no state change", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    const base = await bootstrapProject(dir, (s) => {
      s.nodes.T2 = { id: "T2", kind: "resolvable", subkind: "task", title: "second", initiative: "kernel", status: "open", revision: 7 };
    });
    const provider = {
      prepare: async ({ snapshot }) => ({ target: { id: "T1", kind: "resolvable", subkind: "task" } }),
      apply: async ({ tx }) => {
        tx.updateNode("T1", { title: "should-not-stick" });
        tx.updateNode("T2", { title: "should-not-stick-2" });
        return { result: null };
      },
    };
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: {
          action: "task.multi_update",
          actor: "alice",
          input: {},
          if_revision: { kind: "multi", values: { T1: 8, T2: 99 } },
        },
        provider,
      });
    } catch (err) { caught = err; }
    assert.equal(caught.code, "REVISION_CONFLICT");
    assert.equal(caught.details.id, "T2");
    assert.equal(caught.details.expected, 99);
    assert.equal(caught.details.current, 8);
    const after = await readStateHelper(dir);
    assert.deepEqual(after.nodes.T1, base.nodes.T1, "no T1 partial mutation");
    assert.deepEqual(after.nodes.T2, base.nodes.T2, "no T2 partial mutation");
    assert.equal(after.log.length, 0);
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// Policy seam (deny == POLICY_DENIED)
// ===================================================================

test("kernel.mutate: idempotent op (no diff) bumps nothing, writes nothing, appends no log entry", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    // Provider that "updates" T1 to its current title — no effective change.
    const provider = {
      prepare: async ({ snapshot }) => {
        const node = snapshot.nodes.T1;
        return {
          target: { id: "T1", kind: node.kind, subkind: node.subkind, revision: node.revision },
          policyAction: null,
          newTitle: node.title, // same as snapshot
        };
      },
      apply: async ({ tx, plan }) => {
        tx.updateNode("T1", { title: plan.newTitle });
        return { result: null, effects: { hint: "noop-but-allowed" } };
      },
    };
    const baseMtime = (await fs.stat(stateFilePath(dir))).mtimeMs;
    const out = await mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 3 } },
      provider,
    });
    assert.equal(out.idempotent, true, "no diff ⇒ idempotent");
    assert.equal(out.log_entry, null, "no log entry on idempotent op");
    assert.equal(out.effects && out.effects.hint, "noop-but-allowed", "effects pass through even when no write happens");
    assert.equal(out.diff.created.length, 0);
    assert.equal(out.diff.updated.length, 0);
    assert.equal(out.diff.added_edges.length, 0);
    assert.equal(out.diff.removed_edges.length, 0);
    const after = await readStateHelper(dir);
    assert.equal(after.nodes.T1.revision, 3, "no revision bump on idempotent op");
    assert.equal(after.log.length, 0);
    const afterMtime = (await fs.stat(stateFilePath(dir))).mtimeMs;
    assert.equal(afterMtime, baseMtime, "no state file write on idempotent op");
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// Atomicity: provider and precondition errors do not partial-mutate
// ===================================================================

test("kernel.mutate: effects returned from apply do NOT land in the persisted state", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    const provider = createTaskProvider({
      id: "T3",
      title: "third task",
      edges: [],
      fields: { domain: "kernel", tags: ["alpha", "beta"] },
    });
    const out = await mutate({
      projectDir: dir,
      request: { action: "task.create", actor: "alice", input: { id: "T3" } },
      provider,
    });
    assert.ok(out.effects && out.effects.newly_ready, "effects returned on response");
    const after = await readStateHelper(dir);
    // Effects MUST NOT be on the node or anywhere in persisted state.
    assert.equal(after.nodes.T3.effects, undefined, "node must not carry effects field");
    assert.equal(after.effects, undefined, "state must not carry top-level effects");
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// Revision assignment is central (provider cannot write `revision`)
// ===================================================================

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

// ===================================================================
// Nested mutation rejected (B1b acceptance)
// ===================================================================

test("kernel.mutate: nested mutate throws INVALID_EXECUTION_CONTRACT and inner state untouched", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    let innerCaught = null;
    // Outer provider.apply will call mutate again — must be rejected.
    const innerMutationAttempt = () => mutate({
      projectDir: dir,
      request: { action: "task.create", actor: "alice", input: {} },
      provider: createTaskProvider({ id: "T-inner", title: "evil" }),
    });
    const outerProvider = {
      prepare: async ({ snapshot }) => ({
        target: { id: "T1", kind: "resolvable", subkind: "task" },
        policyAction: null,
      }),
      apply: async () => {
        try {
          await innerMutationAttempt();
        } catch (err) {
          innerCaught = err;
        }
        // Even though the inner call was rejected, we still produce a
        // valid (outer) draft. The outer apply mutates T1 in draft.
        return { result: null };
      },
    };
    // Note: we can't use the outer provider apply directly because it
    // would need a tx — wire it through mutate again so the nested
    // guard actually fires.
    let outerCaught = null;
    try {
      await mutate({
        projectDir: dir,
        request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 3 } },
        provider: {
          prepare: outerProvider.prepare,
          apply: async (applyCtx) => {
            // Attempt nested mutate; capture the rejection but do NOT
            // re-throw so the outer apply can still complete its tx.
            await innerMutationAttempt();
            return { result: null };
          },
        },
      });
    } catch (err) { outerCaught = err; }
    assert.ok(outerCaught, "outer mutation must surface the nested error");
    assert.equal(outerCaught.code, "INVALID_EXECUTION_CONTRACT");
    assert.match(outerCaught.message, /nested kernel\.mutate/i);
    // The inner mutation did NOT touch state — only nodes from the
    // original snapshot remain.
    const after = await readStateHelper(dir);
    assert.equal(after.nodes["T-inner"], undefined, "nested rejection did not persist");
    assert.equal(after.log.length, 0, "no log entry on outer failure");
    // Suppress unused-variable linter complaint.
    assert.equal(innerCaught === null || innerCaught.code === "INVALID_EXECUTION_CONTRACT", true);
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// Atomicity: state + log in one write (observable consequences)
// ===================================================================
//
// We cannot monkey-patch ESM module namespace objects (`state.writeState`),
// so atomicity is verified by its observable consequences:
//   1. After a successful mutation, the on-disk state file contains BOTH
//      the updated node AND a new log entry — there is no intermediate
//      "state-without-log" or "log-without-state" state observable to a
//      second reader between the two writes. We assert this by reading
//      the file via fs after the operation completes and checking the
//      shape.
//   2. If the mutation fails (REVISION_CONFLICT, POLICY_DENIED, apply
//      throws, …), no log entry appears at all — the lock is released
//      without a state write. This is already covered by the negative
//      tests above; here we add a direct on-disk check via mtime + log
//      length.

test("kernel.mutate: non-empty pluginId projects to plugin_id on the log entry", async () => {
  const { mutate } = await importKernel();
  const { provider } = updateNodeProvider({ id: "T1", newTitle: "plugin-attributed" });
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    await mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 3 } },
      provider,
      pluginId: "policy-fixture",
    });
    const after = await readStateHelper(dir);
    assert.equal(after.log.length, 1);
    assert.equal(after.log[0].plugin_id, "policy-fixture");
    assert.equal(after.log[0].action, "task.update");
    assert.equal(after.log[0].revision, 4);
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// Plan log fields / log shape
// ===================================================================

test("kernel.mutate: copies only allow-listed plan.logFields, including historical note, into the log", async () => {
  const { mutate } = await importKernel();
  const { provider: baseProvider } = updateNodeProvider({ id: "T1", newTitle: "logged-fields" });
  const provider = {
    prepare: async ({ snapshot, input, request }) => ({
      ...(await baseProvider.prepare({ snapshot, input, request })),
      logFields: {
        choice: "approved",
        rationale: "matches contract",
        reason: "audited",
        previous_owner: "bob",
        note: "historical audit note",
        ignored: "must not leak",
      },
    }),
    apply: baseProvider.apply,
  };
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    await mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 3 } },
      provider,
    });
    const entry = (await readStateHelper(dir)).log.at(-1);
    assert.equal(entry.choice, "approved");
    assert.equal(entry.rationale, "matches contract");
    assert.equal(entry.reason, "audited");
    assert.equal(entry.previous_owner, "bob");
    assert.equal(entry.note, "historical audit note");
    assert.equal(entry.ignored, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel.mutate: reserved plan.logFields are rejected before apply", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  let applyCalls = 0;
  try {
    await bootstrapProject(dir);
    const provider = {
      prepare: async () => ({
        target: { id: "T1", kind: "resolvable", subkind: "task" },
        logFields: { revision: 99 },
      }),
      apply: async () => {
        applyCalls += 1;
        return { result: null };
      },
    };
    await assert.rejects(
      mutate({ projectDir: dir, request: { action: "task.update", actor: "alice", input: {} }, provider }),
      (err) => err.code === "INVALID_EXECUTION_CONTRACT" && err.details.field === "logFields.revision",
    );
    assert.equal(applyCalls, 0);
    const after = await readStateHelper(dir);
    assert.equal(after.log.length, 0);
    assert.equal(after.nodes.T1.title, "Original task title");
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// Edges: add + remove in one mutation
// ===================================================================

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

// ===================================================================
// Mutation diff boundary
// ===================================================================

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

// ===================================================================
// Mutation request boundary
// ===================================================================

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

// ===================================================================
// Contract gates — explicit throw modes
// ===================================================================

test("kernel.mutate: rejects invalid request (missing action)", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: { actor: "alice" }, // missing action
        provider: { prepare: async () => ({}), apply: async () => ({ result: null }) },
      });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
    assert.equal(caught.details.field, "action");
  } finally { await rmTempProject(dir); }
});

test("kernel.mutate: rejects invalid provider (non-function apply)", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: { action: "task.create", actor: "alice", input: {} },
        provider: { prepare: async () => ({}), apply: "not a function" },
      });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
    assert.equal(caught.details.field, "apply");
  } finally { await rmTempProject(dir); }
});

test("kernel.mutate: rejects plan missing target.id", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: { action: "task.create", actor: "alice", input: {} },
        provider: { prepare: async () => ({ target: {} }), apply: async () => ({ result: null }) },
      });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
    assert.equal(caught.details.field, "target.id");
  } finally { await rmTempProject(dir); }
});

test("kernel.mutate: throws when state file is missing (provider kernel does not bootstrap except initiative.create)", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    // Bootstrap metadata only — no tasks.json yet.
    const { ensureProjectMeta } = await importFresh("./storage/state.mjs");
    await ensureProjectMeta(dir);
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: { action: "task.create", actor: "alice", input: {} },
        provider: createTaskProvider({ id: "T-no-state", title: "x" }),
      });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.match(caught.message, /state file missing or not v5/);
  } finally { await rmTempProject(dir); }
});

// ===================================================================
// Concurrency: serial execution under the lock
// ===================================================================

test("kernel.mutate: source file does not import providers/registry/adapter/bin/ui or forbidden dirs", async () => {
  const fsp = await import("node:fs/promises");
  const fpath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = fpath.dirname(fileURLToPath(import.meta.url));
  const src = await fsp.readFile(fpath.resolve(__dirname, "..", "..", "..", "src", "kernel", "mutate.mjs"), "utf8");
  // Forbidden patterns: anything that would couple the kernel to
  // providers, registry, adapter, bin, UI, or std modules that are not
  // allowed. The plan's B1b explicitly grants `src/storage/state.mjs`,
  // `src/lock.mjs`, and `src/log.mjs` (atomicity primitives + log
  // shaping) and `src/kernel/transaction.mjs` (the existing draft) is
  // the whole point of B1b; those imports are required.
  const forbiddenPatterns = [
    /from\s+["'](node:fs|fs|fs\/promises|path|child_process|crypto|os|stream|util|events)["']/,
    /from\s+["']\.\.\/(paths|plugin|v2|commands|ui|agent|execution-contract|providers)["']/,
    /from\s+["']\.\.?\/(plugin-core-(adapter|registry))["']/,
    /from\s+["']\.\.\/bin\//,
  ];
  // Allowed relative imports — see the task body / ADR-011 §1: the
  // kernel must compose the existing allowed seams.
  const allowedRelative = new Set([
    "../contracts/errors.mjs", // throwV2 for structured errors
    "../storage/state.mjs", // readState + writeState (atomic)
    "../storage/lock.mjs",          // withLock (single-mutation frontier)
    "../storage/log.mjs",           // prepareLogEntry (canonical log shape)
    "./transaction.mjs",    // createTransaction (the existing draft)
    "./mutation/request.mjs", // extracted request/provider/plan contracts
    "./mutation/preconditions.mjs", // extracted CAS precondition contracts
    "./mutation/execute.mjs", // mutation execution coordinator
    "./mutation/diff.mjs", // snapshot-vs-draft diff
    "./mutation/revisions.mjs", // pure revision assignment and lookup
    "./mutation/validation.mjs", // final draft and log-field validation
    "./mutation/log-entry.mjs", // pure mutation log construction
  ]);
  const allRelative = [...src.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)].map((m) => m[1]);
  for (const rel of allRelative) {
    assert.ok(allowedRelative.has(rel), `kernel/mutate.mjs imported forbidden module: ${rel}`);
  }
  for (const p of forbiddenPatterns) {
    assert.doesNotMatch(src, p, `kernel/mutate.mjs must not import forbidden module`);
  }
});
