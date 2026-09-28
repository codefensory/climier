// Knowledge deprecate contract tests for the knowledge-core provider slice
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

// deprecate provider — prepare / apply via kernel.mutate
// (plan B4-knowledge-lifecycle)

async function deprecateKnowledgeWithSearch(provider, mutate, dir) {
  const base = emptySnapshot({
    nodes: {
      "K-active": knowledgeNode("K-active", { title: "shared active", body: "shared body" }),
      "K-old": knowledgeNode("K-old", { title: "shared deprecated", body: "shared body" }),
    },
  });
  await writeFencedState(dir, base);
  await mutate({
    projectDir: dir,
    request: {
      action: "knowledge.deprecate",
      actor: "alice",
      input: { id: "K-old", reason: "obsolete" },
    },
    provider,
  });
  return readStateHelper(dir);
}

function assertDeprecationSearch(providerResult, searchKnowledge) {
  const activeSearch = searchKnowledge({ snapshot: providerResult, query: "shared" });
  const allSearch = searchKnowledge({ snapshot: providerResult, query: "shared", all: true });
  assertVisibleDeprecationResults(activeSearch, allSearch);
  assert.equal(providerResult.nodes["K-old"].status, "deprecated");
}

function assertVisibleDeprecationResults(activeSearch, allSearch) {
  assert.deepEqual(activeSearch.matches.map(({ id }) => id), ["K-active"], "deprecated hidden by default");
  assert.deepEqual(
    allSearch.matches.map(({ id }) => id),
    ["K-active", "K-old"].toSorted(),
    "deprecated included when all=true",
  );
}

function assertDeprecationLog(log) {
  assert.equal(log.length, 1);
  assert.equal(log[0].action, "knowledge.deprecate");
  assert.equal(log[0].agent, "alice");
  assert.equal(log[0].node, "K-1");
  assert.equal(log[0].revision, 6);

  assert.equal(log[0].reason, undefined);
}

function assertDeprecatedKnowledgeNode(node) {
  assert.equal(node.status, "deprecated");
  assert.equal(node.deprecation_reason, "superseded by v2 endpoint");
  assert.equal(node.deprecated_by, "alice");
  assert.equal(typeof node.deprecated_at, "string");
  assert.ok(!Number.isNaN(Date.parse(node.deprecated_at)), "deprecated_at is ISO 8601");
}

function assertPreservedKnowledgeFields(node) {
  assert.equal(node.title, "old title");
  assert.equal(node.body, "old body");
  assert.equal(node.knowledge_type, "warning");
  assert.deepEqual(node.scope, {
    domains: ["auth"],
    initiatives: ["platform"],
    tags: ["ops"],
    node_ids: [],
  });
  assert.equal(node.domain, "auth");
  assert.deepEqual(node.tags, ["ops"]);
  assert.deepEqual(node.refs, [{ type: "external", target: "docs/x.md" }]);
}

test("deprecate: prepare rejects missing id", async () => {
  const { deprecateProvider } = await importProviders();
  const provider = deprecateProvider();
  await assert.rejects(
    provider.prepare({
      snapshot: emptySnapshot(),
      input: { reason: "outdated" },
      request: { action: "knowledge.deprecate", actor: "alice" },
    }),
    (err) => err.code === "MISSING_FIELD" && /id/.test(err.message),
  );
});

test("deprecate: prepare rejects missing reason", async () => {
  const { deprecateProvider } = await importProviders();
  const provider = deprecateProvider();
  await assert.rejects(
    provider.prepare({
      snapshot: emptySnapshot(),
      input: { id: "K-1" },
      request: { action: "knowledge.deprecate", actor: "alice" },
    }),
    (err) => err.code === "MISSING_FIELD" && /reason/.test(err.message),
  );
});

