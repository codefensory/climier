// test/kernel-mutate-concurrency.test.mjs — concurrency contract for
// kernel.mutate. Covers the regression in
// T-graph-kernel-mutate-concurrency-fix: the previous module-level
// nestedDepth counter rejected two independent concurrent mutations on
// the same project as if they were nested. The fix uses
// AsyncLocalStorage so reentrancy is tracked per async chain; only
// direct nested calls from the same chain are still rejected.
//
// Each test uses importKernel() (= importFresh) so the AsyncLocalStorage
// instance is fresh per test, preserving the existing test reset
// contract documented in src/kernel/mutate.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createTempProject, rmTempProject, importFresh, writeState as writeStateHelper, readState as readStateHelper } from "./helpers.mjs";

async function importKernel() {
  return importFresh("./kernel/mutate.mjs");
}

// ===================================================================
// Fixture: two independent nodes in the same project
// ===================================================================

async function bootstrap(dir) {
  await writeStateHelper(dir, {
    version: 2,
    nodes: {
      T1: { id: "T1", kind: "resolvable", subkind: "task", title: "T1-title", initiative: "kernel", status: "open", revision: 3 },
      T2: { id: "T2", kind: "resolvable", subkind: "task", title: "T2-title", initiative: "kernel", status: "open", revision: 1 },
    },
    edges: [],
    initiatives: { kernel: { desc: "kernel", created_at: "2026-01-01T00:00:00.000Z" } },
    log: [],
  });
}

// updateProvider — a simple per-node title update. Different ids in the
// same bootstrap state mean two concurrent mutates on the same project
// touch disjoint nodes and should both succeed under withLock.
function updateProvider({ id, newTitle }) {
  return {
    prepare: async ({ snapshot }) => {
      const node = snapshot.nodes[id];
      return {
        target: { id, kind: node.kind, subkind: node.subkind, revision: node.revision },
        policyAction: null,
        newTitle,
      };
    },
    apply: async ({ tx, plan }) => {
      tx.updateNode(plan.target.id, { title: plan.newTitle });
      return { result: { id: plan.target.id, title: plan.newTitle }, effects: null };
    },
  };
}

// ===================================================================
// Regression: two concurrent independent mutations on the same project
// ===================================================================

test("kernel.mutate: two concurrent independent mutations on the same project both complete without INVALID_EXECUTION_CONTRACT", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    // Fire both at the same time. Each targets a different node with a
    // matching if_revision. With the old module-level nestedDepth guard,
    // the second mutate() would throw INVALID_EXECUTION_CONTRACT before
    // reaching withLock. With the AsyncLocalStorage fix, each chain has
    // its own depth=0→1 and withLock serialises the writes.
    const req1 = mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 3 } },
      provider: updateProvider({ id: "T1", newTitle: "T1-after-1" }),
    });
    const req2 = mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T2", value: 1 } },
      provider: updateProvider({ id: "T2", newTitle: "T2-after-1" }),
    });
    const settled = await Promise.allSettled([req1, req2]);

    // The core regression assertion: neither rejection may carry the
    // INVALID_EXECUTION_CONTRACT code (the old "nested" rejection was
    // indistinguishable from a real nested call). REVISION_CONFLICT
    // would still be acceptable here, but with disjoint targets and
    // matching if_revisions we expect both to fulfil.
    for (const r of settled) {
      if (r.status === "rejected") {
        assert.notEqual(
          r.reason && r.reason.code,
          "INVALID_EXECUTION_CONTRACT",
          `concurrent mutate was falsely flagged as nested: ${r.reason && r.reason.message}`,
        );
      }
    }
    assert.equal(settled[0].status, "fulfilled", "req1 (T1) must succeed");
    assert.equal(settled[1].status, "fulfilled", "req2 (T2) must succeed");

    const after = await readStateHelper(dir);
    assert.equal(after.nodes.T1.title, "T1-after-1", "T1 update persisted");
    assert.equal(after.nodes.T1.revision, 4, "T1 revision bumped once");
    assert.equal(after.nodes.T2.title, "T2-after-1", "T2 update persisted");
    assert.equal(after.nodes.T2.revision, 2, "T2 revision bumped once");
    assert.equal(after.log.length, 2, "both writes persisted in order (serialised by withLock)");
    // Both log entries carry the matching action / node / revision.
    const actions = after.log.map((e) => e.action).sort();
    assert.deepEqual(actions, ["task.update", "task.update"]);
    const nodes = after.log.map((e) => e.node).sort();
    assert.deepEqual(nodes, ["T1", "T2"]);
    const revisions = after.log.map((e) => e.revision).sort((a, b) => a - b);
    assert.deepEqual(revisions, [2, 4]);
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel.mutate: many concurrent independent mutations on the same project all complete; no nested-rejection leaks", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    // 6 disjoint nodes; each mutate targets one node. With the old
    // module-level nestedDepth guard only the first mutate would
    // actually run; the other 5 would all throw INVALID_EXECUTION_CONTRACT.
    const base = { version: 2, nodes: {}, edges: [], initiatives: { kernel: { desc: "kernel", created_at: "2026-01-01T00:00:00.000Z" } }, log: [] };
    for (let i = 0; i < 6; i += 1) {
      base.nodes[`Tn-${i}`] = { id: `Tn-${i}`, kind: "resolvable", subkind: "task", title: `Tn-${i}-orig`, initiative: "kernel", status: "open", revision: 1 };
    }
    await writeStateHelper(dir, base);

    const reqs = [];
    for (let i = 0; i < 6; i += 1) {
      const id = `Tn-${i}`;
      reqs.push(mutate({
        projectDir: dir,
        request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id, value: 1 } },
        provider: updateProvider({ id, newTitle: `${id}-after` }),
      }));
    }
    const settled = await Promise.allSettled(reqs);
    // No INVALID_EXECUTION_CONTRACT may leak from the reentrancy guard.
    for (const r of settled) {
      if (r.status === "rejected") {
        assert.notEqual(r.reason && r.reason.code, "INVALID_EXECUTION_CONTRACT",
          `concurrent mutate was falsely flagged as nested: ${r.reason && r.reason.message}`);
      }
    }
    // All six must succeed (disjoint targets, matching if_revision).
    for (let i = 0; i < 6; i += 1) {
      assert.equal(settled[i].status, "fulfilled", `req${i} must succeed`);
    }
    const after = await readStateHelper(dir);
    for (let i = 0; i < 6; i += 1) {
      assert.equal(after.nodes[`Tn-${i}`].title, `Tn-${i}-after`, `Tn-${i} update persisted`);
      assert.equal(after.nodes[`Tn-${i}`].revision, 2, `Tn-${i} revision bumped once`);
    }
    assert.equal(after.log.length, 6, "all 6 writes persisted");
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// Regression preserved: provider.apply → kernel.mutate on same chain
// still rejected (the only legitimate use of the guard)
// ===================================================================

