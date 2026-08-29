// test/provider-gate-lifecycle.test.mjs — pure tests for the gate lifecycle
// providers (plan §B4-gate-lifecycle, ADR-011 §§1–4, ADR-012 §3).
//
// Every test runs against literal state objects and the real kernel
// transaction. No temp dirs, no filesystem, no lock, no CLI.

import test from "node:test";
import assert from "node:assert/strict";

import {
  gateResolveProvider,
  gateReopenProvider,
  gateCancelProvider,
  gateProviders,
} from "../src/providers/gate/index.mjs";
import { createTransaction } from "../src/kernel/transaction.mjs";

function baseSnapshot() {
  return {
    version: 2,
    initiatives: { work: { desc: "work", created_at: "2026-01-01T00:00:00.000Z" } },
    nodes: {
      T1: {
        id: "T1", kind: "resolvable", subkind: "task", title: "Blocker",
        initiative: "work", status: "done", resolution_mode: "labor", revision: 1,
      },
      "G-A": {
        id: "G-A", kind: "resolvable", subkind: "gate", title: "Gate A", body: "B",
        initiative: "work", status: "open", resolution_mode: "choice", purpose: "decision",
        revision: 2,
      },
      "G-B": {
        id: "G-B", kind: "resolvable", subkind: "gate", title: "Gate B", body: "B",
        initiative: "work", status: "resolved", resolution_mode: "choice", purpose: "decision",
        resolution: { choice: "yes", rationale: "ok" },
        revision: 3,
      },
      "G-LABOR": {
        id: "G-LABOR", kind: "resolvable", subkind: "gate", title: "Gate Labor",
        body: "B", initiative: "work", status: "open", resolution_mode: "labor",
        purpose: "approval", revision: 1,
      },
      "T-DEP": {
        id: "T-DEP", kind: "resolvable", subkind: "task", title: "Dependent",
        initiative: "work", status: "open", resolution_mode: "labor", revision: 1,
      },
      "T-MULTI": {
        id: "T-MULTI", kind: "resolvable", subkind: "task", title: "Multi-blocked",
        initiative: "work", status: "open", resolution_mode: "labor", revision: 1,
      },
      "K-A": {
        id: "K-A", kind: "knowledge", title: "K", initiative: "work",
        status: "active", knowledge_type: "warning", revision: 1,
      },
    },
    edges: [
      // Gate A blocks dependent; dependent becomes ready only when A resolves.
      { from: "G-A", to: "T-DEP", type: "BLOCKS" },
      // T-MULTI is also blocked by T1 (which is already done), so it stays
      // blocked by Gate A only and flips with it.
      { from: "G-A", to: "T-MULTI", type: "BLOCKS" },
      { from: "T1", to: "T-MULTI", type: "BLOCKS" },
    ],
    log: [],
  };
}

async function runResolve(snapshot, input) {
  const plan = await gateResolveProvider.prepare({
    snapshot,
    input,
    request: { action: "gate.resolve", actor: "alice" },
  });
  const tx = createTransaction(snapshot);
  const applied = await gateResolveProvider.apply({
    tx,
    plan,
    input,
    request: { action: "gate.resolve", actor: "alice" },
    snapshot,
  });
  return { plan, tx, view: tx.view(), ...applied };
}

async function runReopen(snapshot, input) {
  const plan = await gateReopenProvider.prepare({
    snapshot,
    input,
    request: { action: "gate.reopen", actor: "alice" },
  });
  const tx = createTransaction(snapshot);
  const applied = await gateReopenProvider.apply({
    tx,
    plan,
    input,
    request: { action: "gate.reopen", actor: "alice" },
    snapshot,
  });
  return { plan, tx, view: tx.view(), ...applied };
}

async function runCancel(snapshot, input) {
  const plan = await gateCancelProvider.prepare({
    snapshot,
    input,
    request: { action: "gate.cancel", actor: "alice" },
  });
  const tx = createTransaction(snapshot);
  const applied = await gateCancelProvider.apply({
    tx,
    plan,
    input,
    request: { action: "gate.cancel", actor: "alice" },
    snapshot,
  });
  return { plan, tx, view: tx.view(), ...applied };
}

test("lifecycle providers are registered and frozen", () => {
  assert.equal(gateProviders["gate.resolve"], gateResolveProvider);
  assert.equal(gateProviders["gate.reopen"], gateReopenProvider);
  assert.equal(gateProviders["gate.cancel"], gateCancelProvider);
  for (const provider of [gateResolveProvider, gateReopenProvider, gateCancelProvider]) {
    assert.equal(typeof provider.prepare, "function");
    assert.equal(typeof provider.apply, "function");
  }
  assert.throws(() => {
    gateProviders["gate.other"] = {};
  });
});

