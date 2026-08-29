// test/provider-core-note.test.mjs — pure unit tests for the
// `note.add` core provider (T-graph-kernel-provider-core-ops).
//
// Scope:
//   - prepare is read-only; validates target existence, non-empty
//     text, and matching if_revision (single-CAS);
//   - apply appends one note (with agent from request.actor, ISO
//     timestamp) via tx.updateNode only and never touches revision
//     or any external surface;
//   - plan exposes if_revision so kernel.mutate can validate the CAS
//     under the lock;
//   - structured errors carry the canonical v2 codes
//     (MISSING_FIELD, NODE_NOT_FOUND, REVISION_CONFLICT,
//     INVALID_EXECUTION_CONTRACT).
//
// Pure: no filesystem, no lock, no state, no log, no policy, no
// command, no adapter, no CLI, no UI. Snapshots and tx stubs are
// literal JS objects.

import { test } from "node:test";
import assert from "node:assert/strict";

import { importFresh } from "./helpers.mjs";

const ACTOR = "codex-worker";

async function importNoteProvider() {
  return importFresh("../src/providers/core/note.mjs");
}

function makeSnapshot({ nodes = {}, edges = [], initiatives = { foo: { desc: "x" } }, log = [] } = {}) {
  return { version: 2, initiatives, nodes, edges, log };
}

function makeRequest({ input, action = "note.add", actor = ACTOR, if_revision } = {}) {
  const request = { action, actor, input };
  if (if_revision !== undefined) request.if_revision = if_revision;
  return request;
}

function makeTaskNode(id, { revision = 1, notes = [] } = {}) {
  return {
    id,
    kind: "resolvable",
    subkind: "task",
    title: `task ${id}`,
    initiative: "foo",
    status: "open",
    revision,
    notes,
  };
}

// makeTxStub — captures updateNode calls and serves a draft whose
// nodes mirror the seed. Mirrors src/kernel/transaction.mjs#updateNode
// so the provider's apply is exercised end-to-end without touching
// the real tx layer.
function makeTxStub({ initialNodes = {} } = {}) {
  const nodes = {};
  for (const [id, node] of Object.entries(initialNodes)) {
    const cloned = { ...node };
    delete cloned.revision;
    nodes[id] = cloned;
  }
  return {
    calls: { updateNode: [], view: 0 },
    nodes,
    getNode(id) {
      return nodes[id] ? { ...nodes[id] } : undefined;
    },
    updateNode(id, patch) {
      this.calls.updateNode.push({ id, patch });
      const cur = this.nodes[id];
      if (!cur) {
        const err = new Error(`txStub: node ${id} not found`);
        err.code = "NODE_NOT_FOUND";
        throw err;
      }
      if ("revision" in patch) {
        const err = new Error(`txStub: patch for ${id} must not carry 'revision'`);
        err.code = "INVALID_EXECUTION_CONTRACT";
        throw err;
      }
      this.nodes[id] = { ...cur, ...patch };
      delete this.nodes[id].revision;
      return { ...this.nodes[id] };
    },
    view() {
      this.calls.view += 1;
      return { nodes: { ...this.nodes }, edges: [] };
    },
  };
}

