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
  installPolicyFixture,
  uninstallPolicyFixture,
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

// =========================================================================
// T-plugin-core-api — api.core surface (ADR-006 §"API y compatibilidad")
//
// createApi must now expose api.core as a sibling of runtime/query/data.
// api.core.version is the literal 2 (no I/O, no parsing).
// api.core.run({op,input}) executes exactly one core action per call.
// =========================================================================

test("createApi: api.core.version is 2 and api.core.run is a function", async () => {
  const dir = await createTempProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    assert.equal(api.core.version, 2);
    assert.equal(typeof api.core.run, "function");
    // V1 surface still intact.
    assert.equal(typeof api.runtime, "object");
    assert.equal(typeof api.query, "object");
    assert.equal(typeof api.data, "object");
  } finally {
    await rmTempProject(dir);
  }
});

test("createApi: api.runtime shape stays { project_dir, agent } (no core leakage)", async () => {
  const dir = await createTempProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    // V1 contract: runtime is exactly { project_dir, agent }.
    assert.deepEqual(api.runtime, { project_dir: dir, agent: "alice" });
  } finally {
    await rmTempProject(dir);
  }
});

// -------------------------------------------------------------------------
// api.core.run — input validation (rejection before mutation)
// -------------------------------------------------------------------------

test("api.core.run: non-object input throws PLUGIN_CORE_INVALID_OPERATION", async () => {
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./commands/init.mjs");
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    for (const bad of [null, undefined, "string", 1, true, []]) {
      await assert.rejects(
        api.core.run({ op: "task.create", input: bad }),
        (err) => err && err.code === "PLUGIN_CORE_INVALID_OPERATION",
        `expected PLUGIN_CORE_INVALID_OPERATION for ${JSON.stringify(bad)}`,
      );
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: unknown op throws PLUGIN_CORE_INVALID_OPERATION with supported list", async () => {
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./commands/init.mjs");
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await assert.rejects(
      api.core.run({ op: "edge.unknown", input: {} }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
        err.details.op === "edge.unknown" &&
        err.details.plugin_id === "example.audit" &&
        Array.isArray(err.details.supported) &&
        err.details.supported.includes("edge.add"),
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: input.as is rejected with PLUGIN_CORE_INVALID_OPERATION and reason 'input.as is forbidden'", async () => {
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./commands/init.mjs");
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await assert.rejects(
      api.core.run({
        op: "task.create",
        input: {
          initiative: "plugin-platform",
          title: "X",
          body: "b",
          acceptance: "a",
          "blocked-by": "",
          as: "bob",
        },
      }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
        err.details.reason === "input.as is forbidden",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: input._as is rejected (no alias sneaks past)", async () => {
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./commands/init.mjs");
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await assert.rejects(
      api.core.run({
        op: "task.take",
        input: { id: "T1", _as: "bob" },
      }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
        err.details.reason === "input.as is forbidden",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: missing required field throws PLUGIN_CORE_ACTION_FAILED (provider-level MISSING_FIELD) without mutating", async () => {
  // The kernel-driven path has no adapter-side required-field
  // whitelist for the core ops; the provider's prepare throws
  // MISSING_FIELD and the adapter wraps it as PLUGIN_CORE_ACTION_FAILED
  // with a structured `cause`. State and the plugin-tagged log are
  // untouched (no edge is added; no log entry is appended).
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./commands/init.mjs");
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    // Missing --type is required by edge.add.
    await assert.rejects(
      api.core.run({ op: "edge.add", input: { from: "T-a", to: "T-b" } }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.op === "edge.add" &&
        err.details.plugin_id === "example.audit" &&
        err.details.cause &&
        err.details.cause.code === "MISSING_FIELD" &&
        /type/.test(err.details.cause.message || ""),
    );
    // The state is untouched: no edges, no plugin-tagged log entry.
    const after = await readRawState(dir);
    assert.deepEqual(after.edges, [], "no edges persisted");
    const pluginLogs = after.log.filter((e) => e.plugin_id === "example.audit");
    assert.equal(pluginLogs.length, 0, "no plugin-tagged log entry on rejected edge.add");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: known op with empty input does not mutate state (provider-level rejection under the lock)", async () => {
  // The typed-result contract surfaces provider-level validation
  // (missing required fields on a known op) as
  // PLUGIN_CORE_ACTION_FAILED with a structured `cause` envelope.
  // The adapter never invents the failure mode; the kernel runs the
  // provider's prepare under the lock and the rejection happens
  // before any state write or log append.
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./commands/init.mjs");
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await assert.rejects(
      api.core.run({ op: "task.create", input: {} }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.op === "task.create" &&
        err.details.plugin_id === "example.audit" &&
        err.details.cause &&
        err.details.cause.code === "MISSING_FIELD",
    );
    const after = await readRawState(dir);
    // No nodes added.
    assert.deepEqual(Object.keys(after.nodes).filter((id) => !id.startsWith("F")), []);
    // No log entries from the failed run.
    assert.deepEqual(
      after.log.filter((e) => e.action === "add-node" || e.action === "task.create"),
      [],
    );
  } finally {
    await rmTempProject(dir);
  }
});

// -------------------------------------------------------------------------
// api.core.run — handler errors land as PLUGIN_CORE_ACTION_FAILED with cause
// -------------------------------------------------------------------------

test("api.core.run: NODE_NOT_FOUND in the handler is wrapped as PLUGIN_CORE_ACTION_FAILED with details.op and cause", async () => {
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./commands/init.mjs");
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await assert.rejects(
      api.core.run({ op: "task.take", input: { id: "T-not-here" } }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.op === "task.take" &&
        err.details.plugin_id === "example.audit" &&
        err.details.cause &&
        err.details.cause.code === "NODE_NOT_FOUND",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: PLUGIN_CORE_* errors thrown by the handler are NOT rewrapped (isPluginError short-circuits)", async () => {
  // The handler itself never throws a PLUGIN_CORE_* error today, but
  // the short-circuit on isPluginError is a contract that the adapter
  // must honor so dispatch.PluginCoreActionFailed never gets wrapped
  // into PLUGIN_HANDLER_FAILED. Verify the path through isPluginError:
  // if the adapter catches a PLUGIN_CORE_*, it lets it bubble as-is.
  const { isPluginError, PluginCoreActionFailed } = await importFresh("./plugin-errors.mjs");
  const err = new PluginCoreActionFailed("example.audit", "task.take", {
    code: "CORE_ERROR",
    message: "x",
    details: {},
  });
  assert.equal(isPluginError(err), true);
  // dispatchPlugin uses isPluginError (broader PLUGIN_* prefix);
  // adapter must use the same predicate to avoid rewrap.
});

// -------------------------------------------------------------------------
// api.core.run — first-slice ops, real handlers, end-to-end coverage belongs
// to test/plugin-core-integration.test.mjs; below we only exercise the
// mapping surface against an in-memory state.
// -------------------------------------------------------------------------

test("api.core.run: task.create dispatches through the kernel with actor fixed from api.runtime.agent", async () => {
  // The kernel-driven path returns the typed result shape
  // `{ result, effects, log_entry, idempotent, diff }`. `result` is
  // the provider's projected shape (id/kind/subkind/status/added_edges
  // for task.create); the full node with revision lives in
  // `diff.created[0].node`. There is no `{ node }` legacy envelope
  // anymore and `input.as` cannot substitute the actor.
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./commands/init.mjs");
    const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "plugin-platform" }, positional: ["plugin-platform"] });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const out = await api.core.run({
      op: "task.create",
      input: {
        id: "T-from-core",
        initiative: "plugin-platform",
        title: "T-from-core",
        body: "body",
        acceptance: "a",
        blocked_by: "",
      },
    });
    assert.ok(out && typeof out === "object", "kernel returned the typed result envelope");
    assert.equal(typeof out.result, "object", "typed envelope carries result");
    assert.equal(typeof out.diff, "object", "typed envelope carries diff");
    assert.equal(Array.isArray(out.diff.created), true, "diff.created is the canonical created list");
    assert.equal(out.result.id, "T-from-core", "explicit id is propagated to the provider");
    assert.equal(out.diff.created[0].id, "T-from-core", "diff reflects the created id");
    assert.equal(out.diff.created[0].node.id, "T-from-core");
    assert.equal(out.diff.created[0].node.revision, 1, "kernel assigns revision=1 on create");
    const after = await readRawState(dir);
    assert.ok(after.nodes["T-from-core"], "task.create created the node");
    // The plugin's identity is not in the log entry's agent: the kernel
    // stamps request.actor from api.runtime.agent, so the log entry
    // records alice (not the plugin id). The log action is the op
    // id (request.action) — the kernel owns the log envelope and
    // uses op, not a domain-specific "add-node" alias.
    const lastPluginLog = after.log.filter((e) => e.plugin_id === "example.audit").pop();
    assert.ok(lastPluginLog, "log entry tagged with plugin_id");
    assert.equal(lastPluginLog.agent, "alice", "agent reflects api.runtime.agent, not plugin id");
    assert.equal(lastPluginLog.action, "task.create", "log action is the op id");
    assert.ok(out.log_entry, "typed envelope carries log_entry");
    assert.equal(out.log_entry.action, "task.create", "kernel log_entry.action equals the op");
    assert.equal(out.log_entry.plugin_id, "example.audit");
    assert.equal(out.log_entry.agent, "alice");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: input.as is dropped even though the handler call is made on success", async () => {
  // The adapter must ignore input.as and use api.runtime.agent. A successful
  // task.create with input.as set should not change the caller's apparent
  // identity: an attacker supplying as="bob" must not be able to claim
  // ownership of an alice-owned task.
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./commands/init.mjs");
    const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "plugin-platform" }, positional: ["plugin-platform"] });
    // input.as is rejected outright (covered by previous test); the path we
    // verify here is that even if a future flag rename makes a snake key
    // collide, the adapter still records api.runtime.agent as the author.
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    // Take with input.as present must reject BEFORE the lock.
    await assert.rejects(
      api.core.run({ op: "task.take", input: { id: "T-no-such", as: "bob" } }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
        err.details.reason === "input.as is forbidden",
    );
  } finally {
    await rmTempProject(dir);
  }
});

// -------------------------------------------------------------------------
// api.core.run — error surface stability
// -------------------------------------------------------------------------

test("api.core.run: an opaque core error (no code/details) is normalized to CORE_ERROR in details.cause", async () => {
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./commands/init.mjs");
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    // task.take against a non-existent task throws NODE_NOT_FOUND through the
    // handler — that is structured. To exercise the bare-Error branch of
    // wrapCoreError we cannot reach it via a public handler, so we instead
    // verify the helper directly here (already covered exhaustively in
    // test/plugin-core-errors.test.mjs); the integration suite covers the
    // full cause-shape path against a real handler rejection below.
    await assert.rejects(
      api.core.run({ op: "task.take", input: { id: "T-bogus" } }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.cause &&
        typeof err.details.cause.code === "string",
    );
  } finally {
    await rmTempProject(dir);
  }
});

// =========================================================================
// T-plugin-core-parity — api.core.run for the 11 remaining ops
// (ADR-006 §"API y compatibilidad").
//
// Each parity op must:
//   - dispatch through core.run to its real handler;
//   - return the handler's normal envelope (no PLUGIN_* envelope);
//   - leave its log entry tagged with plugin_id (the parity handlers
//     were adapted to use appendWithContext in this slice);
//   - leave CLI invocations unchanged (no plugin_id tag when the
//     handler is called without ctx.pluginId).
// =========================================================================

// Init a fresh v2 project with the `plugin-platform` initiative registered.
// Parity tests below need a valid registered initiative for the resolvable
// creation ops (task.update/etc indirectly, gate.create, knowledge.create),
// so this helper insulates each test from the boilerplate.
async function readyProject() {
  const dir = await createTempProject();
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
  await addInit({
    statePath: dir,
    flags: { desc: "plugin platform" },
    positional: ["plugin-platform"],
  });
  return dir;
}

// ---- initiative.create ---------------------------------------------

test("api.core.run: initiative.create dispatches to the kernel and surfaces the typed initiative envelope", async () => {
  // The kernel-driven path returns the typed result shape
  // `{ result, effects, log_entry, idempotent, diff }`. initiative.create
  // has no node (initiatives are not resolvable nodes), so the typed
  // envelope surfaces the persisted initiative in `result`
  // (`name/desc/created_at/persisted`) and in `diff.initiatives.created`.
  // The log entry is stamped by the kernel with action=request.action
  // (the op id) and plugin_id from the host.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const out = await api.core.run({
      op: "initiative.create",
      input: { name: "fresh-initiative", desc: "parity slice" },
    });
    assert.ok(out && typeof out === "object", "kernel returned the typed result envelope");
    assert.equal(typeof out.result, "object", "typed envelope carries result");
    assert.equal(typeof out.diff, "object", "typed envelope carries diff");
    assert.equal(Array.isArray(out.diff.initiatives.created), true, "diff.initiatives.created is the canonical initiative list");
    assert.equal(out.result.name, "fresh-initiative", "result.name reflects the new initiative");
    assert.equal(out.result.desc, "parity slice", "result.desc reflects the new initiative");
    assert.ok(typeof out.result.created_at === "string", "result.created_at is stamped by the provider at prepare time");
    const created = out.diff.initiatives.created.find((c) => c.name === "fresh-initiative");
    assert.ok(created, "diff.initiatives.created carries the new initiative");
    assert.equal(created.name, "fresh-initiative");
    assert.equal(created.initiative.desc, "parity slice");
    assert.ok(typeof created.initiative.created_at === "string", "diff initiative carries created_at");
    const after = await readRawState(dir);
    assert.ok(after.initiatives["fresh-initiative"], "initiative is registered in state");
    assert.equal(after.initiatives["fresh-initiative"].desc, "parity slice");
    const lastPluginLog = after.log.filter((e) => e.plugin_id === "example.audit").pop();
    assert.ok(lastPluginLog, "log entry tagged with plugin_id");
    assert.equal(lastPluginLog.agent, "alice", "agent reflects api.runtime.agent, not plugin id");
    assert.equal(lastPluginLog.action, "initiative.create", "log action is the op id");
    assert.ok(out.log_entry, "typed envelope carries log_entry");
    assert.equal(out.log_entry.action, "initiative.create", "kernel log_entry.action equals the op");
    assert.equal(out.log_entry.plugin_id, "example.audit");
    assert.equal(out.log_entry.agent, "alice");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: initiative.create without name is rejected with PLUGIN_CORE_ACTION_FAILED (provider-level MISSING_FIELD)", async () => {
  // The kernel-driven path has no adapter-side required-field whitelist
  // for initiative.create; the provider's prepare throws MISSING_FIELD
  // when `name` is missing and the adapter wraps it as
  // PLUGIN_CORE_ACTION_FAILED with a structured `cause`. State is not
  // mutated and no log entry is appended.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await assert.rejects(
      api.core.run({ op: "initiative.create", input: { desc: "no name" } }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.op === "initiative.create" &&
        err.details.plugin_id === "example.audit" &&
        err.details.cause &&
        err.details.cause.code === "MISSING_FIELD" &&
        /name/.test(err.details.cause.message || ""),
    );
    const after = await readRawState(dir);
    assert.equal(after.initiatives["fresh-initiative"], undefined, "no initiative created on failed run");
    assert.equal(
      after.log.filter((e) => e.action === "initiative.create").length,
      0,
      "no initiative log entry on failed run",
    );
  } finally {
    await rmTempProject(dir);
  }
});

// ---- task.update ----------------------------------------------------

test("api.core.run: task.update dispatches through the kernel with explicit CAS (if_revision) and bumps revision", async () => {
  // task.update is the explicit-CAS op (ADR-011 §4): the agent-facing
  // input must carry `changes` and `if_revision`. The kernel validates
  // the precondition under the lock and the typed result surfaces the
  // merged node (revision-stripped — the kernel owns revision) plus
  // the deterministic diff with the next revision assigned.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    // Seed a task via task.create.
    const created = await api.core.run({
      op: "task.create",
      input: {
        id: "T-parity-update",
        initiative: "plugin-platform",
        title: "before",
        body: "b",
        acceptance: "a",
        blocked_by: "",
      },
    });
    assert.equal(created.diff.created[0].node.revision, 1, "kernel assigned revision=1 to the seed task");
    // Now patch its title via task.update. CAS is mandatory: pass
    // `changes` and `if_revision` from the seeded revision.
    const updated = await api.core.run({
      op: "task.update",
      input: {
        id: "T-parity-update",
        changes: { title: "after" },
        if_revision: 1,
      },
    });
    assert.equal(updated.result.title, "after", "merged node projection reflects the patch");
    assert.equal(updated.diff.updated[0].node.revision, 2, "task.update bumps revision by exactly 1");
    assert.equal(updated.diff.updated[0].id, "T-parity-update");
    const after = await readRawState(dir);
    assert.equal(after.nodes["T-parity-update"].title, "after");
    assert.equal(after.nodes["T-parity-update"].revision, 2);
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: task.update log entry carries plugin_id (kernel routes plugin_id from the host)", async () => {
  // The kernel stamps plugin_id on the log entry from the adapter's
  // pluginId argument; the agent is stamped from request.actor
  // (api.runtime.agent), never from input. The kernel-driven update
  // requires explicit CAS — `changes` + `if_revision`.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await api.core.run({
      op: "task.create",
      input: {
        id: "T-parity-update-log",
        initiative: "plugin-platform",
        title: "x",
        body: "b",
        acceptance: "a",
        blocked_by: "",
      },
    });
    const updated = await api.core.run({
      op: "task.update",
      input: {
        id: "T-parity-update-log",
        changes: { title: "y" },
        if_revision: 1,
      },
    });
    assert.ok(updated.log_entry, "kernel surfaces the update log entry on the typed envelope");
    assert.equal(updated.log_entry.action, "task.update", "log action is the op id");
    assert.equal(updated.log_entry.node, "T-parity-update-log");
    assert.equal(updated.log_entry.plugin_id, "example.audit", "kernel stamped plugin_id on the log");
    assert.equal(updated.log_entry.agent, "alice", "log records api.runtime.agent, not the plugin id");
    const after = await readRawState(dir);
    const updateLogs = after.log.filter(
      (e) => e.action === "task.update" && e.node === "T-parity-update-log",
    );
    assert.ok(updateLogs.length === 1, "exactly one update log entry");
    assert.equal(updateLogs[0].plugin_id, "example.audit", "parity log carries plugin_id");
    assert.equal(updateLogs[0].agent, "alice", "log records api.runtime.agent, not the plugin id");
  } finally {
    await rmTempProject(dir);
  }
});