test("deprecate: prepare rejects non-knowledge target", async () => {
  const { deprecateProvider } = await importProviders();
  const provider = deprecateProvider();
  const snapshot = emptySnapshot({
    nodes: { "T-a": taskNode("T-a") },
  });
  await assert.rejects(
    provider.prepare({
      snapshot,
      input: { id: "T-a", reason: "outdated" },
      request: { action: "knowledge.deprecate", actor: "alice" },
    }),
    (err) => err.code === "INVALID_PROVIDER_INPUT" && /knowledge/.test(err.message),
  );
});

test("deprecate: prepare rejects unknown target with NODE_NOT_FOUND", async () => {
  const { deprecateProvider } = await importProviders();
  const provider = deprecateProvider();
  await assert.rejects(
    provider.prepare({
      snapshot: emptySnapshot(),
      input: { id: "ghost", reason: "outdated" },
      request: { action: "knowledge.deprecate", actor: "alice" },
    }),
    (err) => err.code === "NODE_NOT_FOUND",
  );
});

test("deprecate: prepare returns the current revision as if_revision (single)", async () => {
  const { deprecateProvider } = await importProviders();
  const provider = deprecateProvider();
  const snapshot = emptySnapshot({
    nodes: { "K-1": knowledgeNode("K-1", { revision: 7 }) },
  });
  const plan = await provider.prepare({
    snapshot,
    input: { id: "K-1", reason: "outdated" },
    request: { action: "knowledge.deprecate", actor: "alice" },
  });
  assert.deepEqual(plan.target, { id: "K-1", kind: "knowledge", revision: 7 });
  assert.deepEqual(plan.if_revision, { kind: "single", id: "K-1", value: 7 });
  assert.equal(plan.idempotent, false);
  assert.equal(plan.reason, "outdated");
  assert.equal(plan.actor, "alice");
  assert.deepEqual(plan.policyAction, { action: "knowledge.deprecate" });
});

async function applyDeprecationWithDetails(provider, mutate, dir) {
  const base = emptySnapshot({
    nodes: {
      "K-1": knowledgeNode("K-1", {
        revision: 4,
        title: "old title",
        body: "old body",
        knowledge_type: "warning",
        scope: { domains: ["auth"], initiatives: ["platform"], tags: ["ops"], node_ids: [] },
        domain: "auth",
        tags: ["ops"],
        refs: [{ type: "external", target: "docs/x.md" }],
      }),
    },
  });
  await writeFencedState(dir, base);
  const out = await mutate({
    projectDir: dir,
    request: {
      action: "knowledge.deprecate",
      actor: "alice",
      input: { id: "K-1", reason: "superseded by v2 endpoint" },
    },
    provider,
  });
  return { out, after: await readStateHelper(dir) };
}

test("deprecate: apply preserves scope, status, reason, deprecated_at/by via kernel.mutate", async () => {
  const { deprecateProvider } = await importProviders();
  const { mutate } = await importKernel();
  const provider = deprecateProvider();
  const dir = await createTempProject();
  try {
    const { out, after } = await applyDeprecationWithDetails(provider, mutate, dir);
    assert.equal(out.idempotent, false, "deprecate is never idempotent (records a new event)");
    assert.equal(out.diff.updated.length, 1);
    assert.equal(out.diff.updated[0].id, "K-1");
    assert.equal(out.diff.updated[0].node.revision, 6, "kernel advances beyond the fenced fixture high-water");

    const node = after.nodes["K-1"];
    assertDeprecatedKnowledgeNode(node);
    assertPreservedKnowledgeFields(node);
    assertDeprecationLog(after.log);
  } finally {
    await rmTempProject(dir);
  }
});

test("deprecate: deprecated node is hidden from default search and visible with all=true", async () => {
  const { deprecateProvider, searchKnowledge } = await importProviders();
  const { mutate } = await importKernel();
  const provider = deprecateProvider();
  const dir = await createTempProject();
  try {
    const after = await deprecateKnowledgeWithSearch(provider, mutate, dir);
    assertDeprecationSearch(after, searchKnowledge);
  } finally {
    await rmTempProject(dir);
  }
});

