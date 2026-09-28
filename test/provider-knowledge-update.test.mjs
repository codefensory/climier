// Knowledge update contract tests for the knowledge-core provider slice
// (plan B4-knowledge-core).
//

//   - helpers puros: scope_matches, ranking determinista, búsqueda
//     activa/todas, informing.
//   - providers create/update con prepare/apply, sin fs / lock / state / log.
//   - tests cubren scopes, orden, búsquedas, errors y aislamiento tx.
//   - `kernel.mutate` se ejecuta con `state + log` en una sola escritura.
//   - ningún path fuera del allow-list cambia.

import { test } from "node:test";
import assert from "node:assert/strict";

import { emptySnapshot, importKernel, importProviders, knowledgeNode, taskNode } from "./provider-knowledge/fixtures.mjs";
import { importFresh } from "./helpers.mjs";

import {
  createTempProject,
  rmTempProject,
  writeFencedState,
  readState as readStateHelper,
} from "./helpers.mjs";

// Pure imports (no fs) — re-imported per test for freshness.

// State fixtures (pure, JSON-shaped)

// update provider — prepare / apply via kernel.mutate

async function applyKnowledgeUpdate(provider, mutate, dir) {
  const base = emptySnapshot({
    nodes: {
      "K-1": knowledgeNode("K-1", {
        revision: 2, title: "old", body: "old body", mitigation: "old m",
        scope: { domains: ["auth"] },
      }),
    },
  });
  await writeFencedState(dir, base);
  const out = await mutate({
    projectDir: dir,
    request: { action: "knowledge.update", actor: "alice", input: {
      id: "K-1", changes: {
        title: "new", body: "new body", mitigation: "new m",
        scope: { domains: ["auth", "billing"], tags: ["ops"] },
      },
    } },
    provider,
  });
  return { out, after: await readStateHelper(dir) };
}

function assertUpdatedKnowledgeState(after) {
  assert.equal(after.nodes["K-1"].title, "new");
  assert.equal(after.nodes["K-1"].body, "new body");
  assert.equal(after.nodes["K-1"].mitigation, "new m");
  assert.deepEqual(after.nodes["K-1"].scope, {
    domains: ["auth", "billing"], tags: ["ops"], initiatives: [], node_ids: [],
  });
  assert.equal(after.log.length, 1);
  assert.equal(after.log[0].action, "knowledge.update");
  assert.equal(after.log[0].revision, 4);
}

test("update: prepare rejects missing id", async () => {
  const { updateProvider } = await importProviders();
  const provider = updateProvider();
  await assert.rejects(
    provider.prepare({
      snapshot: emptySnapshot(),
      input: { changes: { title: "v2" } },
      request: { action: "knowledge.update", actor: "alice" },
    }),
    (err) => err.code === "MISSING_FIELD" && /id/.test(err.message),
  );
});

test("update: prepare rejects missing changes", async () => {
  const { updateProvider } = await importProviders();
  const provider = updateProvider();
  const snapshot = emptySnapshot({ nodes: { "K-1": knowledgeNode("K-1") } });
  await assert.rejects(
    provider.prepare({
      snapshot,
      input: { id: "K-1" },
      request: { action: "knowledge.update", actor: "alice" },
    }),
    (err) => err.code === "MISSING_FIELD" && /changes/.test(err.message),
  );
});

test("update: prepare rejects unknown target with NODE_NOT_FOUND", async () => {
  const { updateProvider } = await importProviders();
  const provider = updateProvider();
  await assert.rejects(
    provider.prepare({
      snapshot: emptySnapshot(),
      input: { id: "ghost", changes: { title: "v2" } },
      request: { action: "knowledge.update", actor: "alice" },
    }),
    (err) => err.code === "NODE_NOT_FOUND",
  );
});

test("update: prepare rejects updating a non-knowledge node", async () => {
  const { updateProvider } = await importProviders();
  const provider = updateProvider();
  const snapshot = emptySnapshot({ nodes: { "T-a": taskNode("T-a") } });
  await assert.rejects(
    provider.prepare({
      snapshot,
      input: { id: "T-a", changes: { title: "v2" } },
      request: { action: "knowledge.update", actor: "alice" },
    }),
    (err) => err.code === "INVALID_PROVIDER_INPUT" && /knowledge/.test(err.message),
  );
});

