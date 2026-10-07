import test from "node:test";
import assert from "node:assert/strict";

import {
  diffReadyByGate,
  gateProjection,
  isCurrent,
  isSatisfied,
  supersededBy,
} from "../src/providers/gate/semantics.ts";
import { gateUpdateProvider } from "../src/providers/gate/index.ts";
import { createTransaction } from "../src/kernel/transaction.ts";

type CaughtError = { code?: string };

function caughtError(error: unknown): CaughtError {
  return typeof error === "object" && error !== null ? error as CaughtError : {};
}

function snapshot() {
  return {
    version: 2,
    initiatives: { work: { desc: "work" } },
    nodes: {
      "G-old": {
        id: "G-old", kind: "resolvable", subkind: "gate", title: "old",
        status: "superseded", resolution_mode: "choice", revision: 2,
      },
      "G-new": {
        id: "G-new", kind: "resolvable", subkind: "gate", title: "new",
        status: "resolved", resolution_mode: "choice", revision: 1,
      },
      T1: {
        id: "T1", kind: "resolvable", subkind: "task", title: "dependent",
        status: "open", resolution_mode: "labor", revision: 1,
      },
    },
    edges: [
      { from: "G-new", to: "G-old", type: "SUPERSEDES" },
      { from: "G-old", to: "T1", type: "BLOCKS" },
    ],
    log: [],
  };
}

test("gate semantics has one canonical supersedence and satisfaction implementation", () => {
  const state = snapshot();
  assert.equal(supersededBy(state, "G-old"), "G-new");
  assert.equal(isCurrent(state, "G-old"), false);
  assert.equal(isCurrent(state, "G-new"), true);
  assert.equal(isSatisfied(state, "G-old", undefined), true);
  assert.deepEqual(gateProjection(state, "G-old"), {
    ...state.nodes["G-old"],
    is_current: false,
    superseded_by: "G-new",
  });
  assert.deepEqual(gateProjection(state, "missing"), {
    id: "missing",
    status: "missing",
    is_current: true,
    superseded_by: null,
  });
});

test("gate satisfaction rejects cycles and follows the deterministic superseder", () => {
  const state = snapshot();
  state.nodes["G-new"].status = "superseded";
  state.edges.push({ from: "G-old", to: "G-new", type: "SUPERSEDES" });
  assert.equal(isSatisfied(state, "G-old", undefined), false);
});

test("diffReadyByGate remains a pure projection over snapshot and draft graphs", () => {
  const state = snapshot();
  state.nodes["G-old"].status = "open";
  const resolved = structuredClone(state);
  resolved.nodes["G-old"].status = "resolved";
  assert.deepEqual(
    diffReadyByGate({ nodes: state.nodes, edges: state.edges }, { nodes: resolved.nodes, edges: resolved.edges }, "G-old", "up"),
    ["T1"],
  );
  assert.equal(state.nodes["G-old"].status, "open");
});

function gateSnapshot() {
  return {
    ...snapshot(),
    nodes: {
      ...snapshot().nodes,
      "G-old": {
        ...snapshot().nodes["G-old"],
        status: "open",
        title: "before",
        body: "body",
        purpose: "decision",
        initiative: "work",
        tags: ["old"],
        refs: [],
      },
    },
    edges: [],
  };
}

test("gate.update prepares and applies the CLI patch contract with CAS and policy action", async () => {
  const state = gateSnapshot();
  const before = structuredClone(state);
  const plan = await gateUpdateProvider.prepare({
    snapshot: state,
    request: { action: "gate.update", actor: "alice" },
    input: {
      id: "G-old",
      if_revision: 2,
      changes: {
        title: "after",
        resolution_mode: "approval",
        tags: ["new"],
        refs: [{ type: "external", target: "docs/gate.md" }],
        backlog: false,
      },
    },
  });
  assert.deepEqual(plan.target, { id: "G-old", kind: "resolvable", subkind: "gate", revision: 2 });
  assert.deepEqual(plan.if_revision, { kind: "single", id: "G-old", value: 2 });
  assert.deepEqual(plan.policyAction, { action: "gate.update", pluginId: null });
  assert.equal(plan.logAction, "update");
  const tx = createTransaction(state);
  const applied = await gateUpdateProvider.apply({
    tx,
    plan,
    input: {
      id: "G-old",
      if_revision: 2,
      changes: {
        title: "after",
        resolution_mode: "approval",
        tags: ["new"],
        refs: [{ type: "external", target: "docs/gate.md" }],
        backlog: false,
      },
    },
    request: { action: "gate.update", actor: "alice" },
    snapshot: state,
  });
  assert.equal(applied.result.title, "after");
  assert.equal(applied.result.resolution_mode, "approval");
  assert.deepEqual(applied.result.tags, ["new"]);
  assert.equal("backlog" in tx.view().nodes["G-old"], true);
  assert.equal(tx.view().nodes["G-old"].backlog, undefined);
  assert.equal("revision" in tx.view().nodes["G-old"], false);
  assert.deepEqual(state, before);
});

test("gate.update rejects non-gates, unknown fields, missing CAS, and stale CAS", async () => {
  const state = gateSnapshot();
  await assert.rejects(
    gateUpdateProvider.prepare({ snapshot: state, input: { id: "T1", if_revision: 1, changes: { title: "x" } }, request: { action: "gate.update", actor: "alice" } }),
    (err) => caughtError(err).code === "INVALID_EXECUTION_CONTRACT",
  );
  await assert.rejects(
    gateUpdateProvider.prepare({ snapshot: state, input: { id: "G-old", if_revision: 2, changes: { status: "resolved" } }, request: { action: "gate.update", actor: "alice" } }),
    (err) => caughtError(err).code === "INVALID_EXECUTION_CONTRACT",
  );
  await assert.rejects(
    gateUpdateProvider.prepare({ snapshot: state, input: { id: "G-old", changes: { title: "x" } }, request: { action: "gate.update", actor: "alice" } }),
    (err) => caughtError(err).code === "MISSING_FIELD",
  );
  await assert.rejects(
    gateUpdateProvider.prepare({ snapshot: state, input: { id: "G-old", if_revision: 1, changes: { title: "x" } }, request: { action: "gate.update", actor: "alice" } }),
    (err) => caughtError(err).code === "REVISION_CONFLICT",
  );
});
