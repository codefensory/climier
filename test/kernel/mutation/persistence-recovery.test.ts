import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, readState as readStateHelper, rmTempProject } from "../../helpers.ts";
import { bootstrapProject, importKernel, updateNodeProvider } from "./helpers.ts";

type TestError = { code: string; message: string; details: Record<string, unknown> };
type State = { version: number; revision: number; nodes: Record<string, { title?: string; revision?: number }>; log: Array<{ action: string; revision?: number }> };

function assertBootstrapPolicyResult(result, state, exists) {
  assert.equal(result.result.name, "new-project");
  assert.equal(exists, true);
  assert.equal(state.version, 1);
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

function failingApplyProvider(message = "boom in apply") {
  return {
    prepare: async () => ({ target: { id: "T-apply-fail", kind: "resolvable", subkind: "task" }, newTitle: "x" }),
    apply: async () => {
      const err = new Error(message);
      err.code = "PROVIDER_APPLY_FAILED";
      throw err;
    },
  };
}

test("kernel.mutate: provider.prepare throws without changing state", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    const base = await bootstrapProject(dir);
    let caught;
    try {
      await mutate({ projectDir: dir, request: { action: "task.create", actor: "alice", input: {} }, provider: failingPrepareProvider("domain rule violated") });
    } catch (err) { caught = err; }
    assert.equal((caught as TestError).code, "INVALID_PROVIDER");
    const after = await readStateHelper(dir);
    assert.deepEqual(after.nodes, base.nodes);
    assert.equal(after.log.length, 0);
  } finally { await rmTempProject(dir); }
});

test("kernel.mutate: provider.apply throws without persisting its draft", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    const base = await bootstrapProject(dir);
    let caught;
    try {
      await mutate({ projectDir: dir, request: { action: "task.create", actor: "alice", input: {} }, provider: failingApplyProvider("boom in apply") });
    } catch (err) { caught = err; }
    assert.equal((caught as TestError).code, "PROVIDER_APPLY_FAILED");
    const after = await readStateHelper(dir);
    assert.deepEqual(after.nodes, base.nodes);
    assert.equal(after.log.length, 0);
  } finally { await rmTempProject(dir); }
});

test("kernel.mutate: node, log, and revision are committed together", async () => {
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
    const persisted = await readStateHelper(dir) as State;
    assert.equal(persisted.nodes.T1.title, "atomic-final");
    assert.equal(persisted.nodes.T1.revision, 4);
    assert.equal(persisted.revision, 4);
    assert.equal(persisted.log.length, baseLog + 1);
    assert.equal(persisted.log.at(-1)?.action, "task.update");
    assert.equal(persisted.log.at(-1)?.revision, 4);
  } finally { await rmTempProject(dir); }
});

test("kernel.mutate: a rejected call leaves the logical SQLite snapshot unchanged", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    const base = await bootstrapProject(dir);
    const before = await readStateHelper(dir);
    await assert.rejects(mutate({
      projectDir: dir,
      request: { action: "task.create", actor: "alice", input: {} },
      provider: failingPrepareProvider("domain rule"),
    }), { code: "INVALID_PROVIDER" });
    assert.deepEqual(await readStateHelper(dir), before);
    assert.deepEqual((await readStateHelper(dir)).nodes, base.nodes);
  } finally { await rmTempProject(dir); }
});

test("kernel.mutate bootstraps a missing project only after provider policy allows", async () => {
  const { mutate } = await importKernel();
  const { stateExists } = await import("../../helpers.ts");
  const dir = await createTempProject();
  try {
    const { initiativeCreateProvider } = await import("../../../src/providers/core/initiative.ts");
    const result = await mutate({
      projectDir: dir,
      request: { action: "initiative.create", actor: "alice", input: { name: "new-project" } },
      provider: initiativeCreateProvider,
      policyAction: { decide: async () => ({ decision: "allow" }) },
    });
    const state = await readStateHelper(dir);
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
    } finally { await rmTempProject(deniedDir); }
  } finally { await rmTempProject(dir); }
});
