// test/provider-knowledge.test.mjs — pure + integration tests for the
// knowledge-core provider slice (plan B4-knowledge-core).
//
// Scope (mirrors the task body and acceptance):
//   - helpers puros: scope_matches, ranking determinista, búsqueda
//     activa/todas, informing.
//   - providers create/update con prepare/apply, sin fs / lock / state / log.
//   - tests cubren scopes, orden, búsquedas, errors y aislamiento tx.
//   - `kernel.mutate` se ejecuta con `state + log` en una sola escritura.
//   - ningún path fuera del allow-list cambia.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createTempProject,
  rmTempProject,
  importFresh,
  writeState as writeStateHelper,
  readState as readStateHelper,
} from "./helpers.mjs";

// ===================================================================
// Pure imports (no fs) — re-imported per test for freshness.
// ===================================================================

async function importProviders() {
  return importFresh("../src/providers/knowledge/index.mjs");
}

async function importKernel() {
  return importFresh("../src/kernel/mutate.mjs");
}

// ===================================================================
// State fixtures (pure, JSON-shaped)
// ===================================================================

function emptySnapshot(extra = {}) {
  return {
    version: 2,
    initiatives: { auth: { desc: "auth", created_at: "2026-01-01T00:00:00.000Z" } },
    nodes: {},
    edges: [],
    log: [],
    ...extra,
  };
}

function knowledgeNode(id, overrides = {}) {
  return {
    id,
    kind: "knowledge",
    title: `title for ${id}`,
    body: `body for ${id}`,
    initiative: "auth",
    status: "active",
    knowledge_type: "warning",
    revision: 1,
    scope: {},
    ...overrides,
  };
}

function taskNode(id, overrides = {}) {
  return {
    id,
    kind: "resolvable",
    subkind: "task",
    title: `task ${id}`,
    initiative: "auth",
    status: "open",
    revision: 1,
    domain: "auth",
    tags: ["backend"],
    ...overrides,
  };
}

// ===================================================================
// scope_matches — matchesScopes / SCOPE_ORDER
// ===================================================================

test("scope_matches: node_id is the highest-priority scope", async () => {
  const { matchesScopes, SCOPE_ORDER } = await importProviders();
  const node = { id: "T-a" };
  const k = { scope: { node_ids: ["T-a"] } };
  assert.deepEqual(matchesScopes(node, k), ["node_id"]);
  assert.deepEqual(SCOPE_ORDER, ["node_id", "domain", "tag", "initiative"]);
});

test("scope_matches: returns only scopes that actually match", async () => {
  const { matchesScopes } = await importProviders();
  const node = { id: "T-a", domain: "auth" };
  const k = { scope: { node_ids: ["T-other"], domains: ["auth"], tags: ["x"], initiatives: ["y"] } };
  assert.deepEqual(matchesScopes(node, k), ["domain"]);
});

test("scope_matches: multiple matches are returned in priority order", async () => {
  const { matchesScopes } = await importProviders();
  const node = { id: "T-a", domain: "auth", tags: ["backend"], initiative: "auth" };
  const k = { scope: {
    node_ids: ["T-a"],
    domains: ["auth"],
    tags: ["backend"],
    initiatives: ["auth"],
  } };
  assert.deepEqual(matchesScopes(node, k), ["node_id", "domain", "tag", "initiative"]);
});

test("scope_matches: returns [] when no scope matches", async () => {
  const { matchesScopes } = await importProviders();
  const node = { id: "T-a" };
  const k = { scope: { domains: ["billing"], tags: ["x"], initiatives: ["y"] } };
  assert.deepEqual(matchesScopes(node, k), []);
});

test("scope_matches: missing scope / undefined fields are tolerated", async () => {
  const { matchesScopes } = await importProviders();
  const node = { id: "T-a", domain: "auth" };
  assert.deepEqual(matchesScopes(node, {}), []);
  assert.deepEqual(matchesScopes(node, { scope: null }), []);
  assert.deepEqual(matchesScopes(node, { scope: { domains: undefined } }), []);
});

// ===================================================================
// ranking determinista — specificityRank / rankKnowledge
// ===================================================================

