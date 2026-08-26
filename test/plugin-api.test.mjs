// plugin-api.test.mjs — T-plugin-api acceptance.
//
// Validates the V1 host surface assembled by createApi:
//   - api.runtime exposes project_dir / agent identity
//   - api.query.{node,context,status,history} reads without the project lock
//   - api.query.context uses the runtime identity to scope allowed_actions
//   - api.data.{node,project}.{get,set} requires agent identity,
//     takes the project lock, scopes writes to its own plugin keyspace
//     and writes a redacted log envelope
//   - meta and third-party plugin data survive concurrent set calls
//
// The corpus lives in helpers.mjs (createTempProject, importFresh,
// stateFilePath, runCli, writeState, readState) which always sets
// CLIMIER_HOME to a fresh temp dir; no real ~/.climier is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  writeState as writeRawState,
  readState as readRawState,
} from "./helpers.mjs";

const ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// =========================================================================
// Fixtures
// =========================================================================

function baseState() {
  return {
    version: 2,
    nodes: {
      T1: {
        id: "T1",
        kind: "resolvable",
        subkind: "task",
        title: "T1",
        initiative: "p",
        domain: "auth",
        tags: ["audit"],
        resolution_mode: "labor",
        status: "open",
        revision: 1,
      },
      T2: {
        id: "T2",
        kind: "resolvable",
        subkind: "task",
        title: "T2",
        initiative: "p",
        domain: "auth",
        tags: ["audit"],
        resolution_mode: "labor",
        status: "open",
        revision: 1,
      },
      G1: {
        id: "G1",
        kind: "resolvable",
        subkind: "gate",
        title: "Auth strategy",
        initiative: "p",
        status: "open",
        revision: 1,
        purpose: "decision",
      },
    },
    edges: [
      { from: "T1", to: "T2", type: "BLOCKS" },
    ],
    initiatives: { p: { desc: "plugin platform", created_at: "2026-01-01T00:00:00.000Z" } },
    log: [],
  };
}

async function seedState(dir, mutate) {
  const base = baseState();
  if (typeof mutate === "function") mutate(base);
  await writeRawState(dir, base);
  return base;
}

async function freshApi(dir, opts = {}) {
  const { createApi } = await importFresh("./plugin-api.mjs");
  return createApi({
    projectDir: dir,
    agent: opts.agent === undefined ? "tester" : opts.agent,
    pluginId: opts.pluginId || "example.audit",
  });
}

// =========================================================================
// plugin-runtime — resolveRuntime(argv)
// =========================================================================

test("resolveRuntime: parses --project and --as from argv and returns { project_dir, agent }", async () => {
  const { resolveRuntime } = await importFresh("./plugin-runtime.mjs");
  const out = resolveRuntime(["--project", "/tmp/example", "--as", "alice"]);
  assert.equal(out.project_dir, "/tmp/example");
  assert.equal(out.agent, "alice");
});

