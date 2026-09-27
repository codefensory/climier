import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, readState as readStateHelper, rmTempProject } from "../../helpers.mjs";
import { bootstrapProject, importKernel, createTaskProvider, updateNodeProvider } from "./helpers.mjs";

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
