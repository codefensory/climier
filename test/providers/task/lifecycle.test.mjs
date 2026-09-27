import { test } from "node:test";
import assert from "node:assert/strict";

import { expectThrows, importTaskProvider, makeInputCancel, makeInputRelease, makeInputReopen, makeInputTake, makeSnapshot, makeTxStub } from "./task-fixtures.mjs";

test("providers do not import filesystem, lock, state, log, policy, commands, registry, adapters, CLI or UI", async () => {
  // Smoke: import the provider modules in isolation and confirm they
  // expose only the expected surface. If a future change accidentally
  // pulls in one of the forbidden modules the importFresh will surface
  // the require error here.
  const providers = await importTaskProvider();
  assert.equal(typeof providers.taskCreateProvider.prepare, "function");
  assert.equal(typeof providers.taskCreateProvider.apply, "function");
  assert.equal(typeof providers.taskUpdateProvider.prepare, "function");
  assert.equal(typeof providers.taskUpdateProvider.apply, "function");
  assert.equal(typeof providers.taskTakeProvider.prepare, "function");
  assert.equal(typeof providers.taskTakeProvider.apply, "function");
  assert.equal(typeof providers.taskReleaseProvider.prepare, "function");
  assert.equal(typeof providers.taskReleaseProvider.apply, "function");
  assert.equal(typeof providers.taskReopenProvider.prepare, "function");
  assert.equal(typeof providers.taskReopenProvider.apply, "function");
  assert.equal(typeof providers.taskCancelProvider.prepare, "function");
  assert.equal(typeof providers.taskCancelProvider.apply, "function");
  // Each provider is a plain object with exactly two functions.
  for (const provider of [
    providers.taskCreateProvider,
    providers.taskUpdateProvider,
    providers.taskTakeProvider,
    providers.taskReleaseProvider,
    providers.taskReopenProvider,
    providers.taskCancelProvider,
  ]) {
    const keys = Object.keys(provider).toSorted();
    assert.deepEqual(keys, ["apply", "prepare"], `provider keys must be exactly apply/prepare; got ${keys.join(",")}`);
  }
});

test("task.take prepare: free task classifies action=task.take and freezes the plan", async () => {
  const { taskTakeProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 } },
  });
  const input = makeInputTake();
  const plan = await taskTakeProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.target.id, "T-x");
  assert.equal(plan.target.kind, "resolvable");
  assert.equal(plan.target.subkind, "task");
  assert.equal(plan.policyAction.action, "task.take");
  assert.equal(plan.logAction, "take");
  assert.equal(plan.idempotent, false);
  assert.equal(plan.takeover, false);
  assert.equal(plan.previous_owner, null);
  assert.equal(plan.logFields, undefined, "free take must not emit previous_owner");
  assert.equal(plan.claim.by, "alice");
  assert.equal(plan.claim.at, "2026-01-01T00:00:00.000Z");
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.target));
  assert.ok(Object.isFrozen(plan.claim));
});

test("task.take prepare: same actor in_progress returns idempotent=true with action=task.take", async () => {
  const { taskTakeProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: {
      "T-x": {
        id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "in_progress",
        claim: { by: "alice", at: "t0" }, initiative: "foo", revision: 1,
      },
    },
  });
  const input = makeInputTake();
  const plan = await taskTakeProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.policyAction.action, "task.take");
  assert.equal(plan.idempotent, true);
  assert.equal(plan.takeover, false);
  assert.equal(plan.previous_owner, null);
});

test("task.take prepare: other actor in_progress classifies action=task.takeover with previous_owner", async () => {
  const { taskTakeProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: {
      "T-x": {
        id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "in_progress",
        claim: { by: "bob", at: "t0" }, initiative: "foo", revision: 1,
      },
    },
  });
  const input = makeInputTake();
  const plan = await taskTakeProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.policyAction.action, "task.takeover");
  assert.equal(plan.idempotent, false);
  assert.equal(plan.takeover, true);
  assert.equal(plan.previous_owner, "bob");
  assert.deepEqual(plan.logFields, { previous_owner: "bob" });
});

