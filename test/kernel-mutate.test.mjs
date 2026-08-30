// test/kernel-mutate.test.mjs — focused integration tests for kernel.mutate.
//
// Covers the B1b slice of the kernel execution plan:
//   - a single `withLock` covers the entire mutation;
//   - `provider.prepare` runs exactly once;
//   - `provider.apply` runs against `createTransaction`'s draft (tx);
//   - if_revision (single) and if_revisions (multi) are validated under
//     the lock, BEFORE apply;
//   - policy authorize runs against the fresh snapshot + plan;
//   - new nodes start at revision 1; modified nodes increment by 1; an
//     idempotent operation (no diff) bumps nothing and logs nothing;
//   - state + log persist in a SINGLE writeState call (no second route);
//   - errors from prepare/apply/policy/precondition do not partial-
//     mutate state;
//   - edges are composed with task nodes in one mutation;
//   - nested kernel.mutate is rejected;
//   - non-persisted effects come back through the response.
// Each test exercises the public API end-to-end against a temp project
// dir; isolation comes from helpers (auto temp CLIMIER_HOME).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { createTempProject, rmTempProject, importFresh, writeState as writeStateHelper, readState as readStateHelper, stateFilePath } from "./helpers.mjs";

// importKernel — helper that imports the kernel module fresh and pulls
// both `mutate` and `__kernelInternals` from the named export. Mutate is
// exported by name, not as default; helpers.mjs's importFresh returns
// the module's namespace, so we destructure `mutate` directly.
async function importKernel() {
  return importFresh("./kernel/mutate.mjs");
}

// ===================================================================
// Fixture providers
// ===================================================================

// createTaskProvider — composes a brand-new node + edges in one apply.
function createTaskProvider({ id, kind = "resolvable", subkind = "task", title, revisionAfter = 1, edges = [], fields = {} } = {}) {
  return {
    prepare: async ({ snapshot }) => {
      return {
        target: { id, kind, subkind },
        policyAction: null,
        idempotent: false,
        // The plan carries enough information for apply to compose
        // without re-reading the snapshot.
        edges,
      };
    },
    apply: async ({ tx, plan }) => {
      tx.createNode({
        id: plan.target.id,
        kind: plan.target.kind,
        subkind: plan.target.subkind,
        title,
        status: "open",
        ...fields,
      });
      for (const edge of plan.edges || []) {
        tx.addEdge(edge);
      }
      return {
        result: { id: plan.target.id, kind: plan.target.kind, subkind: plan.target.subkind },
        effects: { newly_ready: [plan.target.id] },
      };
    },
  };
}

// updateNodeProvider — updates an existing node's title.
function updateNodeProvider({ id, newTitle, newRevision }) {
  let prepareCalls = 0;
  let applyCalls = 0;
  const provider = {
    prepare: async ({ snapshot }) => {
      prepareCalls += 1;
      const node = snapshot.nodes[id];
      if (!node) {
        const err = new Error("updateNodeProvider: target missing");
        err.code = "NODE_NOT_FOUND";
        throw err;
      }
      return {
        target: { id, kind: node.kind, subkind: node.subkind, status: node.status, revision: node.revision },
        policyAction: null,
        idempotent: false,
        newTitle,
      };
    },
    apply: async ({ tx, plan }) => {
      applyCalls += 1;
      tx.updateNode(plan.target.id, { title: plan.newTitle });
      return { result: { id: plan.target.id, title: plan.newTitle }, effects: null };
    },
  };
  return { provider, count: () => ({ prepare: prepareCalls, apply: applyCalls }) };
}

// failingPrepareProvider — prepare throws a structured error.
function failingPrepareProvider(message = "blocked by domain rule") {
  return {
    prepare: async () => {
      const err = new Error(message);
      err.code = "INVALID_PROVIDER";
      throw err;
    },
    apply: async () => ({ result: null }),
  };
}

// failingApplyProvider — apply throws AFTER prepare succeeds.
function failingApplyProvider(message = "boom in apply") {
  return {
    prepare: async ({ snapshot }) => ({
      target: { id: "T-apply-fail", kind: "resolvable", subkind: "task" },
      policyAction: null,
      newTitle: "x",
    }),
    apply: async () => {
      const err = new Error(message);
      err.code = "PROVIDER_APPLY_FAILED";
      throw err;
    },
  };
}