test("update: prepare rejects empty changes", async () => {
  const { updateProvider } = await importProviders();
  const provider = updateProvider();
  const snapshot = emptySnapshot({ nodes: { "K-1": knowledgeNode("K-1") } });
  await assert.rejects(
    provider.prepare({
      snapshot,
      input: { id: "K-1", changes: {} },
      request: { action: "knowledge.update", actor: "alice" },
    }),
    (err) => err.code === "MISSING_FIELD",
  );
});

test("update: prepare rejects unknown knowledge_type / status", async () => {
  const { updateProvider } = await importProviders();
  const provider = updateProvider();
  const snapshot = emptySnapshot({ nodes: { "K-1": knowledgeNode("K-1") } });
  await assert.rejects(
    provider.prepare({
      snapshot,
      input: { id: "K-1", changes: { knowledge_type: "bogus" } },
      request: { action: "knowledge.update", actor: "alice" },
    }),
    (err) => err.code === "INVALID_PROVIDER_INPUT" && /knowledge_type/.test(err.message),
  );
  await assert.rejects(
    provider.prepare({
      snapshot,
      input: { id: "K-1", changes: { status: "weird" } },
      request: { action: "knowledge.update", actor: "alice" },
    }),
    (err) => err.code === "INVALID_PROVIDER_INPUT" && /status/.test(err.message),
  );
});

test("update: prepare returns the current revision as if_revision (single)", async () => {
  const { updateProvider } = await importProviders();
  const provider = updateProvider();
  const snapshot = emptySnapshot({
    nodes: { "K-1": knowledgeNode("K-1", { revision: 7 }) },
  });
  const plan = await provider.prepare({
    snapshot,
    input: { id: "K-1", changes: { title: "v2" } },
    request: { action: "knowledge.update", actor: "alice" },
  });
  assert.deepEqual(plan.target, { id: "K-1", kind: "knowledge", revision: 7 });
  assert.deepEqual(plan.if_revision, { kind: "single", id: "K-1", value: 7 });
});

test("update: apply patches title/body/mitigation/scope via tx", async () => {
  const { updateProvider } = await importProviders();
  const { mutate } = await importKernel();
  const provider = updateProvider();
  const dir = await createTempProject();
  try {
    const { out, after } = await applyKnowledgeUpdate(provider, mutate, dir);
    assert.equal(out.idempotent, false);
    assert.equal(out.diff.updated.length, 1);
    assert.equal(out.diff.updated[0].id, "K-1");
    assert.equal(out.diff.updated[0].node.revision, 4, "kernel advances beyond the fenced fixture high-water");
    assertUpdatedKnowledgeState(after);
  } finally {
    await rmTempProject(dir);
  }
});

test("update: idempotent patch (no actual change) skips write and log", async () => {
  const { updateProvider } = await importProviders();
  const { mutate } = await importKernel();
  const provider = updateProvider();
  const dir = await createTempProject();
  try {
    const base = emptySnapshot({
      nodes: { "K-1": knowledgeNode("K-1", { revision: 1, title: "same", body: "b" }) },
    });
    await writeFencedState(dir, base);
    const out = await mutate({
      projectDir: dir,
      request: { action: "knowledge.update", actor: "alice", input: {
        id: "K-1", changes: { title: "same" },
      } },
      provider,
    });
    assert.equal(out.idempotent, true);
    assert.equal(out.log_entry, null);
    const after = await readStateHelper(dir);
    assert.equal(after.log.length, 0);
    assert.equal(after.nodes["K-1"].revision, 2, "fenced fixture revision remains unchanged on idempotent update");
  } finally {
    await rmTempProject(dir);
  }
});

test("update: provider never seeds revision through tx.updateNode", async () => {
  const { updateProvider } = await importProviders();
  const provider = updateProvider();
  const snapshot = emptySnapshot({
    nodes: { "K-1": knowledgeNode("K-1", { revision: 1 }) },
  });
  await assert.rejects(
    provider.apply({
      tx: importFresh("../src/kernel/transaction.mjs").then(({ createTransaction }) =>
        createTransaction(snapshot),
      ),
      plan: { target: { id: "K-1", kind: "knowledge" }, if_revision: { kind: "single", id: "K-1", value: 1 } },
      input: { id: "K-1", changes: { title: "new" } },
      request: { action: "knowledge.update", actor: "alice" },
      snapshot,
    }),
    (err) => err.code === "INVALID_EXECUTION_CONTRACT",
  );
});