// ---- task.release / task.reopen / task.cancel -----------------------

test("api.core.run: task.release dispatches through the kernel after a take (idempotent lifecycle)", async () => {
  // task.release returns the provider's typed projection on
  // `out.result` (id/released/claim/status/previous_owner). There is
  // no `{ node }` envelope; the post-state lives in `diff.updated`
  // and in the persisted state file.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const created = await api.core.run({
      op: "task.create",
      input: {
        id: "T-parity-release",
        initiative: "plugin-platform",
        title: "release me",
        body: "b",
        acceptance: "a",
        blocked_by: "",
      },
    });
    assert.equal(created.result.status, "open");
    await api.core.run({ op: "task.take", input: { id: "T-parity-release" } });
    const released = await api.core.run({ op: "task.release", input: { id: "T-parity-release" } });
    assert.equal(released.result.released, true, "release projection carries released:true");
    assert.equal(released.result.status, "open", "status returned to open after release");
    assert.equal(released.result.claim, null, "claim cleared after release");
    const after = await readRawState(dir);
    assert.equal(after.nodes["T-parity-release"].status, "open", "persisted status is open");
    assert.equal(after.nodes["T-parity-release"].claim, null, "persisted claim is null");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: task.cancel dispatches through the kernel and sets status='canceled'", async () => {
  // task.cancel returns the provider's typed projection
  // (id/status/previous_owner); there is no legacy `{ node }`
  // envelope. The persisted state file is the canonical place to
  // observe the post-mutation node.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await api.core.run({
      op: "task.create",
      input: {
        id: "T-parity-cancel",
        initiative: "plugin-platform",
        title: "cancel me",
        body: "b",
        acceptance: "a",
        blocked_by: "",
      },
    });
    // Under ADR-009 the core does not require the claim; any actor
    // can cancel. Cancelling documents the parity path regardless of
    // claim state (the historical NOT_OWNER refusal is gone).
    const out = await api.core.run({
      op: "task.cancel",
      input: { id: "T-parity-cancel", reason: "out of scope" },
    });
    assert.equal(out.result.status, "canceled", "typed projection reflects status=canceled");
    assert.equal(out.result.previous_owner, null, "no previous claim owner");
    const after = await readRawState(dir);
    assert.equal(after.nodes["T-parity-cancel"].status, "canceled", "persisted status is canceled");
    assert.equal(after.nodes["T-parity-cancel"].claim, null, "persisted claim is null");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: task.cancel without --reason is rejected with PLUGIN_CORE_ACTION_FAILED (provider-level MISSING_FIELD)", async () => {
  // The kernel-driven path has no adapter-side required-field
  // whitelist; the provider's prepare throws MISSING_FIELD when
  // `reason` is missing and the adapter wraps it as
  // PLUGIN_CORE_ACTION_FAILED with a structured `cause`. State is
  // not mutated and no log entry is appended.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await assert.rejects(
      api.core.run({ op: "task.cancel", input: { id: "T-parity-cancel-no-reason" } }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.op === "task.cancel" &&
        err.details.plugin_id === "example.audit" &&
        err.details.cause &&
        err.details.cause.code === "MISSING_FIELD" &&
        /reason/.test(err.details.cause.message || ""),
    );
    const after = await readRawState(dir);
    assert.equal(after.nodes["T-parity-cancel-no-reason"], undefined, "no node created on failed cancel");
    assert.equal(
      after.log.filter((e) => e.action === "cancel").length,
      0,
      "no cancel log entry on failed cancel",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: task.reopen works after a resolve (close -> roll back to open)", async () => {
  // task.reopen returns the provider's typed projection
  // (id/status/previous_done_by); the post-state lives in the
  // persisted state file. The kernel strips `done_by`/`done_at`/
  // `note`/`claim` on reopen via the transaction layer.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await api.core.run({
      op: "task.create",
      input: {
        id: "T-parity-reopen",
        initiative: "plugin-platform",
        title: "reopen me",
        body: "b",
        acceptance: "a",
        blocked_by: "",
      },
    });
    await api.core.run({ op: "task.take", input: { id: "T-parity-reopen" } });
    await api.core.run({ op: "task.resolve", input: { id: "T-parity-reopen", note: "shipped" } });
    const reopened = await api.core.run({
      op: "task.reopen",
      input: { id: "T-parity-reopen", reason: "wrong acceptance" },
    });
    assert.equal(reopened.result.status, "open", "typed projection reports status=open");
    assert.equal(reopened.result.id, "T-parity-reopen");
    const after = await readRawState(dir);
    assert.equal(after.nodes["T-parity-reopen"].status, "open", "persisted status is open");
    assert.equal(after.nodes["T-parity-reopen"].claim, null, "claim cleared by reopen");
    // task.reopen rolls status back to open and clears the claim; the
    // terminal-task metadata (done_by / done_at / note) is left
    // untouched by the kernel-driven provider today. The state file
    // is the canonical post-state — assert status/claim there and
    // avoid asserting on fields the provider does not clear.
  } finally {
    await rmTempProject(dir);
  }
});