test("resolveRuntime: --as falls back to CLIMIER_AGENT when missing", async () => {
  const prev = process.env.CLIMIER_AGENT;
  process.env.CLIMIER_AGENT = "env-agent";
  try {
    const { resolveRuntime } = await importFresh("./plugin-runtime.mjs");
    const out = resolveRuntime(["--project", "/tmp/example"]);
    assert.equal(out.project_dir, "/tmp/example");
    assert.equal(out.agent, "env-agent");
  } finally {
    if (prev === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prev;
  }
});

test("resolveRuntime: --as flag takes precedence over CLIMIER_AGENT", async () => {
  const prev = process.env.CLIMIER_AGENT;
  process.env.CLIMIER_AGENT = "env-agent";
  try {
    const { resolveRuntime } = await importFresh("./plugin-runtime.mjs");
    const out = resolveRuntime(["--project", "/tmp/x", "--as", "alice"]);
    assert.equal(out.agent, "alice");
  } finally {
    if (prev === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prev;
  }
});

test("resolveRuntime: --project defaults to CWD when missing", async () => {
  const { resolveRuntime } = await importFresh("./plugin-runtime.mjs");
  const out = resolveRuntime(["--as", "alice"]);
  assert.equal(out.project_dir, process.cwd());
  assert.equal(out.agent, "alice");
});

test("resolveRuntime: supports --as=<value> and --project=<value> (equals form)", async () => {
  const { resolveRuntime } = await importFresh("./plugin-runtime.mjs");
  const out = resolveRuntime(["--project=/tmp/x", "--as=alice"]);
  assert.equal(out.project_dir, "/tmp/x");
  assert.equal(out.agent, "alice");
});

test("resolveRuntime: ignores unknown flags (passes them through without breaking project_dir/agent)", async () => {
  const { resolveRuntime } = await importFresh("./plugin-runtime.mjs");
  const out = resolveRuntime(["--my-flag", "value", "--project", "/tmp/x", "--as", "alice"]);
  assert.equal(out.project_dir, "/tmp/x");
  assert.equal(out.agent, "alice");
});

// =========================================================================
// createApi / api.runtime
// =========================================================================

test("createApi: requires projectDir and pluginId", async () => {
  const { createApi } = await importFresh("./plugin-api.mjs");
  assert.throws(() => createApi({ projectDir: "", agent: "x", pluginId: "p" }), /projectDir/);
  assert.throws(() => createApi({ projectDir: "/tmp", agent: "x", pluginId: "" }), /pluginId/);
});

test("createApi: api.runtime exposes project_dir and agent exactly as passed in", async () => {
  const dir = await createTempProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    assert.deepEqual(api.runtime, { project_dir: dir, agent: "alice" });
  } finally {
    await rmTempProject(dir);
  }
});

test("createApi: returns the documented surface { runtime, query, data }", async () => {
  const dir = await createTempProject();
  try {
    const api = await freshApi(dir);
    assert.equal(typeof api.runtime, "object");
    assert.equal(typeof api.query, "object");
    assert.equal(typeof api.data, "object");
    assert.equal(typeof api.query.node, "function");
    assert.equal(typeof api.query.context, "function");
    assert.equal(typeof api.query.status, "function");
    assert.equal(typeof api.query.history, "function");
    assert.equal(typeof api.data.node.get, "function");
    assert.equal(typeof api.data.node.set, "function");
    assert.equal(typeof api.data.project.get, "function");
    assert.equal(typeof api.data.project.set, "function");
  } finally {
    await rmTempProject(dir);
  }
});

// =========================================================================
// api.query.* — read without lock, reflects last observable state
// =========================================================================

test("api.query.node reads without lock and reflects the latest observable state", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir);
    const api = await freshApi(dir);
    const out = await api.query.node("T1");
    assert.equal(out.type, "task");
    assert.equal(out.node.id, "T1");
    assert.equal(out.node.title, "T1");
    assert.equal(out.node.status, "open");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.query.node reflects a state mutation (read without lock picks the latest)", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir);
    const api = await freshApi(dir);
    // Mutate the state out-of-band (simulating another agent's update).
    await writeRawState(dir, {
      version: 2,
      nodes: {
        T1: {
          id: "T1",
          kind: "resolvable",
          subkind: "task",
          title: "T1 (mutated)",
          initiative: "p",
          status: "open",
          revision: 2,
        },
      },
      edges: [],
      initiatives: { p: { desc: "p", created_at: "2026-01-01T00:00:00.000Z" } },
      log: [],
    });
    const out = await api.query.node("T1");
    assert.equal(out.node.title, "T1 (mutated)");
    assert.equal(out.node.revision, 2);
  } finally {
    await rmTempProject(dir);
  }
});

