// src/kernel/transaction.mjs — pure draft transaction for the graph kernel.
//
// Tests cover the B1a slice of the kernel execution plan:
//   - draft is pure: no filesystem, locks, updateState, logs, providers,
//     registry, adapters, commands, or UI imported;
//   - createTransaction(snapshot) clones the input snapshot and every return
//     value, so caller mutations cannot leak into the draft and the draft
//     cannot leak back to the caller;
//   - getNode/createNode/updateNode/addEdge/removeEdge/view compose a valid
//     in-memory draft of nodes and edges (task + edges);
//   - revision is rejected everywhere: createNode rejects it on the seed
//     node, updateNode rejects it on the patch;
//   - structural errors are surfaced as structured v2 errors with a code +
//     details payload (duplicate ids, missing nodes, self-edges, duplicate
//     edges, missing fields, invalid edge types/kinds).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTransaction } from "../src/kernel/transaction.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "src");

function baseSnapshot() {
  return {
    version: 2,
    nodes: {
      T1: {
        id: "T1",
        kind: "resolvable",
        subkind: "task",
        title: "existing task",
        initiative: "kernel",
        status: "open",
        revision: 1,
      },
      G1: {
        id: "G1",
        kind: "resolvable",
        subkind: "gate",
        title: "existing gate",
        initiative: "kernel",
        status: "open",
        revision: 2,
      },
      K1: {
        id: "K1",
        kind: "knowledge",
        title: "existing knowledge",
        initiative: "kernel",
        status: "active",
        knowledge_type: "warning",
        scope: { domains: [], initiatives: ["kernel"], tags: [], node_ids: [] },
      },
    },
    edges: [
      { from: "G1", to: "T1", type: "BLOCKS" },
    ],
    initiatives: { kernel: { desc: "kernel initiative" } },
    log: [{ ts: "2024-01-01T00:00:00.000Z", agent: "test", action: "init" }],
  };
}

