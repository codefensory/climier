// Knowledge query contract tests for the knowledge-core provider slice
// (plan B4-knowledge-core).
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

import { emptySnapshot, importProviders, knowledgeNode, taskNode } from "./provider-knowledge/fixtures.mjs";



// ===================================================================
// Pure imports (no fs) — re-imported per test for freshness.
// ===================================================================




// ===================================================================
// State fixtures (pure, JSON-shaped)
// ===================================================================






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
// knowledge projection — knowledgeForNode (pure)
// ===================================================================

test("knowledge projection: matches all scopes, includes deprecated entries, and ranks deterministically", async () => {
  const { knowledgeForNode } = await importProviders();
  const snapshot = emptySnapshot({
    nodes: {
      "T-a": taskNode("T-a", { initiative: "auth", domain: "identity", tags: ["backend"] }),
      "K-z": knowledgeNode("K-z", {
        status: "deprecated", title: "initiative match",
        scope: { initiatives: ["auth"] },
      }),
      "K-domain": knowledgeNode("K-domain", {
        title: "domain match", scope: { domains: ["identity"] },
      }),
      "K-a": knowledgeNode("K-a", {
        title: "node and tag match",
        scope: { node_ids: ["T-a"], tags: ["backend"] },
      }),
      "K-unrelated": knowledgeNode("K-unrelated", {
        scope: { domains: ["billing"] },
      }),
    },
  });

  const out = knowledgeForNode({ snapshot, id: "T-a" });
  assert.deepEqual(out.map(({ id }) => id), ["K-a", "K-domain", "K-z"]);
  assert.deepEqual(out.map(({ scope_matches }) => scope_matches), [
    ["node_id", "tag"], ["domain"], ["initiative"],
  ]);
  assert.equal(out[2].status, "deprecated");
  assert.equal(Object.prototype.hasOwnProperty.call(out[0], "scope"), true);
});

test("knowledge projection: missing target or malformed snapshot returns []", async () => {
  const { knowledgeForNode } = await importProviders();
  assert.deepEqual(knowledgeForNode({ snapshot: emptySnapshot(), id: "ghost" }), []);
  assert.deepEqual(knowledgeForNode({ snapshot: { nodes: null }, id: "T-a" }), []);
  assert.deepEqual(knowledgeForNode(), []);
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
