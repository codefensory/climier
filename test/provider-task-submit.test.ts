import { test } from "node:test";
import assert from "node:assert/strict";

import { taskSubmitProvider } from "../src/providers/task/submit.ts";

type Claim = { by: string; at: string } | null;
type CaughtError = { code?: string };

function caughtError(error: unknown): CaughtError {
  return typeof error === "object" && error !== null ? error as CaughtError : {};
}

const ACTOR = "codex-worker";
const SUBMITTED_AT = "2026-01-02T03:04:05.000Z";

function snapshot({
  status = "in_progress",
  claim = { by: ACTOR, at: "2026-01-01T00:00:00.000Z" },
}: { status?: string; claim?: Claim } = {}) {
  return {
    version: 3,
    initiatives: {},
    nodes: {
      "T-submit": {
        id: "T-submit",
        kind: "resolvable",
        subkind: "task",
        title: "Submit this task",
        status,
        claim,
        revision: 7,
      },
      "T-dependent": {
        id: "T-dependent",
        kind: "resolvable",
        subkind: "task",
        title: "Dependent task",
        status: "open",
        claim: null,
        revision: 1,
      },
    },
    edges: [{ from: "T-submit", to: "T-dependent", type: "BLOCKS" }],
    log: [],
  };
}

function request(input, actor = ACTOR) {
  return { action: "task.submit", actor, input };
}

function makeSubmitInput(overrides = {}) {
  return { id: "T-submit", note: "Implementation is ready for validation", submitted_at: SUBMITTED_AT, ...overrides };
}

function txStub(initialSnapshot) {
  const nodes: Record<string, Record<string, unknown>> = {};
  const sourceNodes = initialSnapshot.nodes as Record<string, Record<string, unknown>>;
  for (const [id, node] of Object.entries(sourceNodes)) {
    nodes[id] = { ...node };
  }
  const calls: Array<{ id: string; patch: Record<string, unknown> }> = [];
  return {
    calls,
    updateNode(id, patch) {
      calls.push({ id, patch });
      nodes[id] = { ...nodes[id], ...patch };
      return { ...nodes[id] };
    },
    getNode(id) {
      return nodes[id] ? { ...nodes[id] } : undefined;
    },
  };
}

async function expectCode(fn, code) {
  await assert.rejects(fn, (error) => {
    assert.equal(caughtError(error).code, code);
    return true;
  });
}

test("task.submit prepare: validates the in_progress owner and freezes the plan", async () => {
  const snapshotValue = snapshot();
  const submitInput = makeSubmitInput();
  const plan = await taskSubmitProvider.prepare({
    snapshot: snapshotValue,
    input: submitInput,
    request: request(submitInput),
  });

  assert.equal(plan.target.id, "T-submit");
  assert.equal(plan.target.status, "in_progress");
  assert.equal(plan.policyAction.action, "task.submit");
  assert.equal(plan.logAction, "submit");
  assert.equal(plan.note, submitInput.note);
  assert.equal(plan.submitted_by, ACTOR);
  assert.equal(plan.submitted_at, SUBMITTED_AT);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.target));
  assert.ok(Object.isFrozen(plan.policyAction));
  assert.equal(snapshotValue.nodes["T-submit"].status, "in_progress");
  assert.equal(snapshotValue.nodes["T-submit"].claim?.by, ACTOR);
});

test("task.submit prepare: rejects every status except in_progress", async () => {
  for (const status of ["open", "submitted", "done", "canceled"]) {
    const submitInput = makeSubmitInput();
    await expectCode(
      () => taskSubmitProvider.prepare({ snapshot: snapshot({ status }), input: submitInput, request: request(submitInput) }),
      "INVALID_STATUS",
    );
  }
});

test("task.submit prepare: rejects a task without a claim or with another owner", async () => {
  const submitInput = makeSubmitInput();
  await expectCode(
    () => taskSubmitProvider.prepare({ snapshot: snapshot({ claim: null }), input: submitInput, request: request(submitInput) }),
    "NOT_OWNER",
  );

  await expectCode(
    () => taskSubmitProvider.prepare({
      snapshot: snapshot({ claim: { by: "another-agent", at: "2026-01-01T00:00:00.000Z" } }),
      input: submitInput,
      request: request(submitInput),
    }),
    "NOT_OWNER",
  );
});

test("task.submit prepare: requires id, actor, and delivery note", async () => {
  const snapshotValue = snapshot();
  await expectCode(
    () => taskSubmitProvider.prepare({ snapshot: snapshotValue, input: makeSubmitInput({ id: "" }), request: request(makeSubmitInput({ id: "" })) }),
    "MISSING_FIELD",
  );
  await expectCode(
    () => taskSubmitProvider.prepare({ snapshot: snapshotValue, input: makeSubmitInput({ note: "" }), request: request(makeSubmitInput({ note: "" })) }),
    "MISSING_FIELD",
  );
  await expectCode(
    () => taskSubmitProvider.prepare({ snapshot: snapshotValue, input: makeSubmitInput(), request: request(makeSubmitInput(), "") }),
    "MISSING_FIELD",
  );
});

test("task.submit apply: changes status, clears claim, and stores submission metadata", async () => {
  const snapshotValue = snapshot();
  const submitInput = makeSubmitInput();
  const plan = await taskSubmitProvider.prepare({
    snapshot: snapshotValue,
    input: submitInput,
    request: request(submitInput),
  });
  const tx = txStub(snapshotValue);

  const output = await taskSubmitProvider.apply({
    tx,
    plan,
  });

  assert.deepEqual(tx.calls, [{
    id: "T-submit",
    patch: {
      status: "submitted",
      claim: null,
      note: submitInput.note,
      submitted_by: ACTOR,
      submitted_at: SUBMITTED_AT,
    },
  }]);
  assert.equal(output.result.id, "T-submit");
  assert.equal(output.result.status, "submitted");
  assert.equal(output.result.claim, null);
  assert.equal(output.result.submitted_by, ACTOR);
  assert.equal(output.result.submitted_at, SUBMITTED_AT);
  assert.deepEqual(output.result.added_edges, []);
  assert.deepEqual(output.effects, { newly_ready: [] });
  assert.equal("revision" in output.result, false);
});

test("task.submit apply: never reports newly ready dependents", async () => {
  const snapshotValue = snapshot();
  const submitInput = makeSubmitInput();
  const plan = await taskSubmitProvider.prepare({
    snapshot: snapshotValue,
    input: submitInput,
    request: request(submitInput),
  });
  const output = await taskSubmitProvider.apply({ tx: txStub(snapshotValue), plan });

  assert.deepEqual(output.effects.newly_ready, []);
});