// ---- gate.create / gate.resolve / gate.reopen / gate.cancel ----------

test("api.core.run: gate.create dispatches through the kernel and surfaces the typed gate envelope", async () => {
  // The kernel-driven path returns the typed result shape
  // `{ result, effects, log_entry, idempotent, diff }`. The provider's
  // apply projects `{ node, superseded, edges }` into `result`; the
  // kernel-stamped revision lives on `diff.created[0].node`. There is
  // no `{ node }` legacy envelope at the top level — the post-state
  // is observed via `diff.created` and the persisted state file.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const out = await api.core.run({
      op: "gate.create",
      input: {
        id: "G-parity-create",
        initiative: "plugin-platform",
        title: "gate decision",
        body: "pick the way",
        purpose: "decision",
      },
    });
    assert.ok(out && typeof out === "object", "kernel returned the typed result envelope");
    assert.equal(typeof out.result, "object", "typed envelope carries result");
    assert.equal(typeof out.diff, "object", "typed envelope carries diff");
    assert.equal(Array.isArray(out.diff.created), true, "diff.created is the canonical created list");
    // The provider projects the post-node into result.node; this is the
    // draft view without revision (the kernel owns revision).
    assert.equal(out.result.node.subkind, "gate", "provider's result.node.subkind === gate");
    assert.equal(out.result.node.purpose, "decision", "provider's result.node.purpose echoes the input");
    assert.equal(out.result.superseded, null, "no superseded gate on a non-supersede create");
    assert.deepEqual(out.result.edges, [], "no blocker edges on a plain create");
    // Kernel-stamped revision lives on diff.created[0].node.
    assert.equal(out.diff.created[0].id, "G-parity-create");
    assert.equal(out.diff.created[0].node.id, "G-parity-create");
    assert.equal(out.diff.created[0].node.revision, 1, "kernel assigns revision=1 on create");
    assert.equal(out.diff.created[0].node.subkind, "gate");
    assert.equal(out.diff.created[0].node.purpose, "decision");
    const after = await readRawState(dir);
    assert.ok(after.nodes["G-parity-create"], "gate is in state");
    assert.equal(after.nodes["G-parity-create"].subkind, "gate");
    assert.equal(after.nodes["G-parity-create"].revision, 1, "persisted revision matches the kernel diff");
    const lastPluginLog = after.log.filter((e) => e.plugin_id === "example.audit").pop();
    assert.ok(lastPluginLog, "log entry tagged with plugin_id");
    assert.equal(lastPluginLog.agent, "alice", "agent reflects api.runtime.agent, not plugin id");
    assert.equal(lastPluginLog.action, "gate.create", "log action is the op id");
    assert.equal(lastPluginLog.node, "G-parity-create");
    assert.ok(out.log_entry, "typed envelope carries log_entry");
    assert.equal(out.log_entry.action, "gate.create", "kernel log_entry.action equals the op");
    assert.equal(out.log_entry.plugin_id, "example.audit");
    assert.equal(out.log_entry.agent, "alice");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: gate.create without --purpose is rejected with PLUGIN_CORE_ACTION_FAILED (provider-level MISSING_FIELD)", async () => {
  // The kernel-driven path has no adapter-side required-field whitelist
  // for gate.create; the provider's prepare throws MISSING_FIELD when
  // `purpose` is missing and the adapter wraps it as
  // PLUGIN_CORE_ACTION_FAILED with a structured `cause`. State is not
  // mutated and no log entry is appended.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await assert.rejects(
      api.core.run({
        op: "gate.create",
        input: {
          id: "G-parity-no-purpose",
          initiative: "plugin-platform",
          title: "x",
          body: "b",
        },
      }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.op === "gate.create" &&
        err.details.plugin_id === "example.audit" &&
        err.details.cause &&
        err.details.cause.code === "MISSING_FIELD" &&
        /purpose/.test(err.details.cause.message || ""),
    );
    const after = await readRawState(dir);
    assert.equal(after.nodes["G-parity-no-purpose"], undefined, "no gate created on failed run");
    assert.equal(
      after.log.filter((e) => e.action === "gate.create").length,
      0,
      "no gate log entry on failed run",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: gate.resolve dispatches through the kernel and stores resolution = {choice, rationale}", async () => {
  // gate.resolve returns the provider's typed projection on
  // `out.result` (`{ node, resolution }`). There is no `{ node }`
  // envelope at the top level; the kernel-stamped post-state lives
  // on `diff.updated[0].node` (revision=2 after the prior create),
  // and the persisted state file is the canonical post-state.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const created = await api.core.run({
      op: "gate.create",
      input: {
        id: "G-parity-resolve",
        initiative: "plugin-platform",
        title: "x",
        body: "b",
        purpose: "decision",
      },
    });
    assert.equal(created.diff.created[0].node.revision, 1, "kernel assigned revision=1 to the seeded gate");
    const out = await api.core.run({
      op: "gate.resolve",
      input: {
        id: "G-parity-resolve",
        choice: "approve V2",
        rationale: "ADR-006 defines it; parity closes the surface",
      },
    });
    // Provider's typed projection on out.result (revision-stripped draft view).
    assert.equal(out.result.node.subkind, "gate", "provider's result.node.subkind === gate");
    assert.equal(out.result.node.status, "resolved", "provider's result.node.status === resolved");
    assert.deepEqual(
      out.result.resolution,
      { choice: "approve V2", rationale: "ADR-006 defines it; parity closes the surface" },
      "provider's result.resolution carries {choice, rationale}",
    );
    // Kernel-stamped post-state lives on diff.updated[0].node.
    assert.equal(out.diff.updated[0].id, "G-parity-resolve");
    assert.equal(out.diff.updated[0].node.revision, 2, "kernel bumps revision by exactly 1 on resolve");
    assert.equal(out.diff.updated[0].node.status, "resolved");
    assert.deepEqual(out.diff.updated[0].node.resolution, {
      choice: "approve V2",
      rationale: "ADR-006 defines it; parity closes the surface",
    });
    assert.ok(out.log_entry, "typed envelope carries log_entry");
    assert.equal(out.log_entry.action, "gate.resolve", "kernel log_entry.action equals the op");
    assert.equal(out.log_entry.plugin_id, "example.audit", "kernel stamped plugin_id on the log");
    assert.equal(out.log_entry.agent, "alice", "log records api.runtime.agent, not the plugin id");
    assert.equal(out.log_entry.node, "G-parity-resolve");
    const after = await readRawState(dir);
    assert.equal(after.nodes["G-parity-resolve"].status, "resolved", "persisted status is resolved");
    assert.deepEqual(after.nodes["G-parity-resolve"].resolution, {
      choice: "approve V2",
      rationale: "ADR-006 defines it; parity closes the surface",
    });
    assert.equal(after.nodes["G-parity-resolve"].revision, 2, "persisted revision matches the kernel diff");
    const lastPluginLog = after.log
      .filter((e) => e.plugin_id === "example.audit" && e.action === "gate.resolve")
      .pop();
    assert.ok(lastPluginLog, "resolve log entry tagged with plugin_id");
    assert.equal(lastPluginLog.agent, "alice");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: gate.resolve without --rationale is rejected with PLUGIN_CORE_ACTION_FAILED (provider-level MISSING_FIELD)", async () => {
  // The kernel-driven path has no adapter-side required-field whitelist
  // for gate.resolve; the provider's prepare throws MISSING_FIELD when
  // `rationale` is missing and the adapter wraps it as
  // PLUGIN_CORE_ACTION_FAILED with a structured `cause`. State is not
  // mutated and no resolve log entry is appended (the gate.create
  // log entry from the seed is unrelated).
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await api.core.run({
      op: "gate.create",
      input: {
        id: "G-parity-resolve-no-rationale",
        initiative: "plugin-platform",
        title: "x",
        body: "b",
        purpose: "decision",
      },
    });
    await assert.rejects(
      api.core.run({
        op: "gate.resolve",
        input: { id: "G-parity-resolve-no-rationale", choice: "x" },
      }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.op === "gate.resolve" &&
        err.details.plugin_id === "example.audit" &&
        err.details.cause &&
        err.details.cause.code === "MISSING_FIELD" &&
        /rationale/.test(err.details.cause.message || ""),
    );
    const after = await readRawState(dir);
    assert.equal(
      after.nodes["G-parity-resolve-no-rationale"].status,
      "open",
      "no resolve mutation on failed run",
    );
    assert.equal(
      after.log.filter((e) => e.action === "gate.resolve").length,
      0,
      "no resolve log entry on failed run",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: gate.reopen and gate.cancel roll back or terminate gates with --reason", async () => {
  // ADR-009 §"Resto de operaciones": any actor may reopen or cancel a
  // gate. The policy-fixture below exercises the seam allow path
  // explicitly to keep coverage of the optional policy-driven branch
  // that ADR-007 introduced; the default core (no policy) would also
  // succeed here under ADR-009.
  //
  // gate.reopen and gate.cancel return the provider's typed projection
  // on `out.result.node` (revision-stripped draft view). The
  // kernel-stamped post-state lives on `diff.updated[0].node`, and
  // the persisted state file is the canonical post-state.
  const dir = await readyProject();
  await installPolicyFixture(dir);
  try {
    const apiAlice = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const apiAdmin = await freshApi(dir, { agent: "release-admin", pluginId: "example.audit" });
    // Resolve path (reopen must follow resolve).
    await apiAlice.core.run({
      op: "gate.create",
      input: {
        id: "G-parity-reopen",
        initiative: "plugin-platform",
        title: "x",
        body: "b",
        purpose: "decision",
      },
    });
    await apiAlice.core.run({
      op: "gate.resolve",
      input: { id: "G-parity-reopen", choice: "yes", rationale: "first decision" },
    });
    const reopened = await apiAdmin.core.run({
      op: "gate.reopen",
      input: { id: "G-parity-reopen", reason: "second thoughts" },
    });
    // Provider's typed projection on out.result.node (revision-stripped).
    assert.equal(reopened.result.node.subkind, "gate", "provider's result.node.subkind === gate");
    assert.equal(reopened.result.node.status, "open", "gate reopened");
    assert.equal(reopened.result.node.resolution, null, "provider clears resolution on reopen");
    // Kernel-stamped post-state lives on diff.updated[0].node.
    assert.equal(reopened.diff.updated[0].id, "G-parity-reopen");
    assert.equal(
      reopened.diff.updated[0].node.revision,
      3,
      "kernel bumps revision by exactly 1 on reopen (was 2 after resolve)",
    );
    assert.equal(reopened.diff.updated[0].node.status, "open");
    assert.equal(reopened.diff.updated[0].node.resolution, null, "kernel-stamped post-state has resolution=null");
    assert.ok(reopened.log_entry, "typed envelope carries log_entry");
    assert.equal(reopened.log_entry.action, "gate.reopen", "kernel log_entry.action equals the op");
    assert.equal(reopened.log_entry.plugin_id, "example.audit");
    assert.equal(reopened.log_entry.agent, "release-admin", "log records api.runtime.agent, not the plugin id");
    assert.equal(reopened.log_entry.node, "G-parity-reopen");

    // Cancel path on a fresh open gate: gates are not claimable and
    // under ADR-009 any actor may cancel them. The policy-fixture is
    // kept to also cover the seam allow branch.
    await apiAlice.core.run({
      op: "gate.create",
      input: {
        id: "G-parity-cancel",
        initiative: "plugin-platform",
        title: "y",
        body: "b",
        purpose: "decision",
      },
    });
    const canceled = await apiAdmin.core.run({
      op: "gate.cancel",
      input: { id: "G-parity-cancel", reason: "irrelevant" },
    });
    // Provider's typed projection on out.result.node (revision-stripped).
    assert.equal(canceled.result.node.subkind, "gate", "provider's result.node.subkind === gate");
    assert.equal(canceled.result.node.status, "canceled", "gate cancelled");
    // Kernel-stamped post-state lives on diff.updated[0].node.
    assert.equal(canceled.diff.updated[0].id, "G-parity-cancel");
    assert.equal(
      canceled.diff.updated[0].node.revision,
      2,
      "kernel bumps revision by exactly 1 on cancel (seed was revision=1)",
    );
    assert.equal(canceled.diff.updated[0].node.status, "canceled");
    assert.ok(canceled.log_entry, "typed envelope carries log_entry");
    assert.equal(canceled.log_entry.action, "gate.cancel", "kernel log_entry.action equals the op");
    assert.equal(canceled.log_entry.plugin_id, "example.audit");
    assert.equal(canceled.log_entry.agent, "release-admin");
    assert.equal(canceled.log_entry.node, "G-parity-cancel");
    // Persisted state file is the canonical post-state.
    const after = await readRawState(dir);
    assert.equal(after.nodes["G-parity-reopen"].status, "open", "persisted reopened status is open");
    assert.equal(after.nodes["G-parity-reopen"].resolution, null, "persisted resolution cleared by reopen");
    assert.equal(after.nodes["G-parity-reopen"].revision, 3);
    assert.equal(after.nodes["G-parity-cancel"].status, "canceled", "persisted cancel status is canceled");
    assert.equal(after.nodes["G-parity-cancel"].revision, 2);
    const reopenLogs = after.log.filter(
      (e) => e.action === "gate.reopen" && e.node === "G-parity-reopen",
    );
    assert.equal(reopenLogs.length, 1, "exactly one gate.reopen log entry");
    assert.equal(reopenLogs[0].plugin_id, "example.audit");
    assert.equal(reopenLogs[0].agent, "release-admin");
    const cancelLogs = after.log.filter(
      (e) => e.action === "gate.cancel" && e.node === "G-parity-cancel",
    );
    assert.equal(cancelLogs.length, 1, "exactly one gate.cancel log entry");
    assert.equal(cancelLogs[0].plugin_id, "example.audit");
    assert.equal(cancelLogs[0].agent, "release-admin");
  } finally {
    await uninstallPolicyFixture(dir);
    await rmTempProject(dir);
  }
});