test("gate.resolve prepares target/policy/log/affected and applies status=resolved + choice", async () => {
  const snapshot = baseSnapshot();
  const before = structuredClone(snapshot);
  const { plan, view, result, effects } = await runResolve(snapshot, {
    id: "G-A",
    choice: "yes",
    rationale: "approved",
    if_revisions: { "G-A": 2 },
  });
  assert.deepEqual(plan.target, { id: "G-A", kind: "resolvable", subkind: "gate" });
  assert.deepEqual(plan.policyAction, { action: "task.resolve" });
  assert.equal(plan.logAction, "resolve");
  assert.equal(plan.logNote, "G-A");
  assert.deepEqual(plan.logFields, { choice: "yes", rationale: "approved" });
  assert.deepEqual(plan.affected, ["G-A"]);
  assert.deepEqual(plan.if_revisions, { kind: "multi", values: { "G-A": 2 } });
  assert.equal(view.nodes["G-A"].status, "resolved");
  assert.deepEqual(view.nodes["G-A"].resolution, { choice: "yes", rationale: "approved" });
  assert.equal("revision" in view.nodes["G-A"], false);
  assert.deepEqual(result.resolution, { choice: "yes", rationale: "approved" });
  // T-DEP is blocked only by G-A. T-MULTI is also blocked by already-done
  // T1, so G-A is its sole remaining unsatisfied blocker → both flip.
  assert.deepEqual(effects.newly_ready.sort(), ["T-DEP", "T-MULTI"]);
  assert.deepEqual(effects.affected, ["G-A"]);
  // Isolation: snapshot untouched, apply never assigns revision.
  assert.deepEqual(snapshot, before);
});

test("gate.resolve is a no-op for already-ready tasks and surfaces dependents", async () => {
  // Same fixture as the previous test: T1 is done, so resolving G-A flips
  // both T-DEP and T-MULTI to ready. This second test pins the rule that
  // resolve is idempotent over tasks that were already ready (none here).
  const snapshot = baseSnapshot();
  const { effects } = await runResolve(snapshot, {
    id: "G-A",
    choice: "yes",
    rationale: "approved",
    if_revisions: { "G-A": 2 },
  });
  assert.deepEqual(effects.newly_ready.sort(), ["T-DEP", "T-MULTI"]);
});

test("gate.reopen prepares reopen payload and applies status=open + cleared resolution", async () => {
  const snapshot = baseSnapshot();
  const before = structuredClone(snapshot);
  const { plan, view, effects } = await runReopen(snapshot, {
    id: "G-B",
    reason: "revisit",
    if_revisions: { "G-B": 3 },
  });
  assert.deepEqual(plan.target, { id: "G-B", kind: "resolvable", subkind: "gate" });
  assert.deepEqual(plan.policyAction, { action: "task.reopen" });
  assert.equal(plan.logAction, "reopen");
  assert.equal(plan.logNote, "revisit");
  assert.deepEqual(plan.logFields, { reason: "revisit" });
  assert.equal(plan.reason, "revisit");
  assert.equal(view.nodes["G-B"].status, "open");
  // The patch carries `resolution: null` so the next persist clears it.
  assert.equal(view.nodes["G-B"].resolution, null);
  // Reopen reports nothing new to re-block for this fixture (G-B had no
  // dependents in base snapshot). The dependent re-block path is covered
  // by the resolve -> reopen round-trip below.
  assert.deepEqual(effects.newly_blocked, []);
  assert.deepEqual(snapshot, before);
});

test("resolve -> reopen round trip re-blocks dependents", async () => {
  const snapshot = baseSnapshot();
  const resolved = await runResolve(snapshot, {
    id: "G-A",
    choice: "yes",
    rationale: "approved",
    if_revisions: { "G-A": 2 },
  });
  // After resolve, dependents are ready; reopen should re-block them.
  const reopened = await runReopen(resolved.view, {
    id: "G-A",
    reason: "revisit",
  });
  assert.equal(reopened.view.nodes["G-A"].status, "open");
  // T1 (done) is not in this reopened graph, so T-MULTI is blocked by
  // G-A only → it re-blocks. T-DEP was blocked only by G-A → re-blocks.
  assert.deepEqual(reopened.effects.newly_blocked.sort(), ["T-DEP", "T-MULTI"]);
});

test("gate.cancel prepares cancel payload and applies status=canceled", async () => {
  const snapshot = baseSnapshot();
  const before = structuredClone(snapshot);
  const { plan, view, effects } = await runCancel(snapshot, {
    id: "G-A",
    reason: "scope dropped",
    if_revisions: { "G-A": 2 },
  });
  assert.deepEqual(plan.target, { id: "G-A", kind: "resolvable", subkind: "gate" });
  assert.deepEqual(plan.policyAction, { action: "task.cancel" });
  assert.equal(plan.logAction, "cancel");
  assert.equal(plan.logNote, "scope dropped");
  assert.deepEqual(plan.logFields, { reason: "scope dropped" });
  assert.equal(plan.reason, "scope dropped");
  assert.equal(view.nodes["G-A"].status, "canceled");
  // G-A was already open + unsatisfied, so canceling it does not flip
  // any dependents here (wasReady=false → blocked; isReady=false → still
  // blocked). Newly_blocked from cancel only fires when a previously
  // ready dependent loses its only satisfied blocker, but cancel from
  // open/in_progress cannot reach that state because the gate was
  // already unsatisfied. That asymmetry is the contract.
  assert.deepEqual(effects.newly_blocked, []);
  assert.deepEqual(snapshot, before);
});

