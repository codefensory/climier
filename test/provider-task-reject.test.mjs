// Canonical task.reject provider tests (ADR-015/016).
// The provider owns only the submitted -> open transition; persistence and
// audit entry construction remain kernel responsibilities.

import test from "node:test";
import assert from "node:assert/strict";

import { createTransaction } from "../src/kernel/transaction.mjs";
import { isTaskReady } from "../src/providers/task/derivation.mjs";
import { taskRejectProvider } from "../src/providers/task/reject.mjs";

function state(nodes, edges = []) {
  return { version: 3, initiatives: {}, nodes, edges, log: [] };
}

const task = (id, status = "open", extra = {}) => ({
  id,
  kind: "resolvable",
  subkind: "task",
  status,
  ...extra,
});

test("task.reject prepares only submitted tasks and carries reason to the atomic log", async () => {
  const snapshot = state({
    submitted: task("submitted", "submitted", {
      submitted_by: "worker",
      submitted_at: "2026-01-01T00:00:00.000Z",
    }),
  });

  const plan = await taskRejectProvider.prepare({
    snapshot,
    input: { id: "submitted", reason: "needs changes" },
    request: { actor: "validator" },
  });

  assert.deepEqual(plan.target, {
    id: "submitted",
    kind: "resolvable",
    subkind: "task",
    status: "submitted",
  });
  assert.equal(plan.policyAction.action, "task.reject");
  assert.equal(plan.logAction, "reject");
  assert.deepEqual(plan.logFields, { reason: "needs changes" });
  assert.equal(plan.reason, "needs changes");
});

test("task.reject reopens the same task, clears claim and submission metadata, and unlocks no descendant", async () => {
  const snapshot = state(
    {
      blocker: task("blocker", "done"),
      submitted: task("submitted", "submitted", {
        claim: { by: "worker", at: "2026-01-01T00:00:00.000Z" },
        submitted_by: "worker",
        submitted_at: "2026-01-02T00:00:00.000Z",
        accepted_by: "validator",
        accepted_at: "2026-01-03T00:00:00.000Z",
      }),
      descendant: task("descendant"),
    },
    [
      { from: "blocker", to: "submitted", type: "BLOCKS" },
      { from: "submitted", to: "descendant", type: "BLOCKS" },
    ],
  );
  const input = { id: "submitted", reason: "needs changes" };
  const plan = await taskRejectProvider.prepare({
    snapshot,
    input,
    request: { actor: "validator" },
  });
  const tx = createTransaction(snapshot);
  const out = await taskRejectProvider.apply({
    tx,
    plan,
    input,
    request: { actor: "validator" },
    snapshot,
  });

  const rejected = tx.getNode("submitted");
  assert.equal(rejected.status, "open");
  assert.equal(rejected.claim, null);
  assert.equal(rejected.submitted_by, null);
  assert.equal(rejected.submitted_at, null);
  assert.equal(rejected.accepted_by, null);
  assert.equal(rejected.accepted_at, null);
  assert.equal(isTaskReady(tx.view(), "submitted"), true);
  assert.equal(isTaskReady(tx.view(), "descendant"), false);
  assert.equal(out.result.id, "submitted");
  assert.equal(out.result.status, "open");
  assert.equal(out.effects, null);
});

test("task.reject requires a reason and rejects every status other than submitted", async () => {
  const baseInput = { id: "target", reason: "needs changes" };
  for (const status of ["open", "in_progress", "done", "canceled"]) {
    await assert.rejects(
      taskRejectProvider.prepare({
        snapshot: state({ target: task("target", status) }),
        input: baseInput,
        request: { actor: "validator" },
      }),
      (error) => error.code === "INVALID_STATUS",
      `status ${status} must not be rejected`,
    );
  }

  await assert.rejects(
    taskRejectProvider.prepare({
      snapshot: state({ target: task("target", "submitted") }),
      input: { id: "target" },
      request: { actor: "validator" },
    }),
    (error) => error.code === "MISSING_FIELD" && error.details.field === "reason",
  );
});
