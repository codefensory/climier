import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, readState as readStateHelper, rmTempProject } from "../../helpers.mjs";
import { bootstrapProject, importKernel, updateNodeProvider } from "./helpers.mjs";

function policyFields(state) {
  return {
    version: state.version,
    revision: state.revision,
    nodes: state.nodes,
    edges: state.edges,
    initiatives: state.initiatives,
    log: state.log,
    plugins: state.plugins,
  };
}

function addPluginFixture(state) {
  state.plugins = { fixture: { preserved: true } };
}

function assertPolicyDenied(error, decidedWith, state, base) {
  assert.ok(error, "deny should throw");
  assert.equal(error.code, "POLICY_DENIED");
  assert.equal(error.details.action, "task.update");
  assert.equal(error.details.reason, "too risky");
  assert.equal(error.details.policy_id, "policy-fixture");
  assert.ok(decidedWith, "decide was called");
  assert.equal(decidedWith.action, "task.update");
  assert.equal(decidedWith.target.id, "T1");
  assert.deepEqual(state.nodes.T1, base.nodes.T1, "no mutation after deny");
  assert.equal(state.log.length, 0);
}

function assertSemanticSnapshot(snapshot, expectedRevision, expectedFields) {
  assert.equal(Object.hasOwn(snapshot, "fence_generation"), false, "policy must not see the internal fence");
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.revision, expectedRevision, "policy sees the current semantic snapshot revision");
  assert.deepEqual(snapshot, expectedFields, "projection preserves every other semantic field");
}

async function setupFencedPolicyProject(dir, mutate, readFencedState) {
  await bootstrapProject(dir, addPluginFixture);
  await mutate({
    projectDir: dir,
    request: { action: "task.update", actor: "alice", input: {} },
    provider: updateNodeProvider({ id: "T1", newTitle: "fenced v5 baseline" }).provider,
  });
  const initial = await readFencedState(dir);
  assert.equal(initial.version, 1, "test policy uses a canonical fixture");
  return initial;
}

function capturePolicySnapshots(snapshots) {
  let applyCount = 0;
  const policyAction = {
    decide: async ({ snapshot }) => {
      snapshots.push(snapshot);
      return { decision: "allow" };
    },
  };
  const provider = {
    prepare: async ({ snapshot }) => ({
      target: { id: "T1", kind: snapshot.nodes.T1.kind, subkind: snapshot.nodes.T1.subkind },
    }),
    apply: async ({ tx }) => {
      applyCount += 1;
      tx.updateNode("T1", { title: `policy snapshot fenced ${applyCount}` });
      return { result: null };
    },
  };
  return { policyAction, provider };
}

async function runSingleAndBatchPolicyMutation({ dir, mutate, readFencedState, provider, policyAction }) {
  await mutate({
    projectDir: dir,
    request: { action: "task.update", actor: "alice", input: {} },
    provider,
    policyAction,
  });
  const beforeBatch = await readFencedState(dir);
  await mutate({
    projectDir: dir,
    request: {
      action: "core.batch",
      actor: "alice",
      input: { operations: [{ op: "task.update", input: { id: "T1" } }] },
    },
    batch: { registry: { lookup: () => provider } },
    policyAction,
  });
  return beforeBatch;
}

function assertPolicySnapshots(snapshots, initial, beforeBatch) {
  assert.equal(snapshots.length, 2, "single and batch both reach policy");
  for (const [index, snapshot] of snapshots.entries()) {
    const expected = { ...(index === 0 ? policyFields(initial) : beforeBatch) };
    delete expected.fence_generation;
    assertSemanticSnapshot(snapshot, index === 0 ? initial.revision : beforeBatch.revision, expected);
  }
}

function assertPersistedPolicyState(persisted, initial) {
  assert.equal(persisted.version, 1);
  assert.equal(persisted.fence_generation, initial.fence_generation, "persisted state retains its fence generation");
  assert.equal(persisted.revision, initial.revision + 2);
  assert.deepEqual(persisted.plugins, initial.plugins);
}

function assertConcurrentOutcome(state) {
  if (state.nodes.T1.revision === 5) {
    assert.equal(state.nodes.T1.title, "second-arrives", "ordering A: req1 then req2");
    assert.equal(state.log.length, 2, "ordering A: both writes persisted");
    assert.deepEqual(state.log.map((entry) => entry.revision), [4, 5], "logs carry matching post-bump revisions");
  } else {
    assert.equal(state.nodes.T1.revision, 4, "ordering B: only req1 applied");
    assert.equal(state.nodes.T1.title, "first-arrives", "ordering B: req2 conflicted");
    assert.equal(state.log.length, 1, "ordering B: only req1 wrote");
    assert.equal(state.log[0].revision, 4);
  }
}

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
      decide: async ({ target, action }) => {
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
    assertPolicyDenied(caught, decidedWith, await readStateHelper(dir), base);
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
      prepare: async () => ({ target: { id: "T1", kind: "resolvable", subkind: "task" } }),
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

test("kernel.mutate: policy receives fenced semantic snapshots without fence_generation for single and batch", async () => {
  const { mutate } = await importKernel();
  const { readFencedState } = await import("../../../src/storage/ledger.mjs");
  const dir = await createTempProject();
  try {
    const initial = await setupFencedPolicyProject(dir, mutate, readFencedState);
    const snapshots = [];
    const { policyAction, provider } = capturePolicySnapshots(snapshots);
    const beforeBatch = await runSingleAndBatchPolicyMutation({ dir, mutate, readFencedState, provider, policyAction });
    assertPolicySnapshots(snapshots, initial, beforeBatch);
    const persisted = await readFencedState(dir);
    assertPersistedPolicyState(persisted, initial);
  } finally {
    await rmTempProject(dir);
  }
});

// Idempotency (no diff ⇒ no write, no log)

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
    assertConcurrentOutcome(after);
  } finally {
    await rmTempProject(dir);
  }
});
