import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState as readRawState, runCli, writeState as writeRawState } from "./helpers.mjs";

test("init --v2: creates an empty v2 state", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    const s = await readState(dir);
    assert.equal(s.version, 2);
    assert.deepEqual(s.nodes, {});
    assert.deepEqual(s.edges, []);
    assert.deepEqual(s.log, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-node: creates a v2 task node and show returns it", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  const { default: show } = await importFresh("./commands/show.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "test" }, positional: ["auth-migration"] });
    await addNode({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: {
        kind: "resolvable",
        subkind: "task",
        title: "Implement session middleware",
        domain: "auth",
        initiative: "auth-migration",
        definition: "Build middleware for opaque sessions",
        acceptance: "Authenticated requests refresh session TTL",
        tags: "backend,api",
      },
    });

    const out = await show({ statePath: dir, positional: ["T-auth-1"], flags: {} });
    assert.equal(out.type, "task");
    assert.equal(out.node.kind, "resolvable");
    assert.equal(out.node.subkind, "task");
    assert.equal(out.node.status, "open");
    assert.deepEqual(out.node.tags, ["backend", "api"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-node: can create typed edges in the same call", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "test" }, positional: ["auth-migration"] });
    await addNode({
      statePath: dir,
      positional: ["G-auth-v2"],
      flags: {
        kind: "resolvable",
        subkind: "gate",
        initiative: "auth-migration",
        title: "Replace JWT with opaque sessions",
        status: "resolved",
        choice: "opaque sessions + redis",
      },
    });
    await addNode({
      statePath: dir,
      positional: ["G-auth-rollout"],
      flags: {
        kind: "resolvable",
        subkind: "gate",
        initiative: "auth-migration",
        title: "Rollout notes",
        status: "resolved",
      },
    });

    await addNode({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: {
        kind: "resolvable",
        subkind: "task",
        initiative: "auth-migration",
        title: "Implement session middleware",
        "blocked-by": "G-auth-v2",
        "derived-from": "G-auth-rollout",
      },
    });

    const state = await readRawState(dir);
    assert.deepEqual(state.edges, [
      { from: "G-auth-v2", to: "T-auth-1", type: "BLOCKS" },
      { from: "T-auth-1", to: "G-auth-rollout", type: "DERIVED_FROM" },
    ]);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-node: stores refs as external targets", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "test" }, positional: ["auth-migration"] });
    await addNode({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: {
        kind: "resolvable",
        subkind: "task",
        title: "Implement session middleware",
        initiative: "auth-migration",
        refs: "docs/adr/0014-auth-sessions.md,https://internal/wiki/auth-rollout",
      },
    });

    const state = await readRawState(dir);
    assert.deepEqual(state.nodes["T-auth-1"].refs, [
      { type: "external", target: "docs/adr/0014-auth-sessions.md" },
      { type: "external", target: "https://internal/wiki/auth-rollout" },
    ]);

    const out = await context({ statePath: dir, positional: ["T-auth-1"], flags: {} });
    assert.deepEqual(out.node.refs, [
      { type: "external", target: "docs/adr/0014-auth-sessions.md" },
      { type: "external", target: "https://internal/wiki/auth-rollout" },
    ]);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: add-node --refs persists refs in v2", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init", "--v2"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "auth-migration", "--desc", "test"]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli([
      "--project", dir, "add-node", "T-auth-1",
      "--kind", "resolvable",
      "--subkind", "task",
      "--title", "Implement session middleware",
      "--initiative", "auth-migration",
      "--refs", "docs/adr/0014-auth-sessions.md,https://internal/wiki/auth-rollout",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.deepEqual(data.node.refs, [
      { type: "external", target: "docs/adr/0014-auth-sessions.md" },
      { type: "external", target: "https://internal/wiki/auth-rollout" },
    ]);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-node: stores meta from JSON", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "test" }, positional: ["auth-migration"] });
    await addNode({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: {
        kind: "resolvable",
        subkind: "task",
        title: "Implement session middleware",
        initiative: "auth-migration",
        meta: '{"ticket":"AUTH-123","owner_team":"platform"}',
      },
    });

    const state = await readRawState(dir);
    assert.deepEqual(state.nodes["T-auth-1"].meta, {
      ticket: "AUTH-123",
      owner_team: "platform",
    });

    const out = await context({ statePath: dir, positional: ["T-auth-1"], flags: {} });
    assert.deepEqual(out.node.meta, {
      ticket: "AUTH-123",
      owner_team: "platform",
    });
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: add-node --meta persists metadata in v2", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init", "--v2"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "auth-migration", "--desc", "test"]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli([
      "--project", dir, "add-node", "T-auth-1",
      "--kind", "resolvable",
      "--subkind", "task",
      "--title", "Implement session middleware",
      "--initiative", "auth-migration",
      "--meta", '{"ticket":"AUTH-123","owner_team":"platform"}',
    ]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.deepEqual(data.node.meta, {
      ticket: "AUTH-123",
      owner_team: "platform",
    });
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: appends notes to a v2 node", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "test" }, positional: ["auth-migration"] });
    await addNode({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: { kind: "resolvable", subkind: "task", title: "Implement session middleware", initiative: "auth-migration" },
    });

    const out = await addNote({
      statePath: dir,
      positional: ["T-auth-1", "Need", "confirmation", "about", "token", "rotation"],
      flags: { as: "agent-auth" },
    });
    assert.equal(out.node.id, "T-auth-1");
    assert.equal(out.node.notes.length, 1);
    assert.equal(out.node.notes[0].agent, "agent-auth");
    assert.equal(out.node.notes[0].text, "Need confirmation about token rotation");

    const ctx = await context({ statePath: dir, positional: ["T-auth-1"], flags: {} });
    assert.equal(ctx.node.notes.length, 1);
    assert.equal(ctx.node.notes[0].text, "Need confirmation about token rotation");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: add-note works on a v2 node", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init", "--v2"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "auth-migration", "--desc", "test"]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli([
      "--project", dir, "add-node", "T-auth-1",
      "--kind", "resolvable",
      "--subkind", "task",
      "--title", "Implement session middleware",
      "--initiative", "auth-migration",
    ]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli([
      "--project", dir, "add-note", "T-auth-1", "Need confirmation about token rotation", "--as", "agent-auth",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.node.id, "T-auth-1");
    assert.equal(data.node.notes.length, 1);
    assert.equal(data.node.notes[0].text, "Need confirmation about token rotation");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-edge: BLOCKS cannot target knowledge in v2", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  const { default: addEdge } = await importFresh("./commands/add-edge.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "test" }, positional: ["auth-migration"] });
    await addNode({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: { kind: "resolvable", subkind: "task", title: "Implement session middleware", initiative: "auth-migration" },
    });
    await addNode({
      statePath: dir,
      positional: ["K-auth-ttl"],
      flags: {
        kind: "knowledge",
        title: "Redis sessions must refresh TTL",
        initiative: "auth-migration",
        "knowledge-type": "warning",
        mitigation: "Refresh TTL on each authenticated request",
        "scope-domains": "auth",
      },
    });

    await assert.rejects(
      addEdge({
        statePath: dir,
        positional: ["T-auth-1", "K-auth-ttl"],
        flags: { type: "BLOCKS" },
      }),
      (err) => err.code === "INVALID_EDGE_KIND" && /BLOCKS/.test(err.message)
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("context: returns blockers, informing edges, and scoped knowledge for a v2 task", async () => {
  const { default: context } = await importFresh("./commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      version: 2,
      nodes: {
        "T-auth-1": {
          id: "T-auth-1",
          kind: "resolvable",
          subkind: "task",
          resolution_mode: "labor",
          title: "Implement session middleware",
          domain: "auth",
          initiative: "auth-migration",
          tags: ["backend"],
          status: "open",
          definition: "Build middleware for opaque sessions",
          acceptance: "Authenticated requests refresh session TTL",
        },
        "G-auth-v2": {
          id: "G-auth-v2",
          kind: "resolvable",
          subkind: "gate",
          resolution_mode: "choice",
          title: "Replace JWT with opaque sessions",
          status: "resolved",
          resolution: {
            choice: "opaque sessions + redis",
            rationale: "Need instant revocation",
          },
        },
        "G-auth-rollout": {
          id: "G-auth-rollout",
          kind: "resolvable",
          subkind: "gate",
          resolution_mode: "choice",
          title: "Rollout notes",
          status: "resolved",
          resolution: {
            choice: "staged rollout",
            rationale: "Lower risk",
          },
        },
        "K-auth-ttl": {
          id: "K-auth-ttl",
          kind: "knowledge",
          title: "Redis sessions must refresh TTL",
          knowledge_type: "warning",
          status: "active",
          mitigation: "Refresh TTL on each authenticated request",
          scope: {
            domains: ["auth"],
          },
        },
      },
      edges: [
        { from: "G-auth-v2", to: "T-auth-1", type: "BLOCKS" },
        { from: "T-auth-1", to: "G-auth-rollout", type: "INFORMS" },
      ],
      log: [],
    });

    const out = await context({ statePath: dir, positional: ["T-auth-1"], flags: {} });
    assert.equal(out.derived_status, "ready");
    assert.equal(out.can_claim, true);
    assert.equal(out.blocking.length, 1);
    assert.equal(out.blocking[0].node.id, "G-auth-v2");
    assert.equal(out.blocking[0].satisfied, true);
    assert.equal(out.blocking[0].node.resolution.choice, "opaque sessions + redis");
    assert.equal(out.informing.length, 1);
    assert.equal(out.informing[0].node.id, "G-auth-rollout");
    assert.equal(out.knowledge.length, 1);
    assert.equal(out.knowledge[0].id, "K-auth-ttl");
    assert.deepEqual(out.knowledge[0].scope_matches, ["domain"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: v2 commands work end-to-end", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init", "--v2"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "auth-migration", "--desc", "test"]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli([
      "--project", dir, "add-node", "G-auth-v2",
      "--kind", "resolvable",
      "--subkind", "gate",
      "--initiative", "auth-migration",
      "--title", "Replace JWT with opaque sessions",
      "--status", "resolved",
      "--choice", "opaque sessions + redis",
      "--rationale", "Need instant revocation",
    ]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli([
      "--project", dir, "add-node", "T-auth-1",
      "--kind", "resolvable",
      "--subkind", "task",
      "--initiative", "auth-migration",
      "--title", "Implement session middleware",
      "--domain", "auth",
      "--definition", "Build middleware for opaque sessions",
      "--acceptance", "Authenticated requests refresh session TTL",
    ]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli([
      "--project", dir, "add-node", "K-auth-ttl",
      "--kind", "knowledge",
      "--initiative", "auth-migration",
      "--title", "Redis sessions must refresh TTL",
      "--knowledge-type", "warning",
      "--mitigation", "Refresh TTL on each authenticated request",
      "--scope-domains", "auth",
    ]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli([
      "--project", dir, "add-edge", "G-auth-v2", "T-auth-1", "--type", "BLOCKS",
    ]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli(["--project", dir, "context", "T-auth-1"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.derived_status, "ready");
    assert.equal(data.blocking[0].node.id, "G-auth-v2");
    assert.equal(data.knowledge[0].id, "K-auth-ttl");

    const state = await readRawState(dir);
    assert.equal(state.version, 2);
  } finally {
    await rmTempProject(dir);
  }
});