async function assertNoForbiddenImports() {
  const src = await readFile(path.join(SRC_DIR, "kernel", "transaction.mjs"), "utf8");
  // Whitelist: structuredClone is a Node global (no import needed), so the
  // only allowed import surface is "../contracts/errors.mjs" for throwV2. Everything
  // else must be forbidden.
  const forbidden = [
    /\bfs\b\s*from\s+["']node:fs/,
    /\bfs\/promises\b\s*from\s+["']node:fs\/promises/,
    /\bpath\b\s*from\s+["']node:path/,
    /from\s+["'](fs|fs\/promises|path|child_process|crypto|os|stream|util|events)["']/,
    /from\s+["']\.\.?\/(state|lock|log|paths|plugin|v2|commands|ui|agent|execution-contract|kernel\/mutate)["']/,
    /from\s+["']\.\.?\/.*(providers|registry|adapters|dispatch)["']/,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(
      src,
      pattern,
      `kernel/transaction.mjs must not import forbidden module (pattern: ${pattern})`,
    );
  }
  // The draft may import pure contracts, but must stay decoupled from
  // storage, adapters, providers, and mutation orchestration.
  assert.match(src, /from\s+["']\.\.\/contracts\/errors\.mjs["']/, "kernel/transaction.mjs must import throwV2 from ../contracts/errors.mjs");
  assert.match(src, /from\s+["']\.\.\/contracts\/state-invariants\.mjs["']/, "kernel/transaction.mjs must import shared state invariants");
  const relativeImports = [...src.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)].map((m) => m[1]);
  for (const imp of relativeImports) {
    assert.ok(
      ["../contracts/errors.mjs", "../contracts/state-invariants.mjs"].includes(imp),
      `kernel/transaction.mjs must only import pure contracts; got ${imp}`,
    );
  }
}

test("createTransaction: clones snapshot on entry (and strips revision)", () => {
  const snapshot = baseSnapshot();
  const tx = createTransaction(snapshot);

  // The draft should be a deep clone of the snapshot's nodes and edges, not
  // the same references. This guarantees the kernel can never mutate the
  // caller's snapshot by accident.
  assert.notEqual(tx.view().nodes, snapshot.nodes);
  assert.notEqual(tx.view().edges, snapshot.edges);
  // Draft nodes are the "post-apply shape" the kernel will persist, so they
  // carry no `revision` field — revisions are assigned once per node per
  // apply in B1b. The expected draft therefore equals the snapshot minus
  // the revision field on each node.
  const expectedNodes = {};
  for (const [id, node] of Object.entries(snapshot.nodes)) {
    const { revision: _rev, ...rest } = node;
    expectedNodes[id] = rest;
  }
  assert.deepEqual(tx.view().nodes, expectedNodes);
  assert.deepEqual(tx.view().edges, snapshot.edges);

  // Mutating the original snapshot after createTransaction must not change
  // the draft. The kernel reads the snapshot once and forgets the reference.
  snapshot.nodes.T1.title = "tampered";
  snapshot.nodes.TNEW = { id: "TNEW", kind: "resolvable", subkind: "task", title: "leak", status: "open" };
  snapshot.edges.push({ from: "TNEW", to: "T1", type: "BLOCKS" });
  assert.equal(tx.getNode("T1").title, "existing task");
  assert.equal(tx.getNode("TNEW"), undefined);
  assert.equal(tx.view().edges.length, 1);
});

test("createTransaction: each accessor returns a cloned node", () => {
  const tx = createTransaction(baseSnapshot());
  const a = tx.getNode("T1");
  const b = tx.getNode("T1");
  assert.deepEqual(a, b);
  assert.notEqual(a, b, "getNode must clone to prevent draft pollution");
  a.title = "tampered";
  assert.equal(tx.getNode("T1").title, "existing task");
});

test("view: returns cloned snapshot of nodes + edges + initiatives", () => {
  const tx = createTransaction(baseSnapshot());
  const v1 = tx.view();
  const v2 = tx.view();
  assert.notEqual(v1.nodes, v2.nodes);
  assert.notEqual(v1.edges, v2.edges);
  assert.notEqual(v1.initiatives, v2.initiatives);
  assert.deepEqual(Object.keys(v1).sort(), ["edges", "initiatives", "nodes"]);
  // log and version are NOT part of the draft envelope; initiatives are
  // (kernel responsibility covers the in-memory mutation of nodes,
  // edges, and initiatives).
  assert.equal(v1.log, undefined);
  assert.ok(v1.initiatives, "view must surface initiatives from the snapshot");
  assert.equal(v1.initiatives.kernel.desc, "kernel initiative");
});

test("createNode: registers a new node without revision", () => {
  const tx = createTransaction(baseSnapshot());
  const input = {
    id: "T-new",
    kind: "resolvable",
    subkind: "task",
    title: "new task",
    initiative: "kernel",
    status: "open",
  };
  const returned = tx.createNode(input);
  assert.equal(returned.id, "T-new");
  assert.equal(returned.revision, undefined, "kernel must not assign revision");

  // The draft should now contain the new node and a deep-cloned return value
  // (no shared references with the caller's input).
  assert.notEqual(returned, input);
  assert.deepEqual(tx.getNode("T-new"), { ...input });
});

test("createNode: rejects nodes carrying revision", () => {
  const tx = createTransaction(baseSnapshot());
  let caught;
  try {
    tx.createNode({
      id: "T-bad",
      kind: "resolvable",
      subkind: "task",
      title: "carries revision",
      status: "open",
      revision: 7,
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "createNode must throw when revision is present");
  assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
  assert.equal(caught.details.field, "revision");
  // The draft must not contain the rejected node.
  assert.equal(tx.getNode("T-bad"), undefined);
});

test("createNode: rejects duplicate ids (against snapshot and draft)", () => {
  const tx = createTransaction(baseSnapshot());
  let caught;
  try {
    tx.createNode({
      id: "T1",
      kind: "resolvable",
      subkind: "task",
      title: "collision with snapshot",
      status: "open",
    });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, "ID_CONFLICT");
  assert.equal(caught.details.id, "T1");

  // After a successful createNode, another createNode with the same id must
  // also be rejected (collision within the draft itself).
  tx.createNode({
    id: "T-first",
    kind: "resolvable",
    subkind: "task",
    title: "first",
    status: "open",
  });
  let caught2;
  try {
    tx.createNode({
      id: "T-first",
      kind: "resolvable",
      subkind: "task",
      title: "second",
      status: "open",
    });
  } catch (err) {
    caught2 = err;
  }
  assert.equal(caught2.code, "ID_CONFLICT");
  assert.equal(caught2.details.id, "T-first");
});

test("createNode: rejects missing required fields (id, kind)", () => {
  const tx = createTransaction(baseSnapshot());
  assert.throws(() => tx.createNode({ kind: "resolvable", title: "no id" }), (err) => err.code === "MISSING_FIELD" && err.details.field === "id");
  assert.throws(() => tx.createNode({ id: "no-kind", title: "no kind" }), (err) => err.code === "MISSING_FIELD" && err.details.field === "kind");
});

test("updateNode: applies a patch without revision", () => {
  const tx = createTransaction(baseSnapshot());
  const updated = tx.updateNode("T1", { title: "renamed", tags: ["alpha"] });
  assert.equal(updated.id, "T1");
  assert.equal(updated.title, "renamed");
  assert.deepEqual(updated.tags, ["alpha"]);
  // Draft nodes do NOT carry revision: the kernel diff (B1b) compares
  // snapshot vs. draft ignoring revision and assigns revision once per
  // apply. updateNode must therefore strip revision from the merged draft
  // node so the post-apply diff is unambiguous.
  assert.equal(updated.revision, undefined);
  assert.equal(tx.getNode("T1").title, "renamed");
  assert.equal(tx.getNode("T1").revision, undefined);
});

test("updateNode: rejects patches that carry revision", () => {
  const tx = createTransaction(baseSnapshot());
  let caught;
  try {
    tx.updateNode("T1", { status: "in_progress", revision: 99 });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
  assert.equal(caught.details.field, "revision");
  // The patch must not have been applied.
  assert.equal(tx.getNode("T1").status, "open");
  // revision is intentionally not preserved on draft nodes.
  assert.equal(tx.getNode("T1").revision, undefined);
});

test("updateNode: rejects missing target ids (snapshot + draft)", () => {
  const tx = createTransaction(baseSnapshot());
  let caught;
  try {
    tx.updateNode("T-does-not-exist", { title: "x" });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, "NODE_NOT_FOUND");
  assert.equal(caught.details.id, "T-does-not-exist");

  // A node created in the same draft must also be updatable (kernel
  // semantics: the draft is the only authoritative view during apply).
  tx.createNode({ id: "T-mid", kind: "resolvable", subkind: "task", title: "mid", status: "open" });
  const updated = tx.updateNode("T-mid", { title: "mid-renamed" });
  assert.equal(updated.title, "mid-renamed");
});

test("addEdge: rejects a BLOCKS edge that closes a cycle", () => {
  const tx = createTransaction({
    ...baseSnapshot(),
    edges: [{ from: "G1", to: "T1", type: "BLOCKS" }],
  });
  assert.throws(
    () => tx.addEdge({ from: "T1", to: "G1", type: "BLOCKS" }),
    (err) => err.code === "CYCLE_DETECTED",
  );
});

test("addEdge: accepts a valid edge against snapshot + draft nodes", () => {
  const tx = createTransaction(baseSnapshot());
  tx.createNode({ id: "T-new", kind: "resolvable", subkind: "task", title: "new", status: "open" });
  const edge = tx.addEdge({ from: "T1", to: "T-new", type: "BLOCKS" });
  assert.deepEqual(edge, { from: "T1", to: "T-new", type: "BLOCKS" });
  assert.equal(tx.view().edges.length, 2);
});

test("addEdge: rejects self-edges", () => {
  const tx = createTransaction(baseSnapshot());
  let caught;
  try {
    tx.addEdge({ from: "T1", to: "T1", type: "BLOCKS" });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, "SELF_EDGE");
  assert.equal(caught.details.from, "T1");
  assert.equal(caught.details.to, "T1");
});

test("addEdge: rejects missing fields and invalid edge types/kinds", () => {
  const tx = createTransaction(baseSnapshot());
  // Missing fields.
  assert.throws(() => tx.addEdge({ to: "T1", type: "BLOCKS" }), (err) => err.code === "MISSING_FIELD" && err.details.field === "from");
  assert.throws(() => tx.addEdge({ from: "T1", type: "BLOCKS" }), (err) => err.code === "MISSING_FIELD" && err.details.field === "to");
  assert.throws(() => tx.addEdge({ from: "T1", to: "T-new" }), (err) => err.code === "MISSING_FIELD" && err.details.field === "type");
  // Unknown type.
  let caught;
  try {
    tx.addEdge({ from: "T1", to: "T1", type: "RELATES_TO" });
  } catch (err) {
    caught = err;
  }
  // SELF_EDGE is checked before type; use distinct endpoints for the type check.
  assert.equal(caught.code, "SELF_EDGE");
  try {
    tx.addEdge({ from: "T1", to: "G1", type: "WHATEVER" });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, "INVALID_EDGE_TYPE");
  assert.deepEqual(caught.details.allowed, ["BLOCKS", "SUPERSEDES", "DERIVED_FROM"]);

  // BLOCKS requires both ends resolvable (K1 is knowledge).
  try {
    tx.addEdge({ from: "T1", to: "K1", type: "BLOCKS" });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, "INVALID_EDGE_KIND");
  assert.equal(caught.details.fromKind, "resolvable");
  assert.equal(caught.details.toKind, "knowledge");

  // SUPERSEDES requires both ends of the same kind (T1 task, G1 gate).
  try {
    tx.addEdge({ from: "T1", to: "G1", type: "SUPERSEDES" });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, "INVALID_EDGE_KIND");
});

test("addEdge: rejects edges targeting unknown nodes", () => {
  const tx = createTransaction(baseSnapshot());
  let caught;
  try {
    tx.addEdge({ from: "T1", to: "T-missing", type: "BLOCKS" });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, "INVALID_EDGE_TARGET");
  assert.equal(caught.details.missing, "T-missing");

  try {
    tx.addEdge({ from: "T-missing", to: "T1", type: "BLOCKS" });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, "INVALID_EDGE_TARGET");
  assert.equal(caught.details.missing, "T-missing");
});

test("addEdge: rejects duplicates against snapshot and draft", () => {
  const tx = createTransaction(baseSnapshot());
  // Duplicate against snapshot edge {G1, T1, BLOCKS}.
  let caught;
  try {
    tx.addEdge({ from: "G1", to: "T1", type: "BLOCKS" });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, "DUPLICATE_EDGE");
  // Duplicate within the draft itself.
  tx.addEdge({ from: "T1", to: "G1", type: "DERIVED_FROM" });
  try {
    tx.addEdge({ from: "T1", to: "G1", type: "DERIVED_FROM" });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, "DUPLICATE_EDGE");
});

test("removeEdge: removes a matching edge from snapshot or draft", () => {
  const tx = createTransaction(baseSnapshot());
  // Snapshot edge {G1, T1, BLOCKS} present.
  const removed = tx.removeEdge({ from: "G1", to: "T1", type: "BLOCKS" });
  assert.deepEqual(removed, { from: "G1", to: "T1", type: "BLOCKS" });
  assert.equal(tx.view().edges.length, 0);

  // re-adding then removing from draft.
  tx.addEdge({ from: "T1", to: "G1", type: "BLOCKS" });
  tx.removeEdge({ from: "T1", to: "G1", type: "BLOCKS" });
  assert.equal(tx.view().edges.length, 0);
});

test("removeEdge: rejects when no matching edge exists", () => {
  const tx = createTransaction(baseSnapshot());
  let caught;
  try {
    tx.removeEdge({ from: "T1", to: "G1", type: "BLOCKS" });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "removeEdge must throw when the predicate does not match");
  // structured: code + details + same fields the caller passed in.
  assert.equal(typeof caught.code, "string");
  assert.equal(typeof caught.message, "string");
  assert.ok(caught.details);
});

test("end-to-end: task + edges composition in memory", () => {
  const tx = createTransaction(baseSnapshot());
  // Compose a brand-new sub-DAG: T-A blocks T-B, T-B blocks T-C.
  tx.createNode({ id: "T-A", kind: "resolvable", subkind: "task", title: "A", initiative: "kernel", status: "open" });
  tx.createNode({ id: "T-B", kind: "resolvable", subkind: "task", title: "B", initiative: "kernel", status: "open" });
  tx.createNode({ id: "T-C", kind: "resolvable", subkind: "task", title: "C", initiative: "kernel", status: "open" });
  tx.addEdge({ from: "T-A", to: "T-B", type: "BLOCKS" });
  tx.addEdge({ from: "T-B", to: "T-C", type: "BLOCKS" });
  tx.updateNode("T-A", { status: "in_progress" });

  const view = tx.view();
  assert.equal(view.nodes["T-A"].status, "in_progress");
  assert.equal(view.nodes["T-B"].status, "open");
  assert.equal(view.nodes["T-C"].status, "open");
  assert.ok(view.edges.some((e) => e.from === "T-A" && e.to === "T-B" && e.type === "BLOCKS"));
  assert.ok(view.edges.some((e) => e.from === "T-B" && e.to === "T-C" && e.type === "BLOCKS"));
  // Original snapshot edge must still be there (no side-effects on removed state).
  assert.ok(view.edges.some((e) => e.from === "G1" && e.to === "T1" && e.type === "BLOCKS"));
});

test("isolation: mutating view() result does not affect the draft", () => {
  const tx = createTransaction(baseSnapshot());
  const view = tx.view();
  view.nodes.T1.title = "tampered via view";
  view.edges.push({ from: "T1", to: "T1", type: "BLOCKS" });
  view.nodes["T-leak"] = { id: "T-leak", kind: "resolvable", subkind: "task", title: "leak", status: "open" };

  const fresh = tx.view();
  assert.equal(fresh.nodes.T1.title, "existing task");
  assert.equal(fresh.edges.length, 1);
  assert.equal(fresh.nodes["T-leak"], undefined);
});

test("isolation: inputs to createNode/updateNode/addEdge are not mutated by the kernel", () => {
  const tx = createTransaction(baseSnapshot());
  const createInput = { id: "T-iso", kind: "resolvable", subkind: "task", title: "iso", status: "open" };
  const createSnapshot = JSON.parse(JSON.stringify(createInput));
  tx.createNode(createInput);
  assert.deepEqual(createInput, createSnapshot);

  const patchInput = { title: "patched" };
  const patchSnapshot = JSON.parse(JSON.stringify(patchInput));
  tx.updateNode("T1", patchInput);
  assert.deepEqual(patchInput, patchSnapshot);

  const edgeInput = { from: "T1", to: "T-iso", type: "BLOCKS" };
  const edgeSnapshot = JSON.parse(JSON.stringify(edgeInput));
  tx.addEdge(edgeInput);
  assert.deepEqual(edgeInput, edgeSnapshot);
});

test("kernel contract: kernel module has no side-effecting imports", async () => {
  await assertNoForbiddenImports();
});