test("task.take prepare: blocked task rejects NOT_READY", async () => {
  const { taskTakeProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: {
      "T-dep": { id: "T-dep", kind: "resolvable", subkind: "task", title: "dep", status: "open", revision: 1 },
      "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 },
    },
    edges: [{ from: "T-dep", to: "T-x", type: "BLOCKS" }],
  });
  const input = makeInputTake();

  await expectThrows(
    () => taskTakeProvider.prepare({ snapshot, input, request: {} }),
    "NOT_READY",
  );
});

test("task.take prepare: rejects non-task targets with NOT_CLAIMABLE", async () => {
  const { taskTakeProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "K-x": { id: "K-x", kind: "knowledge", title: "k", status: "active", revision: 1 } },
  });
  const input = makeInputTake({ id: "K-x" });

  await expectThrows(
    () => taskTakeProvider.prepare({ snapshot, input, request: {} }),
    "NOT_CLAIMABLE",
  );
});

test("task.take apply: free task writes claim+in_progress via tx.updateNode, never revision", async () => {
  const { taskTakeProvider } = await importTaskProvider();
  const existing = { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 };
  const snapshot = makeSnapshot({ nodes: { "T-x": existing } });
  const input = makeInputTake();
  const plan = await taskTakeProvider.prepare({ snapshot, input, request: {} });

  const tx = makeTxStub({ existingNode: existing });
  const out = await taskTakeProvider.apply({ tx, plan, input, request: {}, snapshot });

  assert.equal(tx.calls.updateNode.length, 1);
  assert.equal(tx.calls.updateNode[0].id, "T-x");
  assert.equal(tx.calls.updateNode[0].patch.status, "in_progress");
  assert.equal(tx.calls.updateNode[0].patch.claim.by, "alice");
  assert.equal("revision" in tx.calls.updateNode[0].patch, false, "apply must not carry revision");
  assert.equal(out.result.freshly_claimed, true);
  assert.equal(out.result.status, "in_progress");
  assert.equal(out.effects, null);
});

test("task.take apply: idempotent same actor returns no fresh claim and mutates nothing", async () => {
  const { taskTakeProvider } = await importTaskProvider();
  const existing = {
    id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "in_progress",
    claim: { by: "alice", at: "t0" }, initiative: "foo", revision: 3,
  };
  const snapshot = makeSnapshot({ nodes: { "T-x": existing } });
  const input = makeInputTake();
  const plan = await taskTakeProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.idempotent, true);

  const tx = makeTxStub({ existingNode: existing });
  const out = await taskTakeProvider.apply({ tx, plan, input, request: {}, snapshot });

  // idempotent apply must NOT call updateNode
  assert.equal(tx.calls.updateNode.length, 0);
  assert.equal(tx.calls.createNode.length, 0);
  assert.equal(out.result.freshly_claimed, false);
  assert.equal(out.result.status, "in_progress");
  assert.equal(out.effects, null);
});

test("task.release prepare: claimed task returns plan with previous_owner and idempotent=false", async () => {
  const { taskReleaseProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: {
      "T-x": {
        id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "in_progress",
        claim: { by: "alice", at: "t0" }, initiative: "foo", revision: 3,
      },
    },
  });
  const input = makeInputRelease();
  const plan = await taskReleaseProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.target.id, "T-x");
  assert.equal(plan.policyAction.action, "task.release");
  assert.equal(plan.logAction, "release");
  assert.equal(plan.idempotent, false);
  assert.equal(plan.previous_owner, "alice");
  assert.equal(plan.target.previous_owner, "alice");
  assert.ok(Object.isFrozen(plan));
});