test("kernel.mutate: provider.apply calling kernel.mutate on the same chain is rejected with INVALID_EXECUTION_CONTRACT", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    let innerCaught = null;
    // Outer mutate updates T1; inside apply we attempt a nested mutate
    // on T2. The inner call must be rejected by the same-chain guard;
    // the outer apply still completes its tx so T1 is persisted.
    await mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 3 } },
      provider: {
        prepare: async ({ snapshot }) => ({
          target: { id: "T1", kind: snapshot.nodes.T1.kind, subkind: snapshot.nodes.T1.subkind, revision: snapshot.nodes.T1.revision },
          policyAction: null,
        }),
        apply: async ({ tx }) => {
          tx.updateNode("T1", { title: "T1-outer-done" });
          try {
            await mutate({
              projectDir: dir,
              request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T2", value: 1 } },
              provider: updateProvider({ id: "T2", newTitle: "T2-inner-attempt" }),
            });
            throw new Error("inner mutate should have thrown INVALID_EXECUTION_CONTRACT");
          } catch (err) {
            innerCaught = err;
          }
          return { result: null, effects: null };
        },
      },
    });
    assert.ok(innerCaught, "inner mutate must reject");
    assert.equal(innerCaught.code, "INVALID_EXECUTION_CONTRACT", "inner rejected with INVALID_EXECUTION_CONTRACT");
    assert.match(innerCaught.message, /nested kernel\.mutate/i);
    const after = await readStateHelper(dir);
    assert.equal(after.nodes.T1.title, "T1-outer-done", "outer apply did mutate T1");
    assert.equal(after.nodes.T1.revision, 4, "T1 revision bumped once by the outer mutate");
    assert.equal(after.nodes.T2.title, "T2-title", "inner was rejected, T2 untouched");
    assert.equal(after.log.length, 1, "only the outer write reached writeState");
    assert.equal(after.log[0].node, "T1");
    assert.equal(after.log[0].revision, 4);
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// Edge: a same-chain call that bubbles up via Promise.resolve must also
// be rejected (provider.apply returning a promise that resolves into
// a chained mutate call still belongs to the same async chain).
// ===================================================================

test("kernel.mutate: same-chain nested mutate via awaited microtask is still rejected", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    let innerCaught = null;
    await mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 3 } },
      provider: {
        prepare: async ({ snapshot }) => ({
          target: { id: "T1", kind: snapshot.nodes.T1.kind, subkind: snapshot.nodes.T1.subkind, revision: snapshot.nodes.T1.revision },
          policyAction: null,
        }),
        apply: async ({ tx }) => {
          tx.updateNode("T1", { title: "T1-outer" });
          // Pause one microtask, then attempt nested mutate. Same chain.
          await Promise.resolve();
          try {
            await mutate({
              projectDir: dir,
              request: { action: "task.update", actor: "alice", input: {}, if_revision: { kind: "single", id: "T2", value: 1 } },
              provider: updateProvider({ id: "T2", newTitle: "T2-inner-micro" }),
            });
            throw new Error("nested mutate after microtask should have thrown");
          } catch (err) {
            innerCaught = err;
          }
          return { result: null, effects: null };
        },
      },
    });
    assert.ok(innerCaught, "nested mutate via microtask must reject");
    assert.equal(innerCaught.code, "INVALID_EXECUTION_CONTRACT");
    const after = await readStateHelper(dir);
    assert.equal(after.nodes.T1.title, "T1-outer");
    assert.equal(after.nodes.T2.title, "T2-title", "T2 untouched");
    assert.equal(after.log.length, 1);
  } finally {
    await rmTempProject(dir);
  }
});