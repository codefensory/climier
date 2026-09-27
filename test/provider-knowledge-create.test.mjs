// Knowledge create contract tests for the knowledge-core provider slice
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

import { emptySnapshot, importKernel, importProviders, knowledgeNode, taskNode } from "./provider-knowledge/fixtures.mjs";

import {
  createTempProject,
  rmTempProject,
  writeFencedState,
  readState as readStateHelper,
} from "./helpers.mjs";

// ===================================================================
// Pure imports (no fs) — re-imported per test for freshness.
// ===================================================================



// ===================================================================
// State fixtures (pure, JSON-shaped)
// ===================================================================



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

test("create: prepare accepts a free-form knowledge_type", async () => {
  // T-graph-kernel-adapters-wave1 relaxed knowledge_type validation:
  // the create provider treats knowledge_type as a free-form taxonomy
  // string (warning / fact / instruction / custom). Empty strings are
  // still rejected as MISSING_FIELD.
  const { createProvider } = await importProviders();
  const provider = createProvider();
  const plan = await provider.prepare({
    snapshot: emptySnapshot(),
    input: {
      title: "t", body: "b", initiative: "auth", knowledge_type: "bogus",
      scope: { domains: ["x"] },
    },
    request: { action: "knowledge.create", actor: "alice" },
  });
  assert.equal(plan.node.knowledge_type, "bogus");
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
    await writeFencedState(dir, emptySnapshot());
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
    assert.equal(out.diff.created[0].node.revision, 2);
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
    assert.equal(after.log[0].revision, 2);
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
    await writeFencedState(dir, base);
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
    assert.equal(out.diff.updated[0].node.revision, 6, "kernel advances beyond the fenced fixture high-water");
    assert.deepEqual(out.diff.added_edges, [{ from: "K-new", to: "K-old", type: "SUPERSEDES" }]);

    const after = await readStateHelper(dir);
    assert.equal(after.nodes["K-old"].status, "superseded");
    assert.equal(after.nodes["K-old"].revision, 6);
    assert.deepEqual(after.edges, [{ from: "K-new", to: "K-old", type: "SUPERSEDES" }]);
    assert.equal(after.log.length, 1);
    assert.equal(after.log[0].revision, 6, "log carries the fenced transaction revision");
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
    await writeFencedState(dir, emptySnapshot());
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
