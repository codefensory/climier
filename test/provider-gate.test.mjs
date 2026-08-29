// test/provider-gate.test.mjs — pure tests for the gate provider
// (plan §B4-gate-core, ADR-011 §§1-5, ADR-012 §3).
//
// Every test runs against literal state objects and the real kernel
// transaction. No temp dirs, no filesystem, no lock, no CLI.

import test from "node:test";
import assert from "node:assert/strict";

import { gateCreateProvider, gateProviders, GATE_PROVIDER_KIND } from "../src/providers/gate/index.mjs";
import { createTransaction } from "../src/kernel/transaction.mjs";

function baseSnapshot() {
  return {
    version: 2,
    initiatives: { work: { desc: "work", created_at: "2026-01-01T00:00:00.000Z" } },
    nodes: {
      T1: {
        id: "T1", kind: "resolvable", subkind: "task", title: "Blocker",
        initiative: "work", status: "open", resolution_mode: "labor", revision: 1,
      },
      T2: {
        id: "T2", kind: "resolvable", subkind: "task", title: "Dependent",
        initiative: "work", status: "open", resolution_mode: "labor", revision: 3,
      },
      "G-A": {
        id: "G-A", kind: "resolvable", subkind: "gate", title: "Old gate", body: "Old",
        initiative: "work", status: "open", resolution_mode: "choice", purpose: "decision", revision: 2,
      },
      "K-A": {
        id: "K-A", kind: "knowledge", title: "Knowledge", initiative: "work",
        status: "active", knowledge_type: "warning", revision: 1,
      },
    },
    edges: [
      { from: "T1", to: "G-A", type: "BLOCKS" },
      { from: "G-A", to: "T2", type: "BLOCKS" },
    ],
    log: [],
  };
}

function validInput(extra = {}) {
  return {
    id: "G-B",
    initiative: "work",
    title: "New gate",
    body: "New",
    purpose: "decision",
    ...extra,
  };
}

async function run(snapshot, input) {
  const plan = await gateCreateProvider.prepare({ snapshot, input, request: { action: "gate.create", actor: "alice" } });
  const tx = createTransaction(snapshot);
  const applied = await gateCreateProvider.apply({ tx, plan, input, request: { action: "gate.create", actor: "alice" }, snapshot });
  return { plan, tx, view: tx.view(), ...applied };
}

function edgeExists(edges, from, to, type) {
  return edges.some((e) => e.from === from && e.to === to && e.type === type);
}

test("gate provider exposes gate.create with prepare/apply", () => {
  assert.equal(typeof gateCreateProvider.prepare, "function");
  assert.equal(typeof gateCreateProvider.apply, "function");
  assert.equal(gateProviders["gate.create"], gateCreateProvider);
  assert.equal(GATE_PROVIDER_KIND, "gate");
  assert.throws(() => { gateProviders["gate.other"] = {}; });
});

test("prepare declares target, policyAction, logAction and affected for a plain create", async () => {
  const snapshot = baseSnapshot();
  const plan = await gateCreateProvider.prepare({ snapshot, input: validInput() });
  assert.deepEqual(plan.target, { id: "G-B", kind: "resolvable", subkind: "gate" });
  assert.deepEqual(plan.policyAction, { action: "gate.create" });
  assert.equal(plan.logAction, "add-node");
  assert.deepEqual(plan.affected, []);
  assert.deepEqual(plan.if_revisions, { kind: "none" });
  assert.equal(plan.supersedes, null);
  assert.equal("revision" in plan.node, false);
  assert.equal(plan.node.subkind, "gate");
  assert.equal(plan.node.resolution_mode, "choice");
  assert.equal(plan.node.status, "open");
});

test("apply creates the gate in the draft and returns result + effects", async () => {
  const snapshot = baseSnapshot();
  const before = structuredClone(snapshot);
  const { view, result, effects } = await run(snapshot, validInput({ tags: ["dag"], refs: ["docs/x.md"], domain: "core" }));
  assert.equal(view.nodes["G-B"].title, "New gate");
  assert.equal("revision" in view.nodes["G-B"], false);
  assert.deepEqual(view.nodes["G-B"].tags, ["dag"]);
  assert.deepEqual(view.nodes["G-B"].refs, [{ type: "external", target: "docs/x.md" }]);
  assert.equal(result.node.id, "G-B");
  assert.equal(result.superseded, null);
  assert.deepEqual(effects, { superseded: null, blockers_rewritten: [], blockers_collapsed: [], affected: [] });
  // prepare + apply are read-only over the snapshot (tx isolation).
  assert.deepEqual(snapshot, before);
});