// ===================================================================
// Base state fixture
// ===================================================================

async function bootstrapProject(dir, mutate) {
  const base = {
    version: 2,
    nodes: {
      G1: {
        id: "G1",
        kind: "resolvable",
        subkind: "gate",
        title: "Gate 1",
        initiative: "kernel",
        status: "open",
        revision: 1,
      },
      T1: {
        id: "T1",
        kind: "resolvable",
        subkind: "task",
        title: "Original task title",
        initiative: "kernel",
        status: "open",
        revision: 3,
      },
    },
    edges: [
      { from: "G1", to: "T1", type: "BLOCKS" },
    ],
    initiatives: { kernel: { desc: "kernel", created_at: "2026-01-01T00:00:00.000Z" } },
    log: [],
  };
  if (typeof mutate === "function") mutate(base);
  await writeStateHelper(dir, base);
  return base;
}

// ===================================================================
// prepare / apply basics
// ===================================================================

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
    assert.equal(out.diff.created[0].node.revision, 1, "new node starts at revision 1");
    assert.equal(out.diff.added_edges.length, 1);
    assert.deepEqual(out.diff.added_edges[0], { from: "T1", to: "T2", type: "BLOCKS" });

    const finalState = await readStateHelper(dir);
    assert.equal(finalState.nodes.T2.revision, 1);
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
    assert.equal(finalState.log[0].revision, 1);
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
        request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 2 } },
        provider,
      });
    } catch (err) { caught = err; }
    assert.ok(caught, "should have thrown");
    assert.equal(caught.code, "REVISION_CONFLICT");
    assert.equal(caught.details.id, "T1");
    assert.equal(caught.details.expected, 2);
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
        if_revision: { kind: "multi", values: { T1: 3, T2: 7 } },
      },
      provider,
    });
    assert.equal(out.idempotent, false);
    const after = await readStateHelper(dir);
    assert.equal(after.nodes.T1.revision, 4);
    assert.equal(after.nodes.T1.title, "T1-multi");
    assert.equal(after.nodes.T2.revision, 8);
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
          if_revision: { kind: "multi", values: { T1: 3, T2: 99 } },
        },
        provider,
      });
    } catch (err) { caught = err; }
    assert.equal(caught.code, "REVISION_CONFLICT");
    assert.equal(caught.details.id, "T2");
    assert.equal(caught.details.expected, 99);
    assert.equal(caught.details.current, 7);
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

test("kernel.mutate: policyAction.decide = deny throws POLICY_DENIED with no state change", async () => {
  const { mutate } = await importKernel();
  const { provider } = updateNodeProvider({ id: "T1", newTitle: "should-not-stick" });
  const dir = await createTempProject();
  try {
    const base = await bootstrapProject(dir);
    let decidedWith = null;
    const policyAction = {
      pluginId: "policy-fixture",
      action: "task.update",
      decide: async ({ snapshot, target, action }) => {
        decidedWith = { target, action };
        return { decision: "deny", reason: "too risky" };
      },
    };
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 3 } },
        provider,
        policyAction,
      });
    } catch (err) { caught = err; }
    assert.ok(caught, "deny should throw");
    assert.equal(caught.code, "POLICY_DENIED");
    assert.equal(caught.details.action, "task.update");
    assert.equal(caught.details.reason, "too risky");
    assert.equal(caught.details.policy_id, "policy-fixture");
    assert.ok(decidedWith, "decide was called");
    assert.equal(decidedWith.action, "task.update");
    assert.equal(decidedWith.target.id, "T1");
    const after = await readStateHelper(dir);
    assert.deepEqual(after.nodes.T1, base.nodes.T1, "no mutation after deny");
    assert.equal(after.log.length, 0);
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel.mutate: policyAction.decide = allow proceeds (does not throw)", async () => {
  const { mutate } = await importKernel();
  const { provider } = updateNodeProvider({ id: "T1", newTitle: "policy-allowed" });
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    const out = await mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 3 } },
      provider,
      policyAction: { pluginId: "policy-fixture", action: "task.update", decide: async () => ({ decision: "allow" }) },
    });
    assert.equal(out.idempotent, false);
    const after = await readStateHelper(dir);
    assert.equal(after.nodes.T1.title, "policy-allowed");
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel.mutate: policyAction.decide runs against the FRESH snapshot under the lock", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    let capturedRevision = null;
    const provider = {
      prepare: async ({ snapshot }) => ({ target: { id: "T1", kind: "resolvable", subkind: "task" } }),
      apply: async ({ tx }) => {
        tx.updateNode("T1", { title: "post-policy" });
        return { result: null };
      },
    };
    await mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 3 } },
      provider,
      policyAction: {
        pluginId: "policy-fixture",
        decide: async ({ snapshot }) => {
          // Snapshot must show pre-apply state (revision still 3).
          capturedRevision = snapshot.nodes.T1.revision;
          return { decision: "allow" };
        },
      },
    });
    assert.equal(capturedRevision, 3, "policy must see the fresh snapshot, not post-apply");
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// Idempotency (no diff ⇒ no write, no log)
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