test("ranking: specificityRank prefers node_id, then domain, then tag, then initiative", async () => {
  const { specificityRank } = await importProviders();
  assert.equal(specificityRank(["node_id"]), 0);
  assert.equal(specificityRank(["domain"]), 1);
  assert.equal(specificityRank(["tag"]), 2);
  assert.equal(specificityRank(["initiative"]), 3);
  assert.equal(specificityRank(["node_id", "domain"]), 0, "most specific wins");
  assert.equal(specificityRank(["initiative", "node_id"]), 0, "order-independent");
  assert.equal(specificityRank([]), Number.POSITIVE_INFINITY);
});

test("ranking: rankKnowledge sorts by specificity then by id for determinism", async () => {
  const { rankKnowledge } = await importProviders();
  const items = [
    { id: "K-z", scope_matches: ["initiative"] },
    { id: "K-b", scope_matches: ["node_id"] },
    { id: "K-a", scope_matches: ["node_id"] },
    { id: "K-m", scope_matches: ["domain"] },
  ];
  const ranked = rankKnowledge(items);
  assert.deepEqual(ranked.map(({ id }) => id), ["K-a", "K-b", "K-m", "K-z"]);
});

test("ranking: rankKnowledge is pure (does not mutate the input)", async () => {
  const { rankKnowledge } = await importProviders();
  const items = [
    { id: "K-z", scope_matches: ["initiative"] },
    { id: "K-a", scope_matches: ["node_id"] },
  ];
  const before = items.map(({ id }) => id);
  rankKnowledge(items);
  assert.deepEqual(items.map(({ id }) => id), before);
});

// ===================================================================
// search — searchKnowledge (pure, snapshot-only)
// ===================================================================

test("search: empty query returns no matches", async () => {
  const { searchKnowledge } = await importProviders();
  assert.deepEqual(searchKnowledge({ snapshot: emptySnapshot(), query: "" }), {
    matches: [],
    count: 0,
  });
  assert.deepEqual(searchKnowledge({ snapshot: emptySnapshot(), query: "  " }), {
    matches: [],
    count: 0,
  });
});

test("search: case-insensitive substring across the supported knowledge fields", async () => {
  const { searchKnowledge } = await importProviders();
  const snapshot = emptySnapshot({
    nodes: {
      "K-needle": knowledgeNode("K-needle", {
        title: "Needle title",
        body: "Needle body",
        mitigation: "Needle mitigation",
        domain: "needle-domain",
        tags: ["needle-tag"],
        refs: [{ type: "external", target: "docs/needle.md" }],
        meta: { ticket: "NEEDLE-1" },
      }),
    },
  });
  const out = searchKnowledge({ snapshot, query: "needle" });
  assert.equal(out.count, 1);
  assert.deepEqual(out.matches[0].matched_fields, [
    "id", "title", "body", "mitigation", "domain", "tags", "refs", "meta",
  ]);
});

test("search: active by default; all=true includes deprecated", async () => {
  const { searchKnowledge } = await importProviders();
  const snapshot = emptySnapshot({
    nodes: {
      "K-active": knowledgeNode("K-active", { title: "shared active", status: "active" }),
      "K-old": knowledgeNode("K-old", { title: "shared deprecated", status: "deprecated" }),
    },
  });
  const active = searchKnowledge({ snapshot, query: "shared" });
  const all = searchKnowledge({ snapshot, query: "shared", all: true });
  assert.deepEqual(active.matches.map(({ id }) => id), ["K-active"]);
  assert.deepEqual(all.matches.map(({ id }) => id), ["K-active", "K-old"]);
});

test("search: ignores non-knowledge nodes (tasks, gates)", async () => {
  const { searchKnowledge } = await importProviders();
  const snapshot = emptySnapshot({
    nodes: {
      "T-redis": taskNode("T-redis", { title: "Redis task" }),
      "K-redis": knowledgeNode("K-redis", { title: "Redis sessions" }),
    },
  });
  const out = searchKnowledge({ snapshot, query: "redis" });
  assert.deepEqual(out.matches.map(({ id }) => id), ["K-redis"]);
});