test("prepare is read-only: a failing prepare never mutates the snapshot", async () => {
  const snapshot = baseSnapshot();
  const before = structuredClone(snapshot);
  await assert.rejects(
    gateCreateProvider.prepare({ snapshot, input: validInput({ blocked_by: ["missing"] }) }),
    (err) => err.code === "INVALID_EDGE_TARGET" && err.details.missing === "missing",
  );
  assert.deepEqual(snapshot, before);
});

test("blocked_by and derived_from produce canonical edges", async () => {
  const snapshot = baseSnapshot();
  const { view, plan } = await run(snapshot, validInput({ blocked_by: ["T1", "T2"], derived_from: ["G-A"] }));
  assert.ok(edgeExists(plan.edges, "T1", "G-B", "BLOCKS"));
  assert.ok(edgeExists(plan.edges, "T2", "G-B", "BLOCKS"));
  assert.ok(edgeExists(plan.edges, "G-B", "G-A", "DERIVED_FROM"));
  assert.ok(edgeExists(view.edges, "T1", "G-B", "BLOCKS"));
  assert.ok(edgeExists(view.edges, "G-B", "G-A", "DERIVED_FROM"));
});

test("structured errors: id conflict, unknown initiative, missing fields, invalid status", async () => {
  const snapshot = baseSnapshot();
  const cases = [
    [validInput({ id: "G-A" }), "ID_CONFLICT"],
    [validInput({ id: "bad id" }), "INVALID_ID"],
    [validInput({ initiative: "nope" }), "INITIATIVE_NOT_FOUND"],
    [{ id: "G-B", initiative: "work", body: "b", purpose: "decision" }, "MISSING_FIELD"],
    [{ id: "G-B", initiative: "work", title: "t", body: "b" }, "MISSING_FIELD"],
    [validInput({ status: "weird" }), "INVALID_STATUS"],
    [validInput({ tags: [""] }), "MISSING_FIELD"],
    [validInput({ blocked_by: ["T1", "T1"] }), "DUPLICATE_EDGE"],
    [validInput({ blocked_by: ["K-A"] }), "INVALID_EDGE_KIND"],
  ];
  for (const [input, code] of cases) {
    await assert.rejects(
      gateCreateProvider.prepare({ snapshot, input }),
      (err) => err.code === code,
      `expected ${code} for ${JSON.stringify(input)}`,
    );
  }
});

test("choice/rationale are validated as applicable pairs", async () => {
  const snapshot = baseSnapshot();
  await assert.rejects(
    gateCreateProvider.prepare({ snapshot, input: validInput({ choice: "A" }) }),
    (err) => err.code === "MISSING_FIELD" && err.details.field === "rationale",
  );
  await assert.rejects(
    gateCreateProvider.prepare({ snapshot, input: validInput({ rationale: "because" }) }),
    (err) => err.code === "MISSING_FIELD" && err.details.field === "choice",
  );
  await assert.rejects(
    gateCreateProvider.prepare({
      snapshot,
      input: validInput({ choice: "A", rationale: "because", resolution_mode: "labor" }),
    }),
    (err) => err.code === "INVALID_EXECUTION_CONTRACT" && err.details.resolution_mode === "labor",
  );
  await assert.rejects(
    gateCreateProvider.prepare({ snapshot, input: validInput({ status: "resolved" }) }),
    (err) => err.code === "MISSING_FIELD" && err.details.status === "resolved",
  );
  const plan = await gateCreateProvider.prepare({
    snapshot,
    input: validInput({ status: "resolved", choice: "A", rationale: "because" }),
  });
  assert.deepEqual(plan.node.resolution, { choice: "A", rationale: "because" });
});

