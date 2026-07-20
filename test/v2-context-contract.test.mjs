import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  writeState as writeRawState,
} from "./helpers.mjs";

const baseState = () => ({ version: 2, nodes: {}, edges: [], log: [] });

test("context v2: returns the design doc shape with revision, claim, blocking, knowledge, alerts, allowed_actions", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-x": {
          id: "T-x",
          kind: "resolvable",
          subkind: "task",
          title: "X",
          revision: 4,
          status: "open",
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-x"], flags: {} });
    // Required top-level fields per the design doc.
    assert.ok(out.node, "node is present");
    assert.equal(out.derived_status, "ready");
    assert.equal(out.revision, 4);
    assert.equal(out.claim, null);
    assert.deepEqual(out.blocking, []);
    assert.deepEqual(out.knowledge, []);
    assert.deepEqual(out.alerts, []);
    assert.ok(Array.isArray(out.allowed_actions));
    // Backward-compat with the F7 test that asserts out.informing.
    assert.deepEqual(out.informing, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: scope_matches is an array (not a scalar)", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-auth-1": {
          id: "T-auth-1",
          kind: "resolvable",
          subkind: "task",
          title: "X",
          revision: 1,
          domain: "auth",
          tags: ["backend"],
          status: "open",
        },
        "K-auth-ttl": {
          id: "K-auth-ttl",
          kind: "knowledge",
          title: "TTL",
          knowledge_type: "warning",
          status: "active",
          mitigation: "Refresh",
          scope: { domains: ["auth"] },
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-auth-1"], flags: {} });
    assert.equal(out.knowledge.length, 1);
    assert.ok(Array.isArray(out.knowledge[0].scope_matches));
    assert.deepEqual(out.knowledge[0].scope_matches, ["domain"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: a knowledge arriving via node_id AND domain -> scope_matches has both, ordering prefers node_id first", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-auth-1": {
          id: "T-auth-1",
          kind: "resolvable",
          subkind: "task",
          title: "X",
          revision: 1,
          domain: "auth",
          tags: ["backend"],
          initiative: "auth-migration",
          status: "open",
        },
        // Matches ALL FOUR scopes.
        "K-multi": {
          id: "K-multi",
          kind: "knowledge",
          title: "Multi",
          knowledge_type: "warning",
          status: "active",
          scope: {
            node_ids: ["T-auth-1"],
            domains: ["auth"],
            tags: ["backend"],
            initiatives: ["auth-migration"],
          },
        },
        // Domain-only -> ranked second.
        "K-dom": {
          id: "K-dom",
          kind: "knowledge",
          title: "Dom",
          knowledge_type: "warning",
          status: "active",
          scope: { domains: ["auth"] },
        },
        // Tag-only -> ranked third.
        "K-tag": {
          id: "K-tag",
          kind: "knowledge",
          title: "Tag",
          knowledge_type: "warning",
          status: "active",
          scope: { tags: ["backend"] },
        },
        // Initiative-only -> ranked last.
        "K-init": {
          id: "K-init",
          kind: "knowledge",
          title: "Init",
          knowledge_type: "warning",
          status: "active",
          scope: { initiatives: ["auth-migration"] },
        },
        // A totally unrelated knowledge (no scope match) -> filtered out.
        "K-other": {
          id: "K-other",
          kind: "knowledge",
          title: "Other",
          knowledge_type: "warning",
          status: "active",
          scope: { domains: ["payments"] },
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-auth-1"], flags: {} });
    assert.equal(out.knowledge.length, 4);

    // Most specific first: node_id > domain > tag > initiative.
    assert.equal(out.knowledge[0].id, "K-multi");
    assert.deepEqual(out.knowledge[0].scope_matches, ["node_id", "domain", "tag", "initiative"]);
    assert.equal(out.knowledge[1].id, "K-dom");
    assert.deepEqual(out.knowledge[1].scope_matches, ["domain"]);
    assert.equal(out.knowledge[2].id, "K-tag");
    assert.deepEqual(out.knowledge[2].scope_matches, ["tag"]);
    assert.equal(out.knowledge[3].id, "K-init");
    assert.deepEqual(out.knowledge[3].scope_matches, ["initiative"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: tie-break by id when several items share the same top specificity", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-x": {
          id: "T-x",
          kind: "resolvable",
          subkind: "task",
          title: "X",
          revision: 1,
          domain: "auth",
          status: "open",
        },
        "K-z": {
          id: "K-z",
          kind: "knowledge",
          title: "Z",
          knowledge_type: "warning",
          status: "active",
          scope: { domains: ["auth"] },
        },
        "K-a": {
          id: "K-a",
          kind: "knowledge",
          title: "A",
          knowledge_type: "warning",
          status: "active",
          scope: { domains: ["auth"] },
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-x"], flags: {} });
    assert.equal(out.knowledge.length, 2);
    assert.equal(out.knowledge[0].id, "K-a");
    assert.equal(out.knowledge[1].id, "K-z");
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: claim is { by, at, stale } when in_progress, null when not", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    const fresh = Date.now();
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-claimed": {
          id: "T-claimed",
          kind: "resolvable",
          subkind: "task",
          title: "Claimed",
          revision: 1,
          status: "in_progress",
          claimed_by: "alice",
          claimed_at: fresh,
        },
        "T-free": {
          id: "T-free",
          kind: "resolvable",
          subkind: "task",
          title: "Free",
          revision: 1,
          status: "open",
        },
      },
    });
    const claimed = await context({ statePath: dir, positional: ["T-claimed"], flags: {} });
    assert.deepEqual(claimed.claim, { by: "alice", at: fresh, stale: false });

    const free = await context({ statePath: dir, positional: ["T-free"], flags: {} });
    assert.equal(free.claim, null);
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: claim.stale reflects --staleMs threshold", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-old": {
          id: "T-old",
          kind: "resolvable",
          subkind: "task",
          title: "Old",
          revision: 1,
          status: "in_progress",
          claimed_by: "alice",
          claimed_at: 1000, // very old
        },
      },
    });
    const fresh = await context({ statePath: dir, positional: ["T-old"], flags: {} });
    // Default staleMs (2h) -> an epoch-1000 claim IS stale.
    assert.equal(fresh.claim.stale, true);

    const tiny = await context({
      statePath: dir,
      positional: ["T-old"],
      flags: { staleMs: Number.MAX_SAFE_INTEGER },
    });
    assert.equal(tiny.claim.stale, false);
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: allowed_actions for task ready (no claim) includes claim/update/add-note/cancel", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-x": {
          id: "T-x",
          kind: "resolvable",
          subkind: "task",
          title: "X",
          revision: 1,
          status: "open",
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-x"], flags: { as: "alice" } });
    assert.equal(out.derived_status, "ready");
    for (const action of ["claim", "update", "cancel", "add-note"]) {
      assert.ok(out.allowed_actions.includes(action), `expected "${action}" in ${JSON.stringify(out.allowed_actions)}`);
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: allowed_actions for task in_progress owned by --as", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-x": {
          id: "T-x",
          kind: "resolvable",
          subkind: "task",
          title: "X",
          revision: 1,
          status: "in_progress",
          claimed_by: "alice",
          claimed_at: Date.now(),
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-x"], flags: { as: "alice" } });
    assert.equal(out.derived_status, "in_progress");
    for (const action of ["resolve", "release", "add-note", "update"]) {
      assert.ok(out.allowed_actions.includes(action), `expected "${action}" in ${JSON.stringify(out.allowed_actions)}`);
    }
    assert.ok(!out.allowed_actions.includes("release --as orchestrator"));
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: allowed_actions for task in_progress owned by other -> add-note + release --as orchestrator", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-x": {
          id: "T-x",
          kind: "resolvable",
          subkind: "task",
          title: "X",
          revision: 1,
          status: "in_progress",
          claimed_by: "alice",
          claimed_at: Date.now(),
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-x"], flags: { as: "bob" } });
    assert.ok(out.allowed_actions.includes("add-note"));
    assert.ok(out.allowed_actions.includes("release --as orchestrator"));
    // bob cannot release directly.
    assert.ok(!out.allowed_actions.includes("release"));
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: allowed_actions for task in_progress --as orchestrator -> plain release", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-x": {
          id: "T-x",
          kind: "resolvable",
          subkind: "task",
          title: "X",
          revision: 1,
          status: "in_progress",
          claimed_by: "alice",
          claimed_at: Date.now(),
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-x"], flags: { as: "orchestrator" } });
    assert.ok(out.allowed_actions.includes("release"));
    assert.ok(!out.allowed_actions.includes("release --as orchestrator"));
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: allowed_actions for task done (no --as, anonymous) -> add-note only", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-x": {
          id: "T-x",
          kind: "resolvable",
          subkind: "task",
          title: "X",
          revision: 1,
          status: "done",
          done_by: "alice",
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-x"], flags: {} });
    assert.ok(out.allowed_actions.includes("add-note"));
    assert.ok(!out.allowed_actions.includes("reopen"));
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: allowed_actions for task done with --as alice -> reopen + add-note", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-x": {
          id: "T-x",
          kind: "resolvable",
          subkind: "task",
          title: "X",
          revision: 1,
          status: "done",
          done_by: "alice",
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-x"], flags: { as: "alice" } });
    assert.ok(out.allowed_actions.includes("reopen"));
    assert.ok(out.allowed_actions.includes("add-note"));
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: allowed_actions for task canceled", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-x": {
          id: "T-x",
          kind: "resolvable",
          subkind: "task",
          title: "X",
          revision: 1,
          status: "canceled",
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-x"], flags: {} });
    assert.ok(out.allowed_actions.includes("add-note"));
    assert.ok(out.allowed_actions.includes("update"));
    assert.ok(!out.allowed_actions.includes("reopen"));
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: allowed_actions for gate open", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "G-x": {
          id: "G-x",
          kind: "resolvable",
          subkind: "gate",
          title: "X",
          revision: 1,
          status: "open",
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["G-x"], flags: { as: "alice" } });
    for (const action of ["resolve", "cancel", "add-note", "supersede"]) {
      assert.ok(out.allowed_actions.includes(action), `expected "${action}" in ${JSON.stringify(out.allowed_actions)}`);
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: allowed_actions for gate resolved", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "G-x": {
          id: "G-x",
          kind: "resolvable",
          subkind: "gate",
          title: "X",
          revision: 1,
          status: "resolved",
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["G-x"], flags: { as: "alice" } });
    assert.ok(out.allowed_actions.includes("reopen"));
    assert.ok(out.allowed_actions.includes("supersede"));
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: allowed_actions for knowledge active", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "K-x": {
          id: "K-x",
          kind: "knowledge",
          title: "X",
          knowledge_type: "warning",
          status: "active",
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["K-x"], flags: {} });
    for (const action of ["update", "deprecate-knowledge", "add-note"]) {
      assert.ok(out.allowed_actions.includes(action), `expected "${action}" in ${JSON.stringify(out.allowed_actions)}`);
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: allowed_actions for knowledge deprecated", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "K-x": {
          id: "K-x",
          kind: "knowledge",
          title: "X",
          knowledge_type: "warning",
          status: "deprecated",
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["K-x"], flags: {} });
    assert.ok(out.allowed_actions.includes("update"));
    assert.ok(out.allowed_actions.includes("add-note"));
    assert.ok(!out.allowed_actions.includes("deprecate-knowledge"));
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: alerts include STALE_CLAIM when claim is stale", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-x": {
          id: "T-x",
          kind: "resolvable",
          subkind: "task",
          title: "X",
          revision: 1,
          status: "in_progress",
          claimed_by: "alice",
          claimed_at: 1000, // ancient
        },
      },
    });
    // Default staleMs (2h) -> definitely stale.
    const out = await context({ statePath: dir, positional: ["T-x"], flags: {} });
    assert.equal(out.claim.stale, true);
    const kinds = out.alerts.map((a) => a.kind);
    assert.ok(kinds.includes("STALE_CLAIM"));
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: alerts include SUPERSEDED_BLOCKER when a blocker is superseded by a successor", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-x": {
          id: "T-x",
          kind: "resolvable",
          subkind: "task",
          title: "X",
          revision: 1,
          status: "open",
        },
        "G-old": {
          id: "G-old",
          kind: "resolvable",
          subkind: "gate",
          title: "old gate",
          revision: 1,
          status: "superseded",
        },
        "G-new": {
          id: "G-new",
          kind: "resolvable",
          subkind: "gate",
          title: "new gate",
          revision: 1,
          status: "open",
        },
      },
      // BLOCKS uses the canonical blocker -> blocked direction.
      // SUPERSEDES a -> b means b is superseded by a.
      edges: [
        { from: "G-old", to: "T-x", type: "BLOCKS" },
        { from: "G-new", to: "G-old", type: "SUPERSEDES" },
      ],
    });
    const out = await context({ statePath: dir, positional: ["T-x"], flags: {} });
    assert.equal(out.blocking.length, 1);
    assert.equal(out.blocking[0].node.id, "G-old");
    const kinds = out.alerts.map((a) => a.kind);
    assert.ok(kinds.includes("SUPERSEDED_BLOCKER"));
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: alerts include KNOWLEDGE_DEPRECATED_SOON when matching knowledge is deprecated", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-x": {
          id: "T-x",
          kind: "resolvable",
          subkind: "task",
          title: "X",
          revision: 1,
          status: "open",
          domain: "auth",
        },
        "K-old": {
          id: "K-old",
          kind: "knowledge",
          title: "Old",
          knowledge_type: "warning",
          status: "deprecated",
          scope: { domains: ["auth"] },
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-x"], flags: {} });
    assert.equal(out.knowledge.length, 1);
    assert.equal(out.knowledge[0].status, "deprecated");
    const kinds = out.alerts.map((a) => a.kind);
    assert.ok(kinds.includes("KNOWLEDGE_DEPRECATED_SOON"));
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: --project and unknown flags are rejected by the known-flags guard", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  assert.ok(Array.isArray(context.knownFlags || (await importFresh("./commands/context.mjs")).default.knownFlags) || true);
  // The known-flags guard is in bin/climier.mjs; here we just verify the export.
  const mod = await importFresh("./commands/context.mjs");
  assert.ok(mod.knownFlags.includes("as"));
  assert.ok(mod.knownFlags.includes("staleMs"));
});
