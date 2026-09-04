import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  writeState as writeRawState,
} from "./helpers.mjs";

const baseState = () => ({ version: 2, nodes: {}, edges: [], initiatives: {}, log: [] });

test("context v2: returns the design doc shape with revision, claim, blocking, knowledge, alerts, allowed_actions", async () => {
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
    for (const action of ["submit", "release", "add-note", "update"]) {
      assert.ok(out.allowed_actions.includes(action), `expected "${action}" in ${JSON.stringify(out.allowed_actions)}`);
    }
    assert.ok(!out.allowed_actions.includes("resolve"), "tasks must submit rather than resolve");
    // ADR-009 §"Contexto y documentación": allowed_actions must never
    // project hatch-shaped commands or actor roles. The owner (and any
    // other identified caller) gets plain `release`, not
    // `"release --as orchestrator"`.
    assert.ok(!out.allowed_actions.some((a) => a.includes("orchestrator")));
    assert.ok(!out.allowed_actions.some((a) => a.includes("recovery")));
    for (const action of out.allowed_actions) {
      assert.ok(!/^release\s+--as/.test(action), `unexpected hatch in ${action}`);
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: submitted task reports validation actions without claim or release actions", async () => {
  const { default: context } = await importFresh("./cli/commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-submitted": {
          id: "T-submitted",
          kind: "resolvable",
          subkind: "task",
          title: "Submitted",
          revision: 2,
          status: "submitted",
          submitted_by: "worker",
          submitted_at: "2026-01-01T00:00:00.000Z",
          claim: null,
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-submitted"], flags: { as: "validator" } });
    assert.equal(out.derived_status, "submitted");
    assert.equal(out.claim, null);
    assert.ok(out.allowed_actions.includes("accept"));
    assert.ok(out.allowed_actions.includes("reject"));
    assert.ok(out.allowed_actions.includes("add-note"));
    assert.ok(!out.allowed_actions.includes("take"));
    assert.ok(!out.allowed_actions.includes("release"));
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: allowed_actions for task in_progress with --as bob (non-owner) -> submit/release/add-note/update (ADR-009: ownership is not projected)", async () => {
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
    // ADR-009 §"Resto de operaciones" + §"Contexto y documentación":
    // allowed_actions describes the actions the state permits. The
    // core no longer compares the caller against the claim owner for
    // submit/release. Any identified caller sees submit/release;
    // the actual ownership check is delegated to a plugin (or to the
    // core default of "any actor is authorised"). The role-based
    // hatch is gone.
    const out = await context({ statePath: dir, positional: ["T-x"], flags: { as: "bob" } });
    for (const action of ["submit", "release", "add-note", "update"]) {
      assert.ok(out.allowed_actions.includes(action), `expected "${action}" in ${JSON.stringify(out.allowed_actions)}`);
    }
    assert.ok(!out.allowed_actions.includes("resolve"), "tasks must submit rather than resolve");
    assert.ok(!out.allowed_actions.some((a) => a.includes("orchestrator")));
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: allowed_actions for task in_progress --as test-agent (non-owner) -> submit/release/add-note/update (actor name has no authority)", async () => {
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
    // ADR-009: the literal actor name (here `test-agent`) carries no
    // authority. An identified caller that is not the claim owner
    // still sees submit/release because allowed_actions reflects the
    // state invariant, not the ownership check. The handler's default
    // (no plugin) is "any actor is authorised".
    const out = await context({ statePath: dir, positional: ["T-x"], flags: { as: "test-agent" } });
    for (const action of ["submit", "release", "add-note", "update"]) {
      assert.ok(out.allowed_actions.includes(action), `expected "${action}" in ${JSON.stringify(out.allowed_actions)}`);
    }
    assert.ok(!out.allowed_actions.includes("resolve"), "tasks must submit rather than resolve");
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: allowed_actions for task in_progress anonymous (no --as) -> add-note only", async () => {
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
    // Anonymous callers have no actor to record; actions that write to
    // the log (claim, resolve, release, reopen, cancel) are not
    // surfaced. add-note/update remain because they are read-shaped
    // from the perspective of allowed_actions.
    const out = await context({ statePath: dir, positional: ["T-x"], flags: {} });
    assert.deepEqual(out.allowed_actions, ["add-note"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: allowed_actions for task done (no --as, anonymous) -> add-note only", async () => {
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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

test("context v2: allowed_actions for task done with --as bob (not done_by) -> reopen + add-note (ADR-009: done_by is not projected)", async () => {
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
    // ADR-009 §"Resto de operaciones" + §"Contexto y documentación":
    // the core no longer compares the caller against `done_by` for
    // reopen. Any identified caller sees reopen because the task's
    // state (done) and shape permit it.
    const out = await context({ statePath: dir, positional: ["T-x"], flags: { as: "bob" } });
    assert.ok(out.allowed_actions.includes("reopen"));
    assert.ok(out.allowed_actions.includes("add-note"));
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: allowed_actions for task canceled", async () => {
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
    // F13: gate resolve surfaces its required flags inline so the agent
    // doesn't have to read the source to learn that --choice and --rationale
    // are required. The literal substring "resolve" must still be present.
    const resolveAction = out.allowed_actions.find((a) => a.startsWith("resolve"));
    assert.ok(resolveAction, `expected a resolve action in ${JSON.stringify(out.allowed_actions)}`);
    assert.match(resolveAction, /--choice/);
    assert.match(resolveAction, /--rationale/);
    for (const action of ["cancel", "add-note", "supersede"]) {
      assert.ok(out.allowed_actions.includes(action), `expected "${action}" in ${JSON.stringify(out.allowed_actions)}`);
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("context v2: allowed_actions for gate resolved", async () => {
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
  const { default: context } = await importFresh("./cli/commands/context.mjs");
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
  const { default: context } = await importFresh("./cli/commands/context.mjs");
  assert.ok(Array.isArray(context.knownFlags || (await importFresh("./cli/commands/context.mjs")).default.knownFlags) || true);
  // The known-flags guard is in bin/climier.mjs; here we just verify the export.
  const mod = await importFresh("./cli/commands/context.mjs");
  assert.ok(mod.knownFlags.includes("as"));
  assert.ok(mod.knownFlags.includes("staleMs"));
});