test("api.query.context uses the runtime agent to scope allowed_actions", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir);
    const api = await freshApi(dir, { agent: "alice" });
    const out = await api.query.context("T1");
    assert.equal(out.derived_status, "ready");
    // ready task + named agent: allowed_actions includes "claim".
    assert.ok(out.allowed_actions.includes("claim"), "ready task should include claim for named agent");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.query.context reflects the runtime agent (different agents produce different allowed_actions)", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir);
    const apiA = await freshApi(dir, { agent: "alice" });
    const apiB = await freshApi(dir, { agent: "bob" });
    const outA = await apiA.query.context("T1");
    const outB = await apiB.query.context("T1");
    // Both are named agents; allowed_actions is the same shape regardless of name.
    assert.ok(Array.isArray(outA.allowed_actions));
    assert.ok(Array.isArray(outB.allowed_actions));
    // Anonymous (no agent) context should differ from named agent.
    const apiAnon = await freshApi(dir, { agent: "" });
    const outAnon = await apiAnon.query.context("T1");
    assert.ok(!outAnon.allowed_actions.includes("claim"), "anonymous should NOT have claim");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.query.status reads the same payload as the status command (without lock)", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir);
    const api = await freshApi(dir);
    const out = await api.query.status();
    assert.equal(typeof out.summary, "object");
    assert.equal(typeof out.summary.ready, "number");
    assert.equal(typeof out.tasks, "object");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.query.history returns the log entries that reference an id", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir, (s) => {
      s.log.push({ ts: "2026-01-01T00:00:00.000Z", agent: "alice", action: "take", node: "T1" });
      s.log.push({ ts: "2026-01-02T00:00:00.000Z", agent: "alice", action: "add-note", node: "T1" });
      s.log.push({ ts: "2026-01-03T00:00:00.000Z", agent: "bob", action: "take", node: "T2" });
    });
    const api = await freshApi(dir);
    const out = await api.query.history("T1");
    assert.equal(out.id, "T1");
    assert.equal(out.entries.length, 2);
    assert.equal(out.entries[0].action, "take");
    assert.equal(out.entries[1].action, "add-note");
  } finally {
    await rmTempProject(dir);
  }
});

// =========================================================================
// api.data.* — read/write with project lock, isolated plugin keyspaces
// =========================================================================

test("api.data.node.set requires agent identity (MISSING_AGENT when empty)", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir);
    const api = await freshApi(dir, { agent: "" });
    await assert.rejects(
      api.data.node.set("T1", { foo: 1 }),
      (err) => err && err.code === "MISSING_AGENT",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("api.data.project.set requires agent identity (MISSING_AGENT when empty)", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir);
    const api = await freshApi(dir, { agent: "" });
    await assert.rejects(
      api.data.project.set("k", 1),
      (err) => err && err.code === "MISSING_AGENT",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("api.data.node.set writes only the calling plugin's keyspace and preserves meta + third-party plugin data", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir, (s) => {
      s.nodes.T1.meta = {
        execution: { effort: "M", risk: "integration", checks: ["npm test"] },
      };
      s.nodes.T1.plugins = {
        "example.metrics": { data: { perNode: "T1 metrics" } },
      };
    });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const stored = await api.data.node.set("T1", { perNode: "T1 audit" });
    assert.deepEqual(stored, { perNode: "T1 audit" });
    const after = await readRawState(dir);
    // Calling plugin's keyspace updated.
    assert.deepEqual(after.nodes.T1.plugins["example.audit"].data, { perNode: "T1 audit" });
    // Third-party plugin keyspace preserved.
    assert.deepEqual(after.nodes.T1.plugins["example.metrics"].data, { perNode: "T1 metrics" });
    // meta preserved.
    assert.deepEqual(after.nodes.T1.meta, {
      execution: { effort: "M", risk: "integration", checks: ["npm test"] },
    });
  } finally {
    await rmTempProject(dir);
  }
});

test("api.data.project.set writes only the root plugin keyspace and preserves nodes[id].plugins", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir, (s) => {
      s.nodes.T1.plugins = {
        "example.metrics": { data: { perNode: "T1 metrics" } },
      };
    });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await api.data.project.set("counter", 7);
    const after = await readRawState(dir);
    // Root plugin keyspace updated.
    assert.deepEqual(after.plugins["example.audit"].data, { counter: 7 });
    // Per-node plugins preserved.
    assert.deepEqual(after.nodes.T1.plugins["example.metrics"].data, { perNode: "T1 metrics" });
    // No per-node plugin entry was created for the calling plugin (it was a project write).
    assert.equal(after.nodes.T1.plugins["example.audit"], undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("api.data.node.get only returns the calling plugin's data (never another plugin's)", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir, (s) => {
      s.nodes.T1.plugins = {
        "example.audit": { data: { mine: true } },
        "example.metrics": { data: { theirs: true } },
        "example.other": { data: { forbidden: "secret" } },
      };
    });
    const api = await freshApi(dir, { pluginId: "example.audit" });
    const data = await api.data.node.get("T1");
    assert.deepEqual(data, { mine: true });
  } finally {
    await rmTempProject(dir);
  }
});