test("kernel.mutate: provider.prepare throws ⇒ no state mutation, no log entry, lock released", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    const base = await bootstrapProject(dir);
    let lockObserved = false;
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: { action: "task.create", actor: "alice", input: {} },
        provider: failingPrepareProvider("domain rule violated"),
      });
    } catch (err) { caught = err; }
    assert.ok(caught, "must propagate provider error");
    assert.equal(caught.code, "INVALID_PROVIDER");
    const after = await readStateHelper(dir);
    assert.deepEqual(after.nodes, base.nodes);
    assert.equal(after.log.length, 0);
    // Lock released: a fresh withLock should succeed immediately.
    const { withLock } = await importFresh("./storage/lock.mjs");
    await withLock(dir, async () => { lockObserved = true; });
    assert.equal(lockObserved, true, "withLock must be released after the failing call");
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel.mutate: provider.apply throws after prepare succeeds ⇒ no state mutation, no log entry", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    const base = await bootstrapProject(dir);
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: { action: "task.create", actor: "alice", input: {} },
        provider: failingApplyProvider("boom in apply"),
      });
    } catch (err) { caught = err; }
    assert.ok(caught, "must surface apply error");
    assert.equal(caught.code, "PROVIDER_APPLY_FAILED");
    const after = await readStateHelper(dir);
    assert.deepEqual(after.nodes, base.nodes, "apply error must NOT persist partial state");
    assert.equal(after.log.length, 0);
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// Effects are not persisted (ADR-011 §4)
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

test("kernel.mutate: state + log are persisted together; final on-disk state has both", async () => {
  const { mutate } = await importKernel();
  const { provider } = updateNodeProvider({ id: "T1", newTitle: "atomic-final" });
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    const baseLog = (await readStateHelper(dir)).log.length;
    await mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 3 } },
      provider,
    });
    // Re-read via fs (out-of-band to bypass any in-process cache).
    const raw = JSON.parse(await fs.readFile(stateFilePath(dir), "utf8"));
    assert.equal(raw.nodes.T1.title, "atomic-final", "node mutation persisted");
    assert.equal(raw.nodes.T1.revision, 4, "revision bumped once");
    assert.equal(raw.log.length, baseLog + 1, "exactly one log entry appended");
    assert.equal(raw.log[raw.log.length - 1].action, "task.update");
    assert.equal(raw.log[raw.log.length - 1].revision, 4, "log entry records the post-bump revision");
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel.mutate: failing call writes nothing — final on-disk state equals pre-call snapshot", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    const base = await bootstrapProject(dir);
    const baseRaw = await fs.readFile(stateFilePath(dir), "utf8");
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: { action: "task.create", actor: "alice", input: {} },
        provider: failingPrepareProvider("domain rule"),
      });
    } catch (err) { caught = err; }
    assert.ok(caught, "should propagate the error");
    const afterRaw = await fs.readFile(stateFilePath(dir), "utf8");
    assert.equal(afterRaw, baseRaw, "on-disk state unchanged byte-for-byte after a failed mutate");
    const after = await readStateHelper(dir);
    assert.deepEqual(after.nodes, base.nodes);
    assert.equal(after.log.length, 0);
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// Plugin attribution / log shape
// ===================================================================

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
    assert.equal(after.nodes.G1.revision, 1);
    assert.deepEqual(after.edges, [{ from: "T1", to: "G1", type: "BLOCKS" }]);
    assert.equal(after.log.length, 1);
    assert.equal(after.log[0].edges && after.log[0].edges.added.length, 1);
    assert.equal(after.log[0].edges.removed.length, 1);
  } finally {
    await rmTempProject(dir);
  }
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

