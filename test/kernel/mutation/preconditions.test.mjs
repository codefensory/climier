import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createTempProject, readState as readStateHelper, rmTempProject, stateFilePath } from "../../helpers.mjs";
import { bootstrapProject, importKernel, updateNodeProvider } from "./helpers.mjs";

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
