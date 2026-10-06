import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createTempProject, readState as readStateHelper, rmTempProject, stateFilePath, writeCanonicalState, importFresh } from "../../helpers.mjs";
import { bootstrapProject, importKernel, updateNodeProvider } from "./helpers.mjs";
import { withLock } from "../../../src/storage/lock.ts";

type TestError = { code: string; message: string; details: Record<string, unknown> };
type FencedState = { version: number; fence_generation: number; revision: number; nodes: Record<string, { title?: string; revision?: number }>; log: Array<{ action: string }> };

// failingPrepareProvider — prepare throws a structured error.
function assertBootstrapPolicyResult(result, state, exists) {
  assert.equal(result.result.name, "new-project");
  assert.equal(exists, true);
  assert.equal(state.version, 1);
  assert.equal(state.fence_generation, 1);
  assert.equal(state.initiatives["new-project"] !== undefined, true);
  assert.equal(state.log.length, 1);
  assert.equal(state.log[0].action, "initiative.create");
}

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
    prepare: async () => ({
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
    const { withLock: freshWithLock } = await importFresh("./storage/lock.ts");
    await freshWithLock(dir, async () => { lockObserved = true; });
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

// Plugin attribution / log shape

async function mutateCanonicalState(dir, mutate, provider) {
  await writeCanonicalState(dir, {
    version: 1,
    revision: 2,
    nodes: { T1: { id: "T1", kind: "resolvable", subkind: "task", title: "before", status: "open", revision: 2 } },
    edges: [],
    initiatives: {},
    log: [],
  });
  await mutate({
    projectDir: dir,
    request: { action: "task.update", actor: "alice", input: { id: "T1" }, if_state_revision: 3 },
    provider,
  });
}

function assertCanonicalState(state, expectedFenceGeneration, expectedRevision, expectedTitle) {
  assert.equal(state.version, 1);
  assert.equal(state.fence_generation, expectedFenceGeneration);
  assert.equal(state.revision, expectedRevision);
  assert.equal(state.nodes.T1.revision, expectedRevision);
  assert.equal(state.nodes.T1.title, expectedTitle);
}

test("kernel mutation writes provider changes through the ledger commit over a canonical state", async () => {
  const { mutate } = await importKernel();
  const { readFencedState, bootstrapFencedState } = await import("../../../src/storage/ledger.ts");
  const dir = await createTempProject();
  try {
    const { provider } = updateNodeProvider({ id: "T1", newTitle: "fenced provider" });
    await mutateCanonicalState(dir, mutate, provider);
    const state = await readFencedState(dir);
    assertCanonicalState(state, 1, 4, "fenced provider");

    const secondDir = await createTempProject();
    try {
      await bootstrapProject(secondDir);
      const fenced = await bootstrapFencedState(secondDir) as FencedState;
      const nextProvider = updateNodeProvider({ id: "T1", newTitle: "fenced again" }).provider;
      await mutate({
        projectDir: secondDir,
        request: { action: "task.update", actor: "alice", input: { id: "T1" }, if_state_revision: fenced.revision },
        provider: nextProvider,
      });
      const next = await readFencedState(secondDir);
      assertCanonicalState(next, fenced.fence_generation, fenced.revision + 1, "fenced again");
    } finally {
      await rmTempProject(secondDir);
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel.mutate recovers a pending fenced commit before checking caller CAS", async () => {
  const { mutate } = await importKernel();
  const { readFencedState, commitFencedStateUnderLock } = await import("../../../src/storage/ledger.ts");
  const dir = await createTempProject();
  try {
    const current = await bootstrapProject(dir);
    const candidate = {
      ...current,
      nodes: { ...current.nodes, T1: { ...current.nodes.T1, title: "recovered pending", revision: current.revision + 1 } },
      revision: current.revision + 1,
      log: [...current.log, { action: "test.recovery", revision: current.revision + 1 }],
    };
    await assert.rejects(
      withLock(dir, (lockContext) => commitFencedStateUnderLock(lockContext, candidate, { faultAt: "after-pending" })),
      /injected failure/,
    );

    let preparedRevision = null;
    let policyCalled = false;
    await assert.rejects(mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: { id: "T1" }, if_state_revision: current.revision },
      provider: {
        prepare: async ({ snapshot }) => {
          preparedRevision = snapshot.revision;
          return { target: { id: "T1", kind: "resolvable", subkind: "task" }, newTitle: "should not apply" };
        },
        apply: async () => assert.fail("stale CAS must prevent apply"),
      },
      policyAction: { decide: async () => { policyCalled = true; return { decision: "allow" }; } },
    }), (error) => (error as TestError).code === "STATE_REVISION_CONFLICT");

    assert.equal(preparedRevision, current.revision + 1, "provider sees the recovered commit candidate before CAS");
    assert.equal(policyCalled, false, "CAS is checked before policy");
    const recovered = await readFencedState(dir) as FencedState;
    assert.equal(recovered.nodes.T1.title, "recovered pending");
    assert.equal(recovered.revision, current.revision + 1);
    const last = recovered.log.at(-1);
    assert.ok(last);
    assert.equal(last.action, "test.recovery");
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel.mutate bootstraps a missing project only after provider policy allows", async () => {
  const { mutate } = await importKernel();
  const { stateExists } = await import("../../helpers.mjs");
  const { ledgerFile } = await import("../../../src/storage/ledger.ts");
  const dir = await createTempProject();
  try {
    const { initiativeCreateProvider } = await import("../../../src/providers/core/initiative.ts");
    const result = await mutate({
      projectDir: dir,
      request: { action: "initiative.create", actor: "alice", input: { name: "new-project" } },
      provider: initiativeCreateProvider,
      policyAction: { decide: async () => ({ decision: "allow" }) },
    });
    const { readFencedState } = await import("../../../src/storage/ledger.ts");
    const state = await readFencedState(dir);
    assertBootstrapPolicyResult(result, state, await stateExists(dir));

    const deniedDir = await createTempProject();
    try {
      await assert.rejects(mutate({
        projectDir: deniedDir,
        request: { action: "initiative.create", actor: "alice", input: { name: "denied" } },
        provider: initiativeCreateProvider,
        policyAction: { decide: async () => ({ decision: "deny", reason: "no" }) },
      }), (error) => (error as TestError).code === "POLICY_DENIED");
      assert.equal(await stateExists(deniedDir), false);
      await assert.rejects(fs.access(ledgerFile(deniedDir)), { code: "ENOENT" });
      await assert.rejects(fs.access(stateFilePath(deniedDir)), { code: "ENOENT" });
    } finally {
      await rmTempProject(deniedDir);
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("direct mutation executor requires the active lock capability supplied by mutate", async () => {
  const { executeMutation } = await importFresh("./kernel/mutation/execute.ts");
  const { withLock: withActiveLock } = await import("../../../src/storage/lock.ts");
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, {
      version: 1,
      revision: 3,
      nodes: { T1: { id: "T1", kind: "resolvable", subkind: "task", title: "before", status: "open", revision: 2 } },
      edges: [],
      initiatives: {},
      log: [],
    });
    await withActiveLock(dir, async (lockContext) => {
      const mutation = await executeMutation({
        projectDir: dir,
        lockContext,
        request: { action: "test.update", actor: "alice", input: {} },
        provider: {
          prepare: async ({ snapshot }) => ({
            target: { id: "T1", kind: snapshot.nodes.T1.kind, subkind: snapshot.nodes.T1.subkind },
            newTitle: "after",
          }),
          apply: async ({ tx, plan }) => {
            tx.updateNode(plan.target.id, { title: plan.newTitle });
            return { result: { ok: true } };
          },
        },
      });
      assert.equal(mutation.result.ok, true);
    });
    const after = await readStateHelper(dir);
    assert.equal(after.version, 1);
    assert.equal(after.revision, 5);
    assert.equal(after.nodes.T1.revision, 5);
    assert.equal(after.nodes.T1.title, "after");
  } finally {
    await rmTempProject(dir);
  }
});

// Forbidden imports