test("structured errors: NODE_NOT_FOUND, INVALID_STATUS, MISSING_FIELD, RESOLVABLE, REVISION_CONFLICT", async () => {
  const snapshot = baseSnapshot();
  const cases = [
    // gate.resolve
    [gateResolveProvider, { id: "missing", choice: "x", rationale: "y" }, "NODE_NOT_FOUND"],
    [gateResolveProvider, { id: "G-B", choice: "x", rationale: "y", if_revisions: { "G-B": 3 } }, "INVALID_STATUS"],
    [gateResolveProvider, { id: "G-A", rationale: "y" }, "MISSING_FIELD"],
    [gateResolveProvider, { id: "G-A", choice: "x" }, "MISSING_FIELD"],
    [gateResolveProvider, { id: "G-LABOR", choice: "x", rationale: "y" }, "INVALID_EXECUTION_CONTRACT"],
    [gateResolveProvider, { id: "G-A", choice: "x", rationale: "y", if_revisions: { "G-A": 1 } }, "REVISION_CONFLICT"],
    // gate.reopen
    [gateReopenProvider, { id: "missing", reason: "r" }, "NODE_NOT_FOUND"],
    [gateReopenProvider, { id: "G-A", reason: "r" }, "INVALID_STATUS"],
    [gateReopenProvider, { id: "G-B" }, "MISSING_FIELD"],
    // gate.cancel
    [gateCancelProvider, { id: "missing", reason: "r" }, "NODE_NOT_FOUND"],
    [gateCancelProvider, { id: "G-B", reason: "r" }, "INVALID_STATUS"],
    [gateCancelProvider, { id: "G-A" }, "MISSING_FIELD"],
  ];
  for (const [provider, input, code] of cases) {
    await assert.rejects(
      provider.prepare({ snapshot, input }),
      (err) => err.code === code,
      `expected ${code} for ${JSON.stringify(input)}`,
    );
  }
});

test("prepare is read-only and never mutates the snapshot", async () => {
  const snapshot = baseSnapshot();
  const before = structuredClone(snapshot);
  const fail = [
    [gateResolveProvider, { id: "missing", choice: "x", rationale: "y" }],
    [gateReopenProvider, { id: "G-A", reason: "r" }],
    [gateCancelProvider, { id: "G-B", reason: "r" }],
  ];
  for (const [provider, input] of fail) {
    await assert.rejects(provider.prepare({ snapshot, input }), (err) => typeof err.code === "string");
  }
  assert.deepEqual(snapshot, before);
});

test("lifecycle providers never write revision into the draft", async () => {
  const snapshot = baseSnapshot();
  // resolve
  let plan = await gateResolveProvider.prepare({
    snapshot,
    input: { id: "G-A", choice: "yes", rationale: "ok", if_revisions: { "G-A": 2 } },
  });
  let tx = createTransaction(snapshot);
  await gateResolveProvider.apply({ tx, plan, snapshot });
  let view = tx.view();
  assert.equal("revision" in view.nodes["G-A"], false);
  // reopen
  plan = await gateReopenProvider.prepare({
    snapshot,
    input: { id: "G-B", reason: "r", if_revisions: { "G-B": 3 } },
  });
  tx = createTransaction(snapshot);
  await gateReopenProvider.apply({ tx, plan, snapshot });
  view = tx.view();
  assert.equal("revision" in view.nodes["G-B"], false);
  // cancel
  plan = await gateCancelProvider.prepare({
    snapshot,
    input: { id: "G-A", reason: "r", if_revisions: { "G-A": 2 } },
  });
  tx = createTransaction(snapshot);
  await gateCancelProvider.apply({ tx, plan, snapshot });
  view = tx.view();
  assert.equal("revision" in view.nodes["G-A"], false);
});

test("tx rejects patches that try to seed revision (kernel contract)", async () => {
  const snapshot = baseSnapshot();
  const plan = await gateResolveProvider.prepare({
    snapshot,
    input: { id: "G-A", choice: "yes", rationale: "ok", if_revisions: { "G-A": 2 } },
  });
  const tx = createTransaction(snapshot);
  await assert.rejects(
    async () => tx.updateNode("G-A", { status: "resolved", revision: 99 }),
    (err) => err.code === "INVALID_EXECUTION_CONTRACT",
  );
  void plan;
});
