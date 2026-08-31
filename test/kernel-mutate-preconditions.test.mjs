import { test } from "node:test";
import assert from "node:assert/strict";

import { checkPrecondition, selectPrecondition } from "../src/kernel/mutation/preconditions.mjs";

const snapshot = {
  nodes: {
    T1: { id: "T1", revision: 3 },
    T2: { id: "T2", revision: 7 },
  },
};

test("mutation preconditions: single, multi, and none preserve their normalized results", () => {
  assert.deepEqual(
    checkPrecondition({ kind: "single", id: "T1", value: 3 }, snapshot, "kernel.mutate(task.update)"),
    { kind: "single", id: "T1", value: 3 },
  );
  assert.deepEqual(
    checkPrecondition({ kind: "multi", values: { T1: 3, T2: 7 } }, snapshot, "kernel.mutate(task.update)"),
    { kind: "multi", values: { T1: 3, T2: 7 }, ids: ["T1", "T2"] },
  );
  assert.deepEqual(checkPrecondition({ kind: "none" }, snapshot, "kernel.mutate(task.update)"), { kind: "none" });
  assert.equal(checkPrecondition(undefined, snapshot, "kernel.mutate(task.update)"), null);
});

test("mutation preconditions: request CAS takes precedence over plan CAS", () => {
  const plan = { if_revision: { kind: "single", id: "T1", value: 3 } };
  assert.deepEqual(
    selectPrecondition(
      { if_revision: { kind: "single", id: "T2", value: 7 } },
      plan,
    ),
    { kind: "single", id: "T2", value: 7 },
  );
  assert.deepEqual(selectPrecondition({}, plan), plan.if_revision);
  assert.deepEqual(selectPrecondition({}, { if_revisions: { kind: "multi", values: { T1: 3, T2: 7 } } }), {
    kind: "multi",
    values: { T1: 3, T2: 7 },
  });
});

test("mutation preconditions: malformed and conflicting revisions keep exact errors", () => {
  assert.throws(
    () => checkPrecondition({ kind: "single", id: "T1", value: 2 }, snapshot, "kernel.mutate(task.update)"),
    (error) => error.code === "REVISION_CONFLICT" &&
      error.details.id === "T1" &&
      error.details.expected === 2 &&
      error.details.current === 3,
  );
  assert.throws(
    () => checkPrecondition({ kind: "multi", values: { T1: 3, T2: 99 } }, snapshot, "kernel.mutate(task.update)"),
    (error) => error.code === "REVISION_CONFLICT" &&
      error.details.id === "T2" &&
      error.details.expected === 99 &&
      error.details.current === 7,
  );
  assert.throws(
    () => checkPrecondition({ kind: "unexpected" }, snapshot, "kernel.mutate(task.update)"),
    (error) => error.code === "INVALID_EXECUTION_CONTRACT" &&
      error.details.field === "if_revision.kind",
  );
});