test("kernel.mutate: throws when state file is missing (v2 kernel does not bootstrap)", async () => {
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
    assert.match(caught.message, /state file missing or not v2/);
  } finally { await rmTempProject(dir); }
});

// ===================================================================
// Concurrency: serial execution under the lock
// ===================================================================

test("kernel.mutate: two concurrent mutate calls serialise under the project lock", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrapProject(dir);
    const provider1 = updateNodeProvider({ id: "T1", newTitle: "first-arrives" }).provider;
    const provider2 = updateNodeProvider({ id: "T1", newTitle: "second-arrives" }).provider;
    // Fire both at once. They DO NOT race because withLock spins.
    // req1 carries if_revision=3 (matches the initial snapshot).
    // req2 carries if_revision=4 — it only matches if req1 has already
    // bumped T1 from 3 to 4 by the time req2 acquires the lock.
    const req1 = mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 3 } },
      provider: provider1,
    });
    const req2 = mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 4 } },
      provider: provider2,
    });
    const settled = await Promise.allSettled([req1, req2]);
    // T-graph-kernel-mutate-concurrency-fix: independent concurrent
    // mutations must NOT be flagged as nested. REVISION_CONFLICT is
    // still acceptable when req2 acquires the lock first and its
    // if_revision=4 doesn't match the initial snapshot rev=3.
    for (const r of settled) {
      if (r.status === "rejected") {
        assert.notEqual(r.reason && r.reason.code, "INVALID_EXECUTION_CONTRACT",
          `concurrent mutate was falsely flagged as nested: ${r.reason && r.reason.message}`);
      }
    }
    const after = await readStateHelper(dir);
    // Two possible orderings under withLock serialisation:
    //   (A) req1 first: req1 applies 3→4 ("first-arrives"); req2
    //       sees rev=4, applies 4→5 ("second-arrives"). Final rev=5.
    //   (B) req2 first: req2's if_revision=4 doesn't match snapshot
    //       rev=3, REVISION_CONFLICT, no write. req1 then applies
    //       3→4 ("first-arrives"). Final rev=4.
    if (after.nodes.T1.revision === 5) {
      assert.equal(after.nodes.T1.title, "second-arrives",
        "ordering A: req1 wrote rev 3→4, req2 wrote rev 4→5");
      assert.equal(after.log.length, 2, "ordering A: both writes persisted");
      assert.deepEqual(after.log.map((e) => e.revision), [4, 5],
        "log entries carry the matching post-bump revisions in order");
    } else {
      assert.equal(after.nodes.T1.revision, 4, "ordering B: only req1 applied");
      assert.equal(after.nodes.T1.title, "first-arrives",
        "ordering B: req2 hit REVISION_CONFLICT and did not write");
      assert.equal(after.log.length, 1, "ordering B: only req1 wrote");
      assert.equal(after.log[0].revision, 4);
    }
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// Forbidden imports
// ===================================================================

test("kernel.mutate: source file does not import providers/registry/adapter/bin/ui or forbidden dirs", async () => {
  const fsp = await import("node:fs/promises");
  const fpath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = fpath.dirname(fileURLToPath(import.meta.url));
  const src = await fsp.readFile(fpath.resolve(__dirname, "..", "src", "kernel", "mutate.mjs"), "utf8");
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
    "../errors.mjs",        // throwV2 for structured errors
    "../storage/state.mjs", // readState + writeState (atomic)
    "../storage/lock.mjs",          // withLock (single-mutation frontier)
    "../storage/log.mjs",           // prepareLogEntry (canonical log shape)
    "./transaction.mjs",    // createTransaction (the existing draft)
  ]);
  const allRelative = [...src.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)].map((m) => m[1]);
  for (const rel of allRelative) {
    assert.ok(allowedRelative.has(rel), `kernel/mutate.mjs imported forbidden module: ${rel}`);
  }
  for (const p of forbiddenPatterns) {
    assert.doesNotMatch(src, p, `kernel/mutate.mjs must not import forbidden module`);
  }
});