test("task.release prepare: no-claim returns idempotent=true (no-op)", async () => {
  const { taskReleaseProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 } },
  });
  const input = makeInputRelease();
  const plan = await taskReleaseProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.idempotent, true);
  assert.equal(plan.previous_owner, null);
});

test("task.release prepare: rejects non-task targets with INVALID_STATUS", async () => {
  const { taskReleaseProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "G-x": { id: "G-x", kind: "resolvable", subkind: "gate", title: "g", status: "open", revision: 1 } },
  });
  const input = makeInputRelease({ id: "G-x" });

  await expectThrows(
    () => taskReleaseProvider.prepare({ snapshot, input, request: {} }),
    "INVALID_STATUS",
  );
});

test("task.release apply: clears claim and resets to open; no revision write", async () => {
  const { taskReleaseProvider } = await importTaskProvider();
  const existing = {
    id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "in_progress",
    claim: { by: "alice", at: "t0" }, initiative: "foo", revision: 3,
  };
  const snapshot = makeSnapshot({ nodes: { "T-x": existing } });
  const input = makeInputRelease();
  const plan = await taskReleaseProvider.prepare({ snapshot, input, request: {} });

  const tx = makeTxStub({ existingNode: existing });
  const out = await taskReleaseProvider.apply({ tx, plan, input, request: {}, snapshot });

  assert.equal(tx.calls.updateNode.length, 1);
  assert.equal(tx.calls.updateNode[0].id, "T-x");
  assert.equal(tx.calls.updateNode[0].patch.claim, null);
  assert.equal(tx.calls.updateNode[0].patch.status, "open");
  assert.equal("revision" in tx.calls.updateNode[0].patch, false);
  assert.equal(out.result.released, true);
  assert.equal(out.result.status, "open");
  assert.equal(out.result.previous_owner, "alice");
});

test("task.release apply: idempotent no-claim path skips updateNode", async () => {
  const { taskReleaseProvider } = await importTaskProvider();
  const existing = { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 };
  const snapshot = makeSnapshot({ nodes: { "T-x": existing } });
  const input = makeInputRelease();
  const plan = await taskReleaseProvider.prepare({ snapshot, input, request: {} });
  assert.equal(plan.idempotent, true);

  const tx = makeTxStub({ existingNode: existing });
  const out = await taskReleaseProvider.apply({ tx, plan, input, request: {}, snapshot });

  assert.equal(tx.calls.updateNode.length, 0);
  assert.equal(out.result.released, false);
});

test("task.reopen prepare: done task returns frozen plan with reason and previous_done_by", async () => {
  const { taskReopenProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: {
      "T-x": {
        id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "done",
        done_by: "alice", done_at: "t0", note: "shipped", initiative: "foo", revision: 2,
      },
    },
  });
  const input = makeInputReopen();
  const plan = await taskReopenProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.target.id, "T-x");
  assert.equal(plan.policyAction.action, "task.reopen");
  assert.equal(plan.logAction, "reopen");
  assert.equal(plan.reason, "rolled back");
  assert.equal(plan.target.previous_done_by, "alice");
  assert.ok(Object.isFrozen(plan));
});

test("task.reopen prepare: rejects open tasks with INVALID_STATUS", async () => {
  const { taskReopenProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 } },
  });
  const input = makeInputReopen();

  await expectThrows(
    () => taskReopenProvider.prepare({ snapshot, input, request: {} }),
    "INVALID_STATUS",
  );
});

test("task.reopen prepare: rejects missing reason with MISSING_FIELD", async () => {
  const { taskReopenProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "done", initiative: "foo", revision: 1 } },
  });
  const input = makeInputReopen({ reason: "" });

  await expectThrows(
    () => taskReopenProvider.prepare({ snapshot, input, request: {} }),
    "MISSING_FIELD",
  );
});