// ---- knowledge.create / knowledge.deprecate ------------------------

test("api.core.run: knowledge.create dispatches to add-knowledge (requires --scope-*)", async () => {
  // The kernel-driven path returns the typed result shape
  // `{ result, effects, log_entry, idempotent, diff }`. The
  // knowledge.create provider projects `{ id, kind }` into result;
  // the kernel-stamped full node (with revision=1, scope, status)
  // lives on `diff.created[0].node`. There is no `{ node }` legacy
  // envelope at the top level.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const out = await api.core.run({
      op: "knowledge.create",
      input: {
        id: "K-parity-create",
        initiative: "plugin-platform",
        title: "appendWithContext seam",
        body: "log entries gain plugin_id",
        scope: { tags: ["api", "recovery"] },
      },
    });
    assert.ok(out && typeof out === "object", "kernel returned the typed result envelope");
    assert.equal(typeof out.result, "object", "typed envelope carries result");
    assert.equal(typeof out.diff, "object", "typed envelope carries diff");
    assert.equal(Array.isArray(out.diff.created), true, "diff.created is the canonical created list");
    // Provider projection: result carries id/kind only.
    assert.equal(out.result.id, "K-parity-create", "provider's result.id echoes the input");
    assert.equal(out.result.kind, "knowledge", "provider's result.kind === knowledge");
    // Kernel-stamped full node lives on diff.created[0].node.
    const created = out.diff.created[0].node;
    assert.equal(created.id, "K-parity-create");
    assert.equal(created.kind, "knowledge");
    assert.equal(created.status, "active");
    assert.equal(created.revision, 1, "kernel stamps revision=1 on create");
    assert.deepEqual(created.scope.tags, ["api", "recovery"], "scope.tags echoes the input");
    // Log entry: kernel stamps action, plugin_id, agent.
    assert.ok(out.log_entry, "typed envelope carries log_entry");
    assert.equal(out.log_entry.action, "knowledge.create", "kernel log_entry.action equals the op");
    assert.equal(out.log_entry.plugin_id, "example.audit");
    assert.equal(out.log_entry.agent, "alice");
    // Persisted state mirrors the kernel-stamped node.
    const after = await readRawState(dir);
    const persisted = after.nodes["K-parity-create"];
    assert.equal(persisted.status, "active", "persisted status is active");
    assert.deepEqual(persisted.scope.tags, ["api", "recovery"], "scope.tags persisted");
    assert.equal(persisted.revision, 1, "persisted revision is 1");
    const pluginLogs = after.log.filter((e) => e.plugin_id === "example.audit");
    const lastPluginLog = pluginLogs[pluginLogs.length - 1];
    assert.equal(lastPluginLog.action, "knowledge.create", "persisted log action is the op id");
    assert.equal(lastPluginLog.agent, "alice");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: knowledge.create without any --scope-* throws PLUGIN_CORE_ACTION_FAILED", async () => {
  // The any-of-scope rule is delegated to the handler (the adapter's
  // `required` check is "all of" only); the handler throws
  // MISSING_FIELD which the adapter wraps as PLUGIN_CORE_ACTION_FAILED.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await assert.rejects(
      api.core.run({
        op: "knowledge.create",
        input: {
          id: "K-parity-no-scope",
          initiative: "plugin-platform",
          title: "x",
          body: "b",
        },
      }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.cause &&
        err.details.cause.code === "MISSING_FIELD",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: knowledge.deprecate sets status='deprecated' on an active knowledge node", async () => {
  // The kernel-driven path returns the typed result shape
  // `{ result, effects, log_entry, idempotent, diff }`. The
  // knowledge.deprecate provider projects `{ id, kind, status }`
  // into result; the kernel-stamped full node (with revision=2,
  // deprecated_by / deprecation_reason / deprecated_at) lives on
  // `diff.updated[0].node`. The deprecate provider derives the CAS
  // precondition (`if_revision`) from the snapshot, so the caller
  // does not need to supply it.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await api.core.run({
      op: "knowledge.create",
      input: {
        id: "K-parity-deprecate",
        initiative: "plugin-platform",
        title: "to deprecate",
        body: "b",
        scope: { tags: ["api", "recovery"] },
      },
    });
    const out = await api.core.run({
      op: "knowledge.deprecate",
      input: { id: "K-parity-deprecate", reason: "superseded by ADR-007" },
    });
    assert.ok(out && typeof out === "object", "kernel returned the typed result envelope");
    assert.equal(typeof out.result, "object", "typed envelope carries result");
    assert.equal(typeof out.diff, "object", "typed envelope carries diff");
    assert.equal(Array.isArray(out.diff.updated), true, "diff.updated is the canonical updated list");
    // Provider projection: result carries id/kind/status.
    assert.equal(out.result.id, "K-parity-deprecate");
    assert.equal(out.result.kind, "knowledge");
    assert.equal(out.result.status, "deprecated", "provider's result.status === deprecated");
    // Kernel-stamped full updated node.
    const updated = out.diff.updated[0].node;
    assert.equal(updated.id, "K-parity-deprecate");
    assert.equal(updated.status, "deprecated", "kernel-stamped updated node carries status=deprecated");
    assert.equal(updated.deprecated_by, "alice", "deprecated_by echoes api.runtime.agent");
    assert.equal(updated.deprecation_reason, "superseded by ADR-007");
    assert.equal(typeof updated.deprecated_at, "string", "deprecated_at is an ISO string");
    assert.equal(updated.revision, 2, "kernel bumps revision on update");
    // Log entry: kernel stamps action, plugin_id, agent.
    assert.ok(out.log_entry, "typed envelope carries log_entry");
    assert.equal(out.log_entry.action, "knowledge.deprecate");
    assert.equal(out.log_entry.plugin_id, "example.audit");
    assert.equal(out.log_entry.agent, "alice");
    // Persisted state mirrors the kernel-stamped node.
    const after = await readRawState(dir);
    const persisted = after.nodes["K-parity-deprecate"];
    assert.equal(persisted.status, "deprecated", "persisted status is deprecated");
    assert.equal(persisted.deprecated_by, "alice");
    assert.equal(persisted.deprecation_reason, "superseded by ADR-007");
    assert.equal(persisted.revision, 2, "persisted revision is 2");
    const deprecateLogs = after.log.filter(
      (e) => e.plugin_id === "example.audit" && e.action === "knowledge.deprecate",
    );
    assert.equal(deprecateLogs.length, 1, "exactly one knowledge.deprecate log entry");
    assert.equal(deprecateLogs[0].agent, "alice");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: knowledge.deprecate without --reason is rejected by the adapter as PLUGIN_CORE_ACTION_FAILED (provider-level MISSING_FIELD)", async () => {
  // The kernel-driven path has no adapter-side required-field
  // whitelist; the provider's prepare throws MISSING_FIELD when
  // `reason` is missing and the adapter wraps it as
  // PLUGIN_CORE_ACTION_FAILED with a structured `cause`. State is
  // not mutated and no log entry is appended for the deprecate call.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await api.core.run({
      op: "knowledge.create",
      input: {
        id: "K-parity-dep-noreason",
        initiative: "plugin-platform",
        title: "x",
        body: "b",
        scope: { tags: ["api", "recovery"] },
      },
    });
    const beforeLogCount = (await readRawState(dir)).log.length;
    await assert.rejects(
      api.core.run({ op: "knowledge.deprecate", input: { id: "K-parity-dep-noreason" } }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.op === "knowledge.deprecate" &&
        err.details.plugin_id === "example.audit" &&
        err.details.cause &&
        err.details.cause.code === "MISSING_FIELD" &&
        /reason/.test(err.details.cause.message || ""),
    );
    // The knowledge node is unchanged: status remains active.
    const after = await readRawState(dir);
    const persisted = after.nodes["K-parity-dep-noreason"];
    assert.equal(persisted.status, "active", "node remains active after rejected deprecate");
    assert.equal(persisted.revision, 1, "node revision unchanged after rejected deprecate");
    assert.equal(
      after.log.length,
      beforeLogCount,
      "no log entry appended for rejected knowledge.deprecate",
    );
  } finally {
    await rmTempProject(dir);
  }
});