test("search: returns matches in deterministic id order", async () => {
  const { searchKnowledge } = await importProviders();
  const snapshot = emptySnapshot({
    nodes: {
      "K-z": knowledgeNode("K-z", { body: "common" }),
      "K-a": knowledgeNode("K-a", { body: "common" }),
      "K-m": knowledgeNode("K-m", { body: "common" }),
    },
  });
  const out = searchKnowledge({ snapshot, query: "common" });
  assert.deepEqual(out.matches.map(({ id }) => id), ["K-a", "K-m", "K-z"]);
});

test("search: snippet is body truncated to 200 chars", async () => {
  const { searchKnowledge } = await importProviders();
  const longBody = "R".repeat(500);
  const snapshot = emptySnapshot({
    nodes: { "K-long": knowledgeNode("K-long", { body: longBody }) },
  });
  const out = searchKnowledge({ snapshot, query: "R" });
  assert.equal(out.matches[0].snippet.length, 200);
  assert.equal(out.matches[0].snippet, "R".repeat(200));
});

// ===================================================================
// informing — informingForNode (pure)
// ===================================================================

test("informing: returns inline node data for INFORMS edges only", async () => {
  const { informingForNode } = await importProviders();
  const snapshot = emptySnapshot({
    nodes: {
      "T-a": taskNode("T-a", { title: "task a", status: "in_progress" }),
      "G-roll": {
        id: "G-roll", kind: "resolvable", subkind: "gate", title: "rollout gate",
        initiative: "auth", status: "open", revision: 1,
      },
    },
    edges: [
      { from: "T-a", to: "G-roll", type: "INFORMS" },
      { from: "T-a", to: "T-blocker", type: "BLOCKS" },
      { from: "T-a", to: "G-old", type: "SUPERSEDES" },
    ],
  });
  const out = informingForNode({ snapshot, id: "T-a" });
  assert.equal(out.length, 1);
  assert.equal(out[0].edge_type, "INFORMS");
  assert.equal(out[0].node.id, "G-roll");
  assert.equal(out[0].node.kind, "resolvable");
  assert.equal(out[0].node.is_current, true);
});

test("informing: missing node returns [] without throwing", async () => {
  const { informingForNode } = await importProviders();
  assert.deepEqual(
    informingForNode({ snapshot: emptySnapshot(), id: "ghost" }),
    [],
  );
});

test("informing: empty graph returns []", async () => {
  const { informingForNode } = await importProviders();
  assert.deepEqual(
    informingForNode({ snapshot: emptySnapshot(), id: "T-a" }),
    [],
  );
});

// ===================================================================
// create provider — prepare / apply via kernel.mutate
// ===================================================================

test("create: prepare rejects missing title/body with MISSING_FIELD", async () => {
  const { createProvider } = await importProviders();
  const provider = createProvider();
  await assert.rejects(
    provider.prepare({
      snapshot: emptySnapshot(),
      input: { body: "b", initiative: "auth" },
      request: { action: "knowledge.create", actor: "alice" },
    }),
    (err) => err.code === "MISSING_FIELD" && /title/.test(err.message),
  );
  await assert.rejects(
    provider.prepare({
      snapshot: emptySnapshot(),
      input: { title: "t", initiative: "auth" },
      request: { action: "knowledge.create", actor: "alice" },
    }),
    (err) => err.code === "MISSING_FIELD" && /body/.test(err.message),
  );
});

test("create: prepare rejects unknown initiative with INITIATIVE_NOT_FOUND", async () => {
  const { createProvider } = await importProviders();
  const provider = createProvider();
  await assert.rejects(
    provider.prepare({
      snapshot: emptySnapshot({ initiatives: {} }),
      input: { title: "t", body: "b", initiative: "ghost", scope: { domains: ["x"] } },
      request: { action: "knowledge.create", actor: "alice" },
    }),
    (err) => err.code === "INITIATIVE_NOT_FOUND",
  );
});

test("create: prepare rejects when every scope array is empty", async () => {
  const { createProvider } = await importProviders();
  const provider = createProvider();
  await assert.rejects(
    provider.prepare({
      snapshot: emptySnapshot(),
      input: { title: "t", body: "b", initiative: "auth", scope: {
        domains: [], initiatives: [], tags: [], node_ids: [],
      } },
      request: { action: "knowledge.create", actor: "alice" },
    }),
    (err) => err.code === "MISSING_FIELD" && /scope/i.test(err.message),
  );
});

