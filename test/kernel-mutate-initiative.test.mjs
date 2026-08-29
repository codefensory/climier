// test/kernel-mutate-initiative.test.mjs — initiative persistence through
// the single kernel.mutate frontier.
//
// Scope (B1b extension, task T-graph-kernel-core-transaction):
//   - A provider that creates an initiative through tx.createInitiative
//     persists it via the same writeState call (no separate updateState).
//   - Idempotency considers initiatives (an apply that touches only
//     initiatives and produces no diff must NOT log and MUST NOT bump
//     node revisions).
//   - Changing initiatives MUST NOT bump node.revision.
//   - A mutation that combines a node change and an initiative change
//     persists both in a single writeState; one log entry covers both.
//   - The on-disk state shape stays v2 (nodes, edges, initiatives, log).

import { test } from "node:test";
import assert from "node:assert/strict";

import { createTempProject, rmTempProject, importFresh, readState as readStateHelper, writeState as writeStateHelper } from "./helpers.mjs";

async function importKernel() {
  return importFresh("./kernel/mutate.mjs");
}

function createInitiativeProvider({ name, desc = "", created_at }) {
  return {
    prepare: async ({ snapshot }) => ({
      target: { id: name, kind: "initiative" },
      policyAction: null,
      initiative: { name, desc, created_at },
    }),
    apply: async ({ tx, plan }) => {
      const init = {
        name: plan.initiative.name,
        desc: plan.initiative.desc,
      };
      if (plan.initiative.created_at) init.created_at = plan.initiative.created_at;
      tx.createInitiative(init);
      return { result: { name: plan.initiative.name, desc: plan.initiative.desc }, effects: null };
    },
  };
}

function bootstrap(dir, mutate) {
  const base = {
    version: 2,
    nodes: {
      T1: {
        id: "T1",
        kind: "resolvable",
        subkind: "task",
        title: "T1",
        initiative: "kernel",
        status: "open",
        revision: 3,
      },
    },
    edges: [],
    initiatives: { kernel: { desc: "kernel initiative", created_at: "2026-01-01T00:00:00.000Z" } },
    log: [],
  };
  if (typeof mutate === "function") mutate(base);
  return writeStateHelper(dir, base);
}

// ===================================================================
// Acceptance: kernel.mutate persists initiatives via the same writeState
// ===================================================================