async function expectCode(fn, code) {
  try {
    await fn();
  } catch (err) {
    assert.equal(err.code, code, `expected ${code} got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected throw with code ${code}`);
}

test("note.add: prepare validates target id, text and if_revision", async () => {
  const { noteAddProvider } = await importNoteProvider();
  const snapshot = makeSnapshot({ nodes: { "T-x": makeTaskNode("T-x") } });
  await expectCode(
    () => noteAddProvider.prepare({ snapshot, input: {}, request: makeRequest({ input: {} }) }),
    "MISSING_FIELD",
  );
  await expectCode(
    () =>
      noteAddProvider.prepare({
        snapshot,
        input: { id: "T-x" },
        request: makeRequest({ input: { id: "T-x" } }),
      }),
    "MISSING_FIELD",
  );
  await expectCode(
    () =>
      noteAddProvider.prepare({
        snapshot,
        input: { id: "T-x", text: "hello" },
        request: makeRequest({ input: { id: "T-x", text: "hello" } }),
      }),
    "MISSING_FIELD",
  );
});

test("note.add: prepare rejects missing target node", async () => {
  const { noteAddProvider } = await importNoteProvider();
  const snapshot = makeSnapshot({});
  await expectCode(
    () =>
      noteAddProvider.prepare({
        snapshot,
        input: { id: "T-x", text: "hello", if_revision: 1 },
        request: makeRequest({ input: { id: "T-x", text: "hello", if_revision: 1 } }),
      }),
    "NODE_NOT_FOUND",
  );
});

test("note.add: prepare rejects mismatched if_revision", async () => {
  const { noteAddProvider } = await importNoteProvider();
  const snapshot = makeSnapshot({ nodes: { "T-x": makeTaskNode("T-x", { revision: 3 }) } });
  await expectCode(
    () =>
      noteAddProvider.prepare({
        snapshot,
        input: { id: "T-x", text: "hello", if_revision: 1 },
        request: makeRequest({ input: { id: "T-x", text: "hello", if_revision: 1 } }),
      }),
    "REVISION_CONFLICT",
  );
});

test("note.add: prepare returns frozen plan with target, if_revision, policyAction, logAction, note", async () => {
  const { noteAddProvider } = await importNoteProvider();
  const snapshot = makeSnapshot({ nodes: { "T-x": makeTaskNode("T-x", { revision: 2 }) } });
  const input = { id: "T-x", text: "hello", if_revision: 2 };
  const request = makeRequest({ input });
  const plan = await noteAddProvider.prepare({ snapshot, input, request });

  assert.equal(plan.target.id, "T-x");
  assert.equal(plan.target.revision, 2);
  assert.deepEqual(plan.if_revision, { kind: "single", id: "T-x", value: 2 });
  assert.equal(plan.policyAction.action, "note.add");
  assert.equal(plan.policyAction.pluginId, null);
  assert.equal(plan.logAction, "add-note");
  assert.equal(plan.note.agent, ACTOR);
  assert.equal(plan.note.text, "hello");
  assert.match(plan.note.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Object.isFrozen(plan), "plan must be frozen");
  assert.ok(Object.isFrozen(plan.note), "plan.note must be frozen");
});

test("note.add: apply appends note via tx.updateNode using request.actor and never carries revision", async () => {
  const { noteAddProvider } = await importNoteProvider();
  const initialNodes = { "T-x": makeTaskNode("T-x", { revision: 4 }) };
  const snapshot = makeSnapshot({ nodes: initialNodes });
  const input = { id: "T-x", text: "world", if_revision: 4 };
  const request = makeRequest({ input });
  const plan = await noteAddProvider.prepare({ snapshot, input, request });

  const tx = makeTxStub({ initialNodes });
  const result = await noteAddProvider.apply({
    tx,
    plan,
    input,
    request,
    snapshot,
  });

  assert.equal(tx.calls.updateNode.length, 1, "apply calls tx.updateNode exactly once");
  assert.equal(tx.calls.view, 0, "apply must not call tx.view");
  const call = tx.calls.updateNode[0];
  assert.equal(call.id, "T-x");
  assert.ok(Array.isArray(call.patch.notes), "patch.notes must be an array");
  assert.equal(call.patch.notes.length, 1, "patch.notes must carry exactly one new note");
  assert.equal(call.patch.notes[0].agent, ACTOR, "agent must come from request.actor");
  assert.equal(call.patch.notes[0].text, "world");
  assert.match(call.patch.notes[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(call.patch.notes[0].revision, undefined, "note must never carry revision");
  assert.equal(Object.prototype.hasOwnProperty.call(call.patch, "revision"), false, "patch must not carry revision");
  assert.equal(result.effects, null);
  assert.equal(result.result.id, "T-x");
  assert.equal(result.result.notes_count, 1);
});