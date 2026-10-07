import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createTempProject, readState as readStateHelper, rmTempProject, stateFilePath } from "../../helpers.ts";
import { bootstrapProject, importKernel, createTaskProvider, updateNodeProvider } from "./helpers.ts";

function assertUnchangedAfterNoop(out, state, baseMtime, finalStat) {
  assert.equal(out.idempotent, true, "no diff ⇒ idempotent");
  assert.equal(out.log_entry, null, "no log entry on idempotent op");
  assert.equal(out.effects && out.effects.hint, "noop-but-allowed", "effects pass through even when no write happens");
  assert.equal(out.diff.created.length, 0);
  assert.equal(out.diff.updated.length, 0);
  assert.equal(out.diff.added_edges.length, 0);
  assert.equal(out.diff.removed_edges.length, 0);
  assert.equal(state.nodes.T1.revision, 3, "no revision bump on idempotent op");
  assert.equal(state.log.length, 0);
  assert.equal(finalStat.mtimeMs, baseMtime, "no state file write on idempotent op");
}

function assertCreatedTask(out, finalState) {
  assert.equal(out.idempotent, false);
  assert.equal(out.diff.created.length, 1);
  assert.equal(out.diff.created[0].id, "T2");
  assert.equal(out.diff.created[0].node.revision, 4, "new node starts above the fenced state revision");
  assert.equal(out.diff.added_edges.length, 1);
  assert.deepEqual(out.diff.added_edges[0], { from: "T1", to: "T2", type: "BLOCKS" });
  assert.equal(finalState.nodes.T2.revision, 4);
  assert.equal(finalState.nodes.T2.title, "second task");
  assert.equal(finalState.nodes.T1.revision, 3, "T1 unchanged — no revision bump");
  assert.deepEqual(finalState.edges, [
    { from: "G1", to: "T1", type: "BLOCKS" },
    { from: "T1", to: "T2", type: "BLOCKS" },
  ]);
  assert.equal(finalState.log.length, 1);
  assert.equal(finalState.log[0].action, "task.create");
  assert.equal(finalState.log[0].agent, "alice");
  assert.equal(finalState.log[0].node, "T2");
  assert.equal(finalState.log[0].revision, 4);
}

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
      prepare: async () => ({
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
    const finalState = await readStateHelper(dir);
    assertCreatedTask(out, finalState);
  } finally {
    await rmTempProject(dir);
  }
});

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
    const after = await readStateHelper(dir);
    assertUnchangedAfterNoop(out, after, baseMtime, await fs.stat(stateFilePath(dir)));
  } finally {
    await rmTempProject(dir);
  }
});

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