test("kernel.mutate: createInitiative persists in the same writeState (no second updateState)", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const provider = createInitiativeProvider({ name: "auth", desc: "auth migration", created_at: "2026-02-02T02:02:02.000Z" });
    const out = await mutate({
      projectDir: dir,
      request: { action: "initiative.create", actor: "alice", input: { name: "auth" } },
      provider,
    });
    assert.equal(out.idempotent, false);
    assert.ok(out.diff.initiatives, "diff.initiatives must be present");
    assert.equal(out.diff.initiatives.created.length, 1);
    assert.equal(out.diff.initiatives.created[0].name, "auth");
    assert.equal(out.diff.initiatives.updated.length, 0);
    // No node-level diff: only the initiative was created.
    assert.equal(out.diff.created.length, 0);
    assert.equal(out.diff.updated.length, 0);

    // On-disk state must contain the new initiative + the original one.
    const after = await readStateHelper(dir);
    assert.deepEqual(after.initiatives, {
      kernel: { desc: "kernel initiative", created_at: "2026-01-01T00:00:00.000Z" },
      auth: { desc: "auth migration", created_at: "2026-02-02T02:02:02.000Z" },
    });
    // Exactly one log entry (state + log in one write).
    assert.equal(after.log.length, 1);
    assert.equal(after.log[0].action, "initiative.create");
    assert.equal(after.log[0].node, "auth", "plan.target.id surfaces as the log node");
    // T1 revision unchanged — creating an initiative does NOT bump node.revision.
    assert.equal(after.nodes.T1.revision, 3);
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// Acceptance: changing initiatives does NOT bump node.revision
// ===================================================================

test("kernel.mutate: creating an initiative alone does not bump any node revision", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrap(dir, (s) => {
      s.nodes.T2 = { id: "T2", kind: "resolvable", subkind: "task", title: "T2", initiative: "kernel", status: "open", revision: 7 };
    });
    const provider = createInitiativeProvider({ name: "qa", desc: "qa flow" });
    const out = await mutate({
      projectDir: dir,
      request: { action: "initiative.create", actor: "alice", input: {} },
      provider,
    });
    assert.equal(out.idempotent, false);
    const after = await readStateHelper(dir);
    assert.equal(after.nodes.T1.revision, 3, "T1 revision unchanged");
    assert.equal(after.nodes.T2.revision, 7, "T2 revision unchanged");
    assert.equal(out.diff.created.length, 0);
    assert.equal(out.diff.updated.length, 0);
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// Acceptance: idempotency considers initiatives
// ===================================================================

test("kernel.mutate: idempotent provider (no draft change ⇒ no write, no log, no revision bump)", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const provider = {
      prepare: async ({ snapshot }) => ({
        target: { id: "noop", kind: "initiative" },
        policyAction: null,
      }),
      apply: async () => {
        // No-op: the draft mirrors the snapshot exactly, so the diff is
        // empty. Kernel must skip the write and the log entry.
        return { result: null, effects: { hint: "noop-but-allowed" } };
      },
    };
    const out = await mutate({
      projectDir: dir,
      request: { action: "initiative.create", actor: "alice", input: {} },
      provider,
    });
    assert.equal(out.idempotent, true, "no draft change ⇒ idempotent");
    assert.equal(out.log_entry, null, "no log entry on idempotent op");
    assert.deepEqual(out.diff.initiatives, { created: [], updated: [] });
    const after = await readStateHelper(dir);
    // State file untouched: log has 0 entries, no extra initiative, T1 revision unchanged.
    assert.equal(after.log.length, 0);
    assert.equal(Object.keys(after.initiatives).length, 1);
    assert.equal(after.nodes.T1.revision, 3);
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// Acceptance: node + initiative changes in the same apply persist together
// ===================================================================

test("kernel.mutate: combined node + initiative mutation persists both in one writeState", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const provider = {
      prepare: async ({ snapshot }) => ({
        target: { id: "T1", kind: "resolvable", subkind: "task" },
        policyAction: null,
      }),
      apply: async ({ tx }) => {
        tx.updateNode("T1", { title: "renamed-in-same-apply" });
        tx.createInitiative({ name: "auth", desc: "auth migration" });
        return { result: { id: "T1" }, effects: null };
      },
    };
    const out = await mutate({
      projectDir: dir,
      request: { action: "task.update+initiative.create", actor: "alice", input: {}, if_revision: { kind: "single", id: "T1", value: 3 } },
      provider,
    });
    assert.equal(out.idempotent, false);
    assert.equal(out.diff.updated.length, 1);
    assert.equal(out.diff.updated[0].id, "T1");
    assert.equal(out.diff.updated[0].node.title, "renamed-in-same-apply");
    assert.equal(out.diff.initiatives.created.length, 1);
    assert.equal(out.diff.initiatives.created[0].name, "auth");

    const after = await readStateHelper(dir);
    // Node bumped (T1 was updated).
    assert.equal(after.nodes.T1.revision, 4);
    assert.equal(after.nodes.T1.title, "renamed-in-same-apply");
    // Initiative persisted.
    assert.deepEqual(after.initiatives.auth, { desc: "auth migration" });
    // Single log entry.
    assert.equal(after.log.length, 1);
    assert.equal(after.log[0].action, "task.update+initiative.create");
    assert.equal(after.log[0].node, "T1");
    assert.equal(after.log[0].revision, 4);
    assert.ok(after.log[0].initiatives, "log entry should mention initiative changes");
    assert.deepEqual(after.log[0].initiatives.created, ["auth"]);
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// Negative: provider fails inside apply ⇒ no initiatives persisted
// ===================================================================

test("kernel.mutate: apply throws after creating an initiative in the draft ⇒ nothing persisted", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const base = await readStateHelper(dir);
    const provider = {
      prepare: async ({ snapshot }) => ({
        target: { id: "T1", kind: "resolvable", subkind: "task" },
        policyAction: null,
      }),
      apply: async ({ tx }) => {
        tx.updateNode("T1", { title: "should-not-stick" });
        tx.createInitiative({ name: "ghost", desc: "should-not-stick" });
        const err = new Error("boom in apply");
        err.code = "PROVIDER_APPLY_FAILED";
        throw err;
      },
    };
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: { action: "task.update+initiative.create", actor: "alice", input: {} },
        provider,
      });
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.code, "PROVIDER_APPLY_FAILED");

    const after = await readStateHelper(dir);
    assert.deepEqual(after, base, "no partial mutation (node or initiative) on apply failure");
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// Isolation: existing tests' invariant still holds (T1 unchanged when
// an unrelated initiative is created).
// ===================================================================

test("kernel.mutate: snapshot's initiatives map is preserved when only a new one is added", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const provider = createInitiativeProvider({ name: "new-one", desc: "new" });
    await mutate({
      projectDir: dir,
      request: { action: "initiative.create", actor: "alice", input: {} },
      provider,
    });
    const after = await readStateHelper(dir);
    assert.deepEqual(after.initiatives.kernel, { desc: "kernel initiative", created_at: "2026-01-01T00:00:00.000Z" });
    assert.deepEqual(after.initiatives["new-one"], { desc: "new" });
  } finally {
    await rmTempProject(dir);
  }
});