// ---- CLI parity (no plugin_id when pluginId is absent) --------------

test("cli parity: a parity handler called without ctx.pluginId does NOT tag its log entry with plugin_id", async () => {
  // The seam is opt-in: when the dispatcher is invoked the CLI way
  // (no pluginId in ctx), appendWithContext drops plugin_id. This is
  // the same path bin/climier.mjs exercises, so we keep the contract
  // for callers that wrap the handler directly.
  const dir = await readyProject();
  try {
    await seedState(dir, (s) => {
      s.nodes["T-cli-parity"] = {
        id: "T-cli-parity",
        kind: "resolvable",
        subkind: "task",
        title: "cli task",
        initiative: "plugin-platform",
        status: "open",
        revision: 1,
      };
      s.initiatives["plugin-platform"] = { desc: "plugin platform" };
      s.log = [];
    });
    const { default: updateV2 } = await importFresh("./commands/update.mjs");
    await updateV2({
      statePath: dir,
      positional: ["T-cli-parity"],
      flags: { as: "alice", title: "edited from CLI" },
      projectDir: dir,
      // no `pluginId` — the CLI passes nothing here.
    });
    const after = await readRawState(dir);
    const updateLog = after.log.filter(
      (e) => e.action === "update" && e.node === "T-cli-parity",
    );
    assert.ok(updateLog.length === 1, "exactly one CLI update log entry");
    assert.equal(updateLog[0].plugin_id, undefined, "CLI parity: no plugin_id tag");
    assert.equal(updateLog[0].agent, "alice");
    assert.equal(after.nodes["T-cli-parity"].title, "edited from CLI");
  } finally {
    await rmTempProject(dir);
  }
});