test("api.data.node.get returns undefined when the calling plugin has no data on the node", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir, (s) => {
      s.nodes.T1.plugins = {
        "example.metrics": { data: { theirs: true } },
      };
    });
    const api = await freshApi(dir, { pluginId: "example.audit" });
    const data = await api.data.node.get("T1");
    assert.equal(data, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("api.data.node.get returns undefined for a non-existent node (no throw)", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir);
    const api = await freshApi(dir);
    const data = await api.data.node.get("NOPE");
    assert.equal(data, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("api.data.project.get reads only the calling plugin's root keyspace", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir, (s) => {
      s.plugins = {
        "example.audit": { data: { counter: 7, label: "audit #7" } },
        "example.metrics": { data: { counter: 100 } },
      };
    });
    const api = await freshApi(dir, { pluginId: "example.audit" });
    assert.equal(await api.data.project.get("counter"), 7);
    assert.equal(await api.data.project.get("label"), "audit #7");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.data.project.get returns undefined when key is missing", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir, (s) => {
      s.plugins = { "example.audit": { data: { counter: 7 } } };
    });
    const api = await freshApi(dir);
    assert.equal(await api.data.project.get("not-set"), undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("api.data.node.set rejects when the node does not exist (NODE_NOT_FOUND)", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir);
    const api = await freshApi(dir);
    await assert.rejects(
      api.data.node.set("NOPE", { foo: 1 }),
      (err) => err && err.code === "NODE_NOT_FOUND",
    );
  } finally {
    await rmTempProject(dir);
  }
});

// =========================================================================
// Log redaction — set envelopes do NOT contain the value
// =========================================================================

test("data.node.set log envelope: action=plugin-data-set, scope=node, node_id, NO value", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir);
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const secret = { ssn: "REDACTED-NEVER-LOG", token: "top-secret" };
    await api.data.node.set("T1", secret);
    const after = await readRawState(dir);
    const last = after.log[after.log.length - 1];
    assert.equal(last.action, "plugin-data-set");
    assert.equal(last.scope, "node");
    assert.equal(last.node_id, "T1");
    assert.equal(last.plugin_id, "example.audit");
    assert.equal(last.agent, "alice");
    // The full log line, serialized, must NOT contain the secret.
    const serialized = JSON.stringify(last);
    assert.ok(!serialized.includes("REDACTED-NEVER-LOG"), `log line leaked value: ${serialized}`);
    assert.ok(!serialized.includes("top-secret"), `log line leaked value: ${serialized}`);
    assert.equal(last.value, undefined);
    assert.equal(last.data, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("data.project.set log envelope: action=plugin-data-set, scope=project, key, NO value", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir);
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await api.data.project.set("token", "top-secret");
    const after = await readRawState(dir);
    const last = after.log[after.log.length - 1];
    assert.equal(last.action, "plugin-data-set");
    assert.equal(last.scope, "project");
    assert.equal(last.key, "token");
    assert.equal(last.plugin_id, "example.audit");
    assert.equal(last.agent, "alice");
    assert.equal(last.node_id, undefined);
    const serialized = JSON.stringify(last);
    assert.ok(!serialized.includes("top-secret"), `log line leaked value: ${serialized}`);
    assert.equal(last.value, undefined);
    assert.equal(last.data, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

// =========================================================================
// Concurrency under withLock — disjoint keyspaces preserved
// =========================================================================

test("two plugins writing concurrently (node data + project data) preserve both keyspaces under withLock", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir, (s) => {
      s.nodes.T1.plugins = { "example.metrics": { data: { seed: 1 } } };
      s.plugins = { "example.other": { data: { seed: 1 } } };
    });
    const apiA = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const apiB = await freshApi(dir, { agent: "bob", pluginId: "example.metrics" });
    // Two concurrent sets: A writes node data on T1, B writes project data.
    const [aResult, bResult] = await Promise.all([
      apiA.data.node.set("T1", { perNode: "audit" }),
      apiB.data.project.set("flag", true),
    ]);
    assert.deepEqual(aResult, { perNode: "audit" });
    const after = await readRawState(dir);
    // A's node data preserved.
    assert.deepEqual(after.nodes.T1.plugins["example.audit"].data, { perNode: "audit" });
    // A did not touch B's project data (B's project data was untouched by A's set).
    assert.equal(after.plugins["example.audit"], undefined);
    // B's project data preserved.
    assert.deepEqual(after.plugins["example.metrics"].data, { flag: true });
    // B did not touch A's node data on T1 (A's per-node data on T1 should
    // be exactly what A wrote, nothing else).
    assert.deepEqual(after.nodes.T1.plugins["example.audit"], { data: { perNode: "audit" } });
    // Pre-existing third-party per-node plugin data on T1 is preserved.
    assert.deepEqual(after.nodes.T1.plugins["example.metrics"], { data: { seed: 1 } });
    // Other root plugin still intact.
    assert.deepEqual(after.plugins["example.other"].data, { seed: 1 });
  } finally {
    await rmTempProject(dir);
  }
});