test("create: prepare rejects missing initiative", async () => {
  const { createProvider } = await importProviders();
  const provider = createProvider();
  await assert.rejects(
    provider.prepare({
      snapshot: emptySnapshot(),
      input: { title: "t", body: "b", scope: { domains: ["x"] } },
      request: { action: "knowledge.create", actor: "alice" },
    }),
    (err) => err.code === "MISSING_FIELD" && /initiative/.test(err.message),
  );
});

test("create: prepare rejects unknown knowledge_type", async () => {
  const { createProvider } = await importProviders();
  const provider = createProvider();
  await assert.rejects(
    provider.prepare({
      snapshot: emptySnapshot(),
      input: {
        title: "t", body: "b", initiative: "auth", knowledge_type: "bogus",
        scope: { domains: ["x"] },
      },
      request: { action: "knowledge.create", actor: "alice" },
    }),
    (err) => err.code === "INVALID_PROVIDER_INPUT" && /knowledge_type/.test(err.message),
  );
});

test("create: prepare accepts a minimal valid input", async () => {
  const { createProvider } = await importProviders();
  const provider = createProvider();
  const plan = await provider.prepare({
    snapshot: emptySnapshot(),
    input: { id: "K-1", title: "t", body: "b", initiative: "auth", scope: { domains: ["auth"] } },
    request: { action: "knowledge.create", actor: "alice" },
  });
  assert.deepEqual(plan.target, { id: "K-1", kind: "knowledge" });
  assert.equal(plan.policyAction, null);
  assert.equal(plan.idempotent, false);
});

