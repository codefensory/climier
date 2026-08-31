// Canonical task.accept provider tests (ADR-015/016).
// Acceptance transitions a submitted task to done without writing persistence.

import test from "node:test";
import assert from "node:assert/strict";

import { taskAcceptProvider } from "../src/providers/task/accept.mjs";
import { createTransaction } from "../src/kernel/transaction.mjs";

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

const fixedAcceptance = "2026-01-02T03:04:05.000Z";

function submittedTask(id = "submitted", extra = {}) {
  return task(id, "submitted", {
    submitted_by: "worker",
    submitted_at: "2026-01-01T00:00:00.000Z",
    claim: null,
    ...extra,
  });
}

test("task.accept accepts submitted tasks, preserves submission metadata and records acceptance metadata", async () => {
  const snapshot = state({
    submitted: submittedTask(),
    descendant: task("descendant"),
  }, [{ from: "submitted", to: "descendant", type: "BLOCKS" }]);
  const input = {
    id: "submitted",
    actor: "worker",
    accepted_at: fixedAcceptance,
  };

  const plan = await taskAcceptProvider.prepare({ snapshot, input, request: {} });
  const tx = createTransaction(snapshot);
  const output = await taskAcceptProvider.apply({ tx, plan, input, request: {}, snapshot });
  const accepted = tx.getNode("submitted");

  assert.equal(accepted.status, "done");
  assert.equal(accepted.submitted_by, "worker");
  assert.equal(accepted.submitted_at, "2026-01-01T00:00:00.000Z");
  assert.equal(accepted.done_by, "worker");
  assert.equal(accepted.done_at, fixedAcceptance);
  assert.equal(accepted.accepted_by, "worker");
  assert.equal(accepted.accepted_at, fixedAcceptance);
  assert.equal(accepted.claim, null);
  assert.deepEqual(output.effects, { newly_ready: ["descendant"] });
  assert.equal(output.result.revision, undefined);
  assert.equal(output.result.done_by, "worker");
});

test("task.accept allows the same actor that submitted the task", async () => {
  const snapshot = state({ submitted: submittedTask() });
  const plan = await taskAcceptProvider.prepare({
    snapshot,
    input: { id: "submitted", actor: "worker", accepted_at: fixedAcceptance },
    request: {},
  });

  assert.equal(plan.done_by, "worker");
  assert.equal(plan.accepted_by, "worker");
});

test("task.accept uses the host actor and does not require a distinct validator", async () => {
  const snapshot = state({ submitted: submittedTask() });
  const plan = await taskAcceptProvider.prepare({
    snapshot,
    input: { id: "submitted", actor: "worker", accepted_at: fixedAcceptance },
    request: { actor: "worker" },
  });

  assert.equal(plan.accepted_by, "worker");
});

test("task.accept accepts only submitted tasks", async () => {
  for (const status of ["open", "in_progress", "done", "canceled"]) {
    const snapshot = state({ candidate: task("candidate", status) });
    await assert.rejects(
      taskAcceptProvider.prepare({
        snapshot,
        input: { id: "candidate", actor: "validator", accepted_at: fixedAcceptance },
        request: {},
      }),
      (error) => error.code === "INVALID_STATUS" && error.details.current === status,
    );
  }
});

test("task.accept rejects missing actors and non-task targets", async () => {
  const snapshot = state({
    submitted: submittedTask(),
    gate: { id: "gate", kind: "resolvable", subkind: "gate", status: "submitted" },
  });

  await assert.rejects(
    taskAcceptProvider.prepare({
      snapshot,
      input: { id: "submitted", accepted_at: fixedAcceptance },
      request: {},
    }),
    (error) => error.code === "MISSING_FIELD" && error.details.field === "actor",
  );
  await assert.rejects(
    taskAcceptProvider.prepare({
      snapshot,
      input: { id: "gate", actor: "validator", accepted_at: fixedAcceptance },
      request: {},
    }),
    (error) => error.code === "INVALID_EXECUTION_CONTRACT",
  );
});