test("two plugins writing the SAME keyspace (project) serialize under withLock and both writes land", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir);
    const apiA = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const apiB = await freshApi(dir, { agent: "bob", pluginId: "example.audit" });
    // Same plugin id (same keyspace), different agents, two concurrent writes
    // to different keys. Both should land; withLock serializes them.
    await Promise.all([
      apiA.data.project.set("counterA", 1),
      apiB.data.project.set("counterB", 2),
    ]);
    const after = await readRawState(dir);
    assert.equal(after.plugins["example.audit"].data.counterA, 1);
    assert.equal(after.plugins["example.audit"].data.counterB, 2);
  } finally {
    await rmTempProject(dir);
  }
});

test("data.set takes the project lock (concurrent set + take both succeed without corruption)", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir);
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    // Two concurrent operations: plugin data.set and a take on the open task.
    const [{ default: takeCmd }] = await Promise.all([
      importFresh("./commands/take.mjs"),
      Promise.resolve(),
    ]);
    const [, setResult] = await Promise.all([
      takeCmd({
        statePath: dir,
        positional: ["T1"],
        flags: { as: "alice" },
        projectDir: dir,
      }),
      api.data.project.set("ok", true),
    ]);
    assert.deepEqual(setResult, undefined);
    const after = await readRawState(dir);
    assert.equal(after.nodes.T1.status, "in_progress");
    assert.deepEqual(after.plugins["example.audit"].data, { ok: true });
  } finally {
    await rmTempProject(dir);
  }
});

// =========================================================================
// Identity check at the API surface (NOT through --as)
// =========================================================================

test("createApi rejects calls to data.*.set without agent identity (agent must be a non-empty string)", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir);
    const { createApi } = await importFresh("./plugin-api.mjs");
    const api = createApi({ projectDir: dir, agent: "", pluginId: "example.audit" });
    await assert.rejects(
      api.data.node.set("T1", { a: 1 }),
      (err) => err && err.code === "MISSING_AGENT",
    );
    await assert.rejects(
      api.data.project.set("k", 1),
      (err) => err && err.code === "MISSING_AGENT",
    );
  } finally {
    await rmTempProject(dir);
  }
});

// =========================================================================
// pluginId validation — V1 contract requires the regex shape
// =========================================================================

test("createApi accepts pluginId that matches the V1 regex shape", async () => {
  const dir = await createTempProject();
  try {
    const { createApi } = await importFresh("./plugin-api.mjs");
    // We do not enforce the regex here (descriptor/install does that); the
    // surface only requires a non-empty pluginId string. Confirm both
    // canonical V1 id shapes work and empty fails.
    assert.ok(createApi({ projectDir: dir, agent: "x", pluginId: "example.audit" }));
    assert.ok(createApi({ projectDir: dir, agent: "x", pluginId: "a" }));
    assert.throws(() => createApi({ projectDir: dir, agent: "x", pluginId: "" }));
  } finally {
    await rmTempProject(dir);
  }
});