test("deprecate: prepare is read-only (does not mutate the snapshot object)", async () => {
  const { deprecateProvider } = await importProviders();
  const provider = deprecateProvider();
  const snapshot = emptySnapshot({
    nodes: { "K-1": knowledgeNode("K-1", { revision: 2, scope: { domains: ["auth"] } }) },
  });
  const snapshotBefore = JSON.parse(JSON.stringify(snapshot));
  await provider.prepare({
    snapshot,
    input: { id: "K-1", reason: "obsolete" },
    request: { action: "knowledge.deprecate", actor: "alice" },
  });
  assert.deepEqual(snapshot, snapshotBefore, "prepare must not mutate the snapshot");
});

test("deprecate: apply uses tx only (does not leak the snapshot after kernel mutation)", async () => {
  const { deprecateProvider } = await importProviders();
  const { mutate } = await importKernel();
  const provider = deprecateProvider();
  const dir = await createTempProject();
  try {
    const base = emptySnapshot({
      nodes: { "K-1": knowledgeNode("K-1", { revision: 3, scope: { domains: ["auth"] } }) },
    });
    await writeFencedState(dir, base);
    const before = await readStateHelper(dir);
    const expectedTitle = before.nodes["K-1"].title;
    const expectedScope = JSON.parse(JSON.stringify(before.nodes["K-1"].scope));
    await mutate({
      projectDir: dir,
      request: {
        action: "knowledge.deprecate",
        actor: "alice",
        input: { id: "K-1", reason: "obsolete" },
      },
      provider,
    });
    // The reference returned by `before` must not have flipped status:

    // object we held. This guards against accidental snapshot leakage
    // in the provider (which only ever touches the draft).
    assert.equal(before.nodes["K-1"].status, "active");
    assert.equal(before.nodes["K-1"].title, expectedTitle);
    assert.deepEqual(before.nodes["K-1"].scope, expectedScope);
    const after = await readStateHelper(dir);
    assert.equal(after.nodes["K-1"].status, "deprecated");
  } finally {
    await rmTempProject(dir);
  }
});

test("deprecate: provider never seeds revision through tx.updateNode", async () => {
  const { deprecateProvider } = await importProviders();
  const provider = deprecateProvider();
  const snapshot = emptySnapshot({
    nodes: { "K-1": knowledgeNode("K-1", { revision: 1 }) },
  });
  // 1. The transaction layer rejects any caller (including the
  // provider) that tries to seed `revision`. The reject is synchronous,
  // so we wrap the call so assert.rejects can resolve it.
  const { createTransaction } = await importFresh("../src/kernel/transaction.mjs");
  const tx = createTransaction(snapshot);
  await assert.rejects(
    Promise.resolve().then(() => tx.updateNode("K-1", {
      status: "deprecated",
      deprecation_reason: "obsolete",
      deprecated_at: "2026-01-01T00:00:00.000Z",
      deprecated_by: "alice",
      revision: 999,
    })),
    (err) => err.code === "INVALID_EXECUTION_CONTRACT",
  );
  // 2. The real provider's apply never tries to seed revision either.
  // Run it against a fresh tx and inspect the resulting draft.
  const realTx = createTransaction(snapshot);
  await provider.apply({
    tx: realTx,
    plan: {
      target: { id: "K-1", kind: "knowledge" },
      if_revision: { kind: "single", id: "K-1", value: 1 },
      reason: "obsolete",
      actor: "alice",
      policyAction: { action: "knowledge.deprecate" },
    },
  });
  const view = realTx.view();
  const node = view.nodes["K-1"];
  assert.ok(!("revision" in node) || node.revision === undefined, "draft strips revision");
  assert.equal(node.status, "deprecated");
  assert.equal(node.deprecation_reason, "obsolete");
  assert.equal(node.deprecated_by, "alice");
});