test("create: apply uses tx only (does not modify the snapshot)", async () => {
  const { createProvider } = await importProviders();
  const { mutate } = await importKernel();
  const provider = createProvider();
  const dir = await createTempProject();
  try {
    await writeStateHelper(dir, emptySnapshot());
    const before = await readStateHelper(dir);
    const plan = await provider.prepare({
      snapshot: before,
      input: { id: "K-1", title: "t", body: "b", initiative: "auth", scope: { domains: ["auth"] } },
      request: { action: "knowledge.create", actor: "alice" },
    });
    // prepare is read-only: the on-disk state is untouched.
    const afterPrepare = await readStateHelper(dir);
    assert.deepEqual(afterPrepare, before, "prepare must not touch state");
    // Now apply via the kernel. The kernel forwards `request.input` to
    // prepare, so the request must carry the full create payload (the
    // provider re-validates it; there is no plan hand-off shortcut).
    const out = await mutate({
      projectDir: dir,
      request: {
        action: "knowledge.create",
        actor: "alice",
        input: { id: "K-1", title: "t", body: "b", initiative: "auth", scope: { domains: ["auth"] } },
      },
      provider,
    });
    assert.equal(out.idempotent, false);
    assert.equal(out.diff.created.length, 1);
    assert.equal(out.diff.created[0].id, "K-1");
    assert.equal(out.diff.created[0].node.revision, 1);
    const after = await readStateHelper(dir);
    assert.equal(after.nodes["K-1"].title, "t");
    assert.equal(after.nodes["K-1"].kind, "knowledge");
    assert.equal(after.nodes["K-1"].status, "active");
    assert.equal(after.nodes["K-1"].knowledge_type, "warning");
    // create normalizes scope to the four canonical arrays (same shape the
    // v2 state stores); absent keys are persisted as empty arrays.
    assert.deepEqual(after.nodes["K-1"].scope, {
      domains: ["auth"], initiatives: [], tags: [], node_ids: [],
    });
    assert.equal(after.log.length, 1);
    assert.equal(after.log[0].action, "knowledge.create");
    assert.equal(after.log[0].agent, "alice");
    assert.equal(after.log[0].node, "K-1");
    assert.equal(after.log[0].revision, 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("create: supersedes marks the target as superseded and adds a SUPERSEDES edge", async () => {
  const { createProvider } = await importProviders();
  const { mutate } = await importKernel();
  const provider = createProvider();
  const dir = await createTempProject();
  try {
    const base = emptySnapshot({
      nodes: {
        "K-old": knowledgeNode("K-old", { revision: 4, scope: { domains: ["auth"] } }),
      },
      edges: [],
    });
    await writeStateHelper(dir, base);
    const out = await mutate({
      projectDir: dir,
      request: {
        action: "knowledge.create",
        actor: "alice",
        input: {
          id: "K-new", title: "t", body: "b", initiative: "auth",
          scope: { domains: ["auth"] }, supersedes: "K-old",
        },
      },
      provider,
    });
    assert.equal(out.diff.created.length, 1);
    assert.equal(out.diff.created[0].id, "K-new");
    assert.equal(out.diff.updated.length, 1, "superseded target is updated");
    assert.equal(out.diff.updated[0].id, "K-old");
    assert.equal(out.diff.updated[0].node.status, "superseded");
    assert.equal(out.diff.updated[0].node.revision, 5, "kernel bumps revision by 1");
    assert.deepEqual(out.diff.added_edges, [{ from: "K-new", to: "K-old", type: "SUPERSEDES" }]);

    const after = await readStateHelper(dir);
    assert.equal(after.nodes["K-old"].status, "superseded");
    assert.equal(after.nodes["K-old"].revision, 5);
    assert.deepEqual(after.edges, [{ from: "K-new", to: "K-old", type: "SUPERSEDES" }]);
    assert.equal(after.log.length, 1);
    assert.equal(after.log[0].revision, 1, "log carries the target revision (new node)");
  } finally {
    await rmTempProject(dir);
  }
});

test("create: prepare rejects unknown supersedes target", async () => {
  const { createProvider } = await importProviders();
  const provider = createProvider();
  await assert.rejects(
    provider.prepare({
      snapshot: emptySnapshot(),
      input: { title: "t", body: "b", initiative: "auth", scope: { domains: ["x"] }, supersedes: "ghost" },
      request: { action: "knowledge.create", actor: "alice" },
    }),
    (err) => err.code === "NODE_NOT_FOUND",
  );
});

test("create: prepare rejects supersedes pointing at a non-knowledge node", async () => {
  const { createProvider } = await importProviders();
  const provider = createProvider();
  const snapshot = emptySnapshot({
    nodes: { "T-a": taskNode("T-a") },
  });
  await assert.rejects(
    provider.prepare({
      snapshot,
      input: { title: "t", body: "b", initiative: "auth", scope: { domains: ["x"] }, supersedes: "T-a" },
      request: { action: "knowledge.create", actor: "alice" },
    }),
    (err) => err.code === "INVALID_PROVIDER_INPUT" && /knowledge/.test(err.message),
  );
});

test("create: provider never writes revision (kernel assigns it)", async () => {
  const { createProvider } = await importProviders();
  const provider = createProvider();
  let applySawRevision = false;
  const spyProvider = {
    prepare: provider.prepare,
    apply: async (args) => {
      const draft = args.tx.createNode({
        id: "K-spy", kind: "knowledge", title: "t", body: "b",
        initiative: "auth", scope: { domains: ["x"] },
        revision: 999,
      });
      applySawRevision = Object.prototype.hasOwnProperty.call(draft, "revision");
      return { result: { id: "K-spy" } };
    },
  };
  const dir = await createTempProject();
  try {
    await writeStateHelper(dir, emptySnapshot());
    await assert.rejects(
      importKernel().then(({ mutate }) => mutate({
        projectDir: dir,
        request: { action: "knowledge.create", actor: "alice", input: { id: "K-spy", title: "t", body: "b", initiative: "auth", scope: { domains: ["x"] } } },
        provider: spyProvider,
      })),
      (err) => err.code === "INVALID_EXECUTION_CONTRACT",
    );
    // The provider attempted to seed revision; the kernel (via tx) refused.
    assert.equal(applySawRevision, false, "tx.createNode stripped revision before return");
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// update provider — prepare / apply via kernel.mutate
// ===================================================================

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
    const base = emptySnapshot({
      nodes: {
        "K-1": knowledgeNode("K-1", {
          revision: 2, title: "old", body: "old body", mitigation: "old m",
          scope: { domains: ["auth"] },
        }),
      },
    });
    await writeStateHelper(dir, base);
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
    assert.equal(out.idempotent, false);
    assert.equal(out.diff.updated.length, 1);
    assert.equal(out.diff.updated[0].id, "K-1");
    assert.equal(out.diff.updated[0].node.revision, 3, "kernel bumps by 1");
    const after = await readStateHelper(dir);
    assert.equal(after.nodes["K-1"].title, "new");
    assert.equal(after.nodes["K-1"].body, "new body");
    assert.equal(after.nodes["K-1"].mitigation, "new m");
    assert.deepEqual(after.nodes["K-1"].scope, {
      domains: ["auth", "billing"], tags: ["ops"], initiatives: [], node_ids: [],
    });
    assert.equal(after.log.length, 1);
    assert.equal(after.log[0].action, "knowledge.update");
    assert.equal(after.log[0].revision, 3);
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
    await writeStateHelper(dir, base);
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
    assert.equal(after.nodes["K-1"].revision, 1, "no revision bump on idempotent update");
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

// ===================================================================
// deprecate provider — prepare / apply via kernel.mutate
// (plan B4-knowledge-lifecycle)
// ===================================================================

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

test("deprecate: apply preserves scope, status, reason, deprecated_at/by via kernel.mutate", async () => {
  const { deprecateProvider } = await importProviders();
  const { mutate } = await importKernel();
  const provider = deprecateProvider();
  const dir = await createTempProject();
  try {
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
    await writeStateHelper(dir, base);
    const out = await mutate({
      projectDir: dir,
      request: {
        action: "knowledge.deprecate",
        actor: "alice",
        input: { id: "K-1", reason: "superseded by v2 endpoint" },
      },
      provider,
    });
    assert.equal(out.idempotent, false, "deprecate is never idempotent (records a new event)");
    assert.equal(out.diff.updated.length, 1);
    assert.equal(out.diff.updated[0].id, "K-1");
    assert.equal(out.diff.updated[0].node.revision, 5, "kernel bumps revision by 1");

    const after = await readStateHelper(dir);
    const node = after.nodes["K-1"];
    assert.equal(node.status, "deprecated");
    assert.equal(node.deprecation_reason, "superseded by v2 endpoint");
    assert.equal(node.deprecated_by, "alice");
    assert.equal(typeof node.deprecated_at, "string");
    assert.ok(!Number.isNaN(Date.parse(node.deprecated_at)), "deprecated_at is ISO 8601");
    // Preserve every non-deprecated field.
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
    assert.equal(after.log.length, 1);
    assert.equal(after.log[0].action, "knowledge.deprecate");
    assert.equal(after.log[0].agent, "alice");
    assert.equal(after.log[0].node, "K-1");
    assert.equal(after.log[0].revision, 5);
    // The log entry mirrors the kernel canonical shape; the deprecation
    // reason lives on the node itself (`deprecation_reason`).
    assert.equal(after.log[0].reason, undefined);
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
    const base = emptySnapshot({
      nodes: {
        "K-active": knowledgeNode("K-active", { title: "shared active", body: "shared body" }),
        "K-old": knowledgeNode("K-old", { title: "shared deprecated", body: "shared body" }),
      },
    });
    await writeStateHelper(dir, base);
    await mutate({
      projectDir: dir,
      request: {
        action: "knowledge.deprecate",
        actor: "alice",
        input: { id: "K-old", reason: "obsolete" },
      },
      provider,
    });
    const after = await readStateHelper(dir);
    const activeSearch = searchKnowledge({ snapshot: after, query: "shared" });
    const allSearch = searchKnowledge({ snapshot: after, query: "shared", all: true });
    assert.deepEqual(activeSearch.matches.map(({ id }) => id), ["K-active"], "deprecated hidden by default");
    assert.deepEqual(
      allSearch.matches.map(({ id }) => id),
      ["K-active", "K-old"].sort(),
      "deprecated included when all=true",
    );
    // Also assert the underlying status flipped so the alert path stays coherent.
    assert.equal(after.nodes["K-old"].status, "deprecated");
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
    await writeStateHelper(dir, base);
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
    // the kernel mutates the disk via writeState, not the in-memory
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