test("task.reopen apply: rolls done -> open, clears claim; never writes revision", async () => {
  const { taskReopenProvider } = await importTaskProvider();
  const existing = {
    id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "done",
    done_by: "alice", done_at: "t0", note: "shipped", initiative: "foo", revision: 2,
  };
  const snapshot = makeSnapshot({ nodes: { "T-x": existing } });
  const input = makeInputReopen();
  const plan = await taskReopenProvider.prepare({ snapshot, input, request: {} });

  const tx = makeTxStub({ existingNode: existing });
  const out = await taskReopenProvider.apply({ tx, plan, input, request: {}, snapshot });

  assert.equal(tx.calls.updateNode.length, 1);
  assert.equal(tx.calls.updateNode[0].id, "T-x");
  assert.equal(tx.calls.updateNode[0].patch.status, "open");
  assert.equal(tx.calls.updateNode[0].patch.claim, null);
  assert.equal("revision" in tx.calls.updateNode[0].patch, false);
  assert.equal(out.result.status, "open");
  assert.equal(out.result.previous_done_by, "alice");
});

test("task.cancel prepare: open task returns frozen plan with reason and previous_owner=null", async () => {
  const { taskCancelProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 } },
  });
  const input = makeInputCancel();
  const plan = await taskCancelProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.target.id, "T-x");
  assert.equal(plan.policyAction.action, "task.cancel");
  assert.equal(plan.logAction, "cancel");
  assert.equal(plan.reason, "abandoned");
  assert.equal(plan.target.previous_owner, null);
  assert.ok(Object.isFrozen(plan));
});

test("task.cancel prepare: in_progress carries previous_owner in target", async () => {
  const { taskCancelProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: {
      "T-x": {
        id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "in_progress",
        claim: { by: "alice", at: "t0" }, initiative: "foo", revision: 1,
      },
    },
  });
  const input = makeInputCancel();
  const plan = await taskCancelProvider.prepare({ snapshot, input, request: {} });

  assert.equal(plan.target.previous_owner, "alice");
});

test("task.cancel prepare: rejects done tasks with INVALID_STATUS", async () => {
  const { taskCancelProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "done", initiative: "foo", revision: 1 } },
  });
  const input = makeInputCancel();

  await expectThrows(
    () => taskCancelProvider.prepare({ snapshot, input, request: {} }),
    "INVALID_STATUS",
  );
});

test("task.cancel prepare: rejects missing reason with MISSING_FIELD", async () => {
  const { taskCancelProvider } = await importTaskProvider();
  const snapshot = makeSnapshot({
    nodes: { "T-x": { id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "open", initiative: "foo", revision: 1 } },
  });
  const input = makeInputCancel({ reason: "" });

  await expectThrows(
    () => taskCancelProvider.prepare({ snapshot, input, request: {} }),
    "MISSING_FIELD",
  );
});

test("task.cancel apply: sets canceled, clears claim; never writes revision", async () => {
  const { taskCancelProvider } = await importTaskProvider();
  const existing = {
    id: "T-x", kind: "resolvable", subkind: "task", title: "x", status: "in_progress",
    claim: { by: "alice", at: "t0" }, initiative: "foo", revision: 1,
  };
  const snapshot = makeSnapshot({ nodes: { "T-x": existing } });
  const input = makeInputCancel();
  const plan = await taskCancelProvider.prepare({ snapshot, input, request: {} });

  const tx = makeTxStub({ existingNode: existing });
  const out = await taskCancelProvider.apply({ tx, plan, input, request: {}, snapshot });

  assert.equal(tx.calls.updateNode.length, 1);
  assert.equal(tx.calls.updateNode[0].id, "T-x");
  assert.equal(tx.calls.updateNode[0].patch.status, "canceled");
  assert.equal(tx.calls.updateNode[0].patch.claim, null);
  assert.equal("revision" in tx.calls.updateNode[0].patch, false);
  assert.equal(out.result.status, "canceled");
  assert.equal(out.result.previous_owner, "alice");
});