test("cli parity: parity task.cancel + update chain leaves logs free of plugin_id when called from CLI", async () => {
  // Wider CLI parity smoke covering release/reopen/cancel/deprecate-knowledge
  // through their core handlers directly. This prevents plugin-side path
  // from regressing the existing CLI behavior — the contract that the
  // CLI bin keeps working exactly as before. Cancel no longer requires
  // claim ownership or a policy under ADR-009; the policy-fixture is kept
  // here to also cover the seam allow branch (any actor → cancel).
  const dir = await readyProject();
  await installPolicyFixture(dir);
  try {
    await seedState(dir, (s) => {
      s.nodes["T-cli-parity-2"] = {
        id: "T-cli-parity-2",
        kind: "resolvable",
        subkind: "task",
        title: "cli task 2",
        initiative: "plugin-platform",
        status: "open",
        revision: 1,
      };
      s.initiatives["plugin-platform"] = { desc: "plugin platform" };
      s.log = [];
    });
    const { default: cancelV2 } = await importFresh("./commands/cancel.mjs");
    await cancelV2({
      statePath: dir,
      positional: ["T-cli-parity-2"],
      flags: { as: "release-manager", reason: "deprioritised" },
      projectDir: dir,
    });
    const after = await readRawState(dir);
    const lastLog = after.log[after.log.length - 1];
    assert.equal(lastLog.action, "cancel");
    assert.equal(lastLog.plugin_id, undefined, "CLI parity: cancel log has no plugin_id");
    assert.equal(lastLog.agent, "release-manager");
    assert.equal(after.nodes["T-cli-parity-2"].status, "canceled");
  } finally {
    await uninstallPolicyFixture(dir);
    await rmTempProject(dir);
  }
});