test("supersede rewrites incoming blockers atomically across multiple nodes", async () => {
  const snapshot = baseSnapshot();
  snapshot.edges.push({ from: "T2", to: "G-A", type: "BLOCKS" });
  const before = structuredClone(snapshot);
  const { plan, view, result, effects } = await run(
    snapshot,
    validInput({ supersedes: "G-A", if_revisions: { "G-A": 2 } }),
  );

  assert.equal(plan.logAction, "supersede");
  assert.equal(plan.logNote, "G-B supersedes G-A");
  assert.deepEqual(plan.affected, ["G-A"]);
  assert.deepEqual(plan.if_revisions, { kind: "multi", values: { "G-A": 2 } });

  // multi-node draft: new gate + superseded gate, no revision touched.
  assert.equal(view.nodes["G-B"].id, "G-B");
  assert.equal(view.nodes["G-A"].status, "superseded");
  assert.equal("revision" in view.nodes["G-A"], false);

  // blockers of the old gate now block the new gate; dependents keep pointing
  // at the superseded gate (the v2 derivation walks the SUPERSEDES chain).
  assert.ok(edgeExists(view.edges, "G-B", "G-A", "SUPERSEDES"));
  assert.ok(edgeExists(view.edges, "T1", "G-B", "BLOCKS"));
  assert.ok(edgeExists(view.edges, "T2", "G-B", "BLOCKS"));
  assert.ok(!edgeExists(view.edges, "T1", "G-A", "BLOCKS"));
  assert.ok(!edgeExists(view.edges, "T2", "G-A", "BLOCKS"));
  assert.ok(edgeExists(view.edges, "G-A", "T2", "BLOCKS"));

  assert.equal(result.superseded.status, "superseded");
  assert.equal(effects.superseded, "G-A");
  assert.deepEqual(effects.blockers_rewritten, [
    { blocker: "T1", from: "G-A", to: "G-B" },
    { blocker: "T2", from: "G-A", to: "G-B" },
  ]);
  assert.deepEqual(effects.affected, ["G-A"]);
  assert.deepEqual(snapshot, before);
});

test("supersede collapses a rewrite that would duplicate a planned blocker", async () => {
  const snapshot = baseSnapshot();
  const { view, effects } = await run(
    snapshot,
    validInput({ supersedes: "G-A", blocked_by: ["T1"], if_revisions: { "G-A": 2 } }),
  );
  const blocks = view.edges.filter((e) => e.type === "BLOCKS" && e.from === "T1" && e.to === "G-B");
  assert.equal(blocks.length, 1);
  assert.ok(!edgeExists(view.edges, "T1", "G-A", "BLOCKS"));
  assert.deepEqual(effects.blockers_rewritten, []);
  assert.deepEqual(effects.blockers_collapsed, [{ blocker: "T1", from: "G-A", to: "G-B" }]);
});

test("supersede validates targets and revisions in prepare", async () => {
  const snapshot = baseSnapshot();
  const cases = [
    [validInput({ supersedes: "missing", if_revisions: { missing: 1 } }), "INVALID_EDGE_TARGET"],
    [validInput({ supersedes: "K-A", if_revisions: { "K-A": 1 } }), "INVALID_EDGE_KIND"],
    [validInput({ supersedes: "T1", if_revisions: { T1: 1 } }), "INVALID_EDGE_KIND"],
    [validInput({ supersedes: "G-B", if_revisions: { "G-B": 1 } }), "SELF_EDGE"],
    [validInput({ supersedes: "" }), "MISSING_FIELD"],
    [validInput({ supersedes: "G-A" }), "MISSING_FIELD"],
    [validInput({ supersedes: "G-A", if_revisions: { "G-A": 1 } }), "REVISION_CONFLICT"],
    [validInput({ supersedes: "G-A", if_revisions: { "G-A": 2, T1: 1 } }), "INVALID_EXECUTION_CONTRACT"],
    [validInput({ if_revisions: { T1: 1 } }), "INVALID_EXECUTION_CONTRACT"],
  ];
  for (const [input, code] of cases) {
    await assert.rejects(
      gateCreateProvider.prepare({ snapshot, input }),
      (err) => err.code === code,
      `expected ${code} for ${JSON.stringify(input)}`,
    );
  }
});

test("the provider never writes revision and rejects seeded revisions via tx", async () => {
  const snapshot = baseSnapshot();
  const plan = await gateCreateProvider.prepare({ snapshot, input: validInput({ supersedes: "G-A", if_revisions: { "G-A": 2 } }) });
  const tx = createTransaction(snapshot);
  await gateCreateProvider.apply({ tx, plan });
  const view = tx.view();
  for (const node of Object.values(view.nodes)) {
    assert.equal("revision" in node, false);
  }
  assert.equal(plan.node.revision, undefined);
});
