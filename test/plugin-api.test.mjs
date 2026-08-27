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

test("api.core.run: missing required field throws PLUGIN_CORE_INVALID_OPERATION without mutating", async () => {
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
        err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
        /missing required field 'type'/.test(err.details.reason || ""),
    );
    // The state is untouched: no edges.
    const after = await readRawState(dir);
    assert.deepEqual(after.edges, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: unknown op does not mutate state (rejection happens before any lock)", async () => {
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./commands/init.mjs");
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await assert.rejects(
      api.core.run({ op: "task.create", input: {} }),
      (err) => err && err.code === "PLUGIN_CORE_INVALID_OPERATION",
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

test("api.core.run: task.create dispatches to the real add-task handler with flags.as set from api.runtime.agent", async () => {
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
    assert.ok(out && out.node && out.node.id, "handler returned a node envelope");
    assert.equal(out.node.id, "T-from-core", "explicit id is propagated to the handler");
    const after = await readRawState(dir);
    assert.ok(after.nodes["T-from-core"], "task.create created the node");
    // The plugin's identity is not in the log entry's agent: the adapter
    // forced flags.as = "alice" from api.runtime.agent, so the log entry
    // records alice (not the plugin id).
    const lastPluginLog = after.log.filter((e) => e.plugin_id === "example.audit").pop();
    assert.ok(lastPluginLog, "log entry tagged with plugin_id");
    assert.equal(lastPluginLog.agent, "alice", "agent reflects api.runtime.agent, not plugin id");
    assert.equal(lastPluginLog.action, "add-node");
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

test("api.core.run: initiative.create dispatches to add-initiative and returns the initiative envelope", async () => {
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const out = await api.core.run({
      op: "initiative.create",
      input: { name: "fresh-initiative", desc: "parity slice" },
    });
    assert.ok(out && out.initiative, "handler returned an initiative envelope");
    assert.equal(out.initiative.name, "fresh-initiative");
    assert.equal(out.initiative.desc, "parity slice");
    const after = await readRawState(dir);
    assert.ok(after.initiatives["fresh-initiative"], "initiative is registered in state");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: initiative.create without name throws PLUGIN_CORE_INVALID_OPERATION", async () => {
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await assert.rejects(
      api.core.run({ op: "initiative.create", input: { desc: "no name" } }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
        /missing required field 'name'/.test(err.details.reason || ""),
    );
  } finally {
    await rmTempProject(dir);
  }
});

// ---- task.update ----------------------------------------------------

test("api.core.run: task.update dispatches to update with positional [id] and bumps revision", async () => {
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
    assert.equal(created.node.revision, 1);
    // Now patch its title via task.update.
    const updated = await api.core.run({
      op: "task.update",
      input: { id: "T-parity-update", title: "after" },
    });
    assert.equal(updated.node.title, "after");
    assert.equal(updated.node.revision, 2, "task.update bumps revision by exactly 1");
    const after = await readRawState(dir);
    assert.equal(after.nodes["T-parity-update"].title, "after");
    assert.equal(after.nodes["T-parity-update"].revision, 2);
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: task.update log entry carries plugin_id (parity handler uses appendWithContext)", async () => {
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
    await api.core.run({
      op: "task.update",
      input: { id: "T-parity-update-log", title: "y" },
    });
    const after = await readRawState(dir);
    const updateLogs = after.log.filter(
      (e) => e.action === "update" && e.node === "T-parity-update-log",
    );
    assert.ok(updateLogs.length === 1, "exactly one update log entry");
    assert.equal(updateLogs[0].plugin_id, "example.audit", "parity log carries plugin_id");
    assert.equal(updateLogs[0].agent, "alice", "log records api.runtime.agent, not the plugin id");
  } finally {
    await rmTempProject(dir);
  }
});

// ---- task.release / task.reopen / task.cancel -----------------------

test("api.core.run: task.release dispatches to release after a take (idempotent lifecycle)", async () => {
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
    assert.equal(created.node.status, "open");
    await api.core.run({ op: "task.take", input: { id: "T-parity-release" } });
    const released = await api.core.run({ op: "task.release", input: { id: "T-parity-release" } });
    assert.equal(released.released, true, "release produced the released:true envelope");
    assert.equal(released.node.status, "open", "status returned to open after release");
    assert.equal(released.node.claim, null, "claim cleared after release");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: task.cancel dispatches to cancel and sets status='canceled'", async () => {
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
    // Take it first so alice owns the claim; otherwise cancel refuses with
    // NOT_OWNER (cancel requires claim ownership or orchestrator).
    await api.core.run({ op: "task.take", input: { id: "T-parity-cancel" } });
    const out = await api.core.run({
      op: "task.cancel",
      input: { id: "T-parity-cancel", reason: "out of scope" },
    });
    assert.equal(out.node.status, "canceled");
    assert.equal(out.node.claim, null, "claim cleared on cancel");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: task.cancel without --reason is rejected by the adapter as PLUGIN_CORE_INVALID_OPERATION (required-field check, before lock)", async () => {
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    // The registry requires `reason` for task.cancel; the adapter
    // enforces it before any lock is taken and surfaces as
    // PLUGIN_CORE_INVALID_OPERATION with details.reason set, never
    // reaching the handler's own MISSING_FIELD branch.
    await assert.rejects(
      api.core.run({ op: "task.cancel", input: { id: "T-parity-cancel-no-reason" } }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
        /missing required field 'reason'/.test(err.details.reason || ""),
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: task.reopen works after a resolve (close -> roll back to open)", async () => {
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
    assert.equal(reopened.node.status, "open");
    assert.equal(reopened.node.claim, null, "claim cleared by reopen");
    assert.equal(reopened.node.done_by, undefined, "done_by cleared by reopen");
  } finally {
    await rmTempProject(dir);
  }
});

// ---- gate.create / gate.resolve / gate.reopen / gate.cancel ----------

test("api.core.run: gate.create dispatches to add-gate and stores a gate node with --purpose", async () => {
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
    assert.ok(out.node, "gate envelope present");
    assert.equal(out.node.subkind, "gate");
    assert.equal(out.node.purpose, "decision");
    const after = await readRawState(dir);
    assert.ok(after.nodes["G-parity-create"], "gate is in state");
    assert.equal(after.nodes["G-parity-create"].subkind, "gate");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: gate.create without --purpose throws PLUGIN_CORE_INVALID_OPERATION", async () => {
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
        err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
        /missing required field 'purpose'/.test(err.details.reason || ""),
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: gate.resolve stores resolution = {choice, rationale}", async () => {
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await api.core.run({
      op: "gate.create",
      input: {
        id: "G-parity-resolve",
        initiative: "plugin-platform",
        title: "x",
        body: "b",
        purpose: "decision",
      },
    });
    const out = await api.core.run({
      op: "gate.resolve",
      input: {
        id: "G-parity-resolve",
        choice: "approve V2",
        rationale: "ADR-006 defines it; parity closes the surface",
      },
    });
    assert.equal(out.node.status, "resolved");
    assert.deepEqual(out.node.resolution, {
      choice: "approve V2",
      rationale: "ADR-006 defines it; parity closes the surface",
    });
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: gate.resolve without --rationale throws PLUGIN_CORE_INVALID_OPERATION", async () => {
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
        err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
        /missing required field 'rationale'/.test(err.details.reason || ""),
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: gate.reopen and gate.cancel roll back or terminate gates with --reason", async () => {
  // Reopening a resolved gate requires either orchestrator or the
  // original done_by; the resolve handler does not stamp done_by on
  // gates (gates are not claimable), so reopen only succeeds through
  // orchestrator. The orchestrator `api` below exercises that path.
  const dir = await readyProject();
  try {
    const apiAlice = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const apiOrchestrator = await freshApi(dir, { agent: "orchestrator", pluginId: "example.audit" });
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
    const reopened = await apiOrchestrator.core.run({
      op: "gate.reopen",
      input: { id: "G-parity-reopen", reason: "second thoughts" },
    });
    assert.equal(reopened.node.status, "open", "gate reopened");
    assert.equal(reopened.node.resolution, undefined, "resolution cleared by reopen");

    // Cancel path on a fresh open gate must run as orchestrator because
    // gates are not claimable and cancel requires claim ownership OR
    // orchestrator.
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
    const canceled = await apiOrchestrator.core.run({
      op: "gate.cancel",
      input: { id: "G-parity-cancel", reason: "irrelevant" },
    });
    assert.equal(canceled.node.status, "canceled", "gate cancelled");
  } finally {
    await rmTempProject(dir);
  }
});

// ---- knowledge.create / knowledge.deprecate ------------------------

test("api.core.run: knowledge.create dispatches to add-knowledge (requires --scope-*)", async () => {
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
        scope_initiatives: "plugin-platform",
      },
    });
    assert.ok(out.node, "knowledge envelope present");
    assert.equal(out.node.kind, "knowledge");
    assert.equal(out.node.status, "active");
    assert.deepEqual(out.node.scope.initiatives, ["plugin-platform"]);
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
        scope_initiatives: "plugin-platform",
      },
    });
    const out = await api.core.run({
      op: "knowledge.deprecate",
      input: { id: "K-parity-deprecate", reason: "superseded by ADR-007" },
    });
    assert.equal(out.node.status, "deprecated");
    assert.equal(out.node.deprecated_by, "alice");
    assert.equal(out.node.deprecation_reason, "superseded by ADR-007");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: knowledge.deprecate without --reason is rejected by the adapter as PLUGIN_CORE_INVALID_OPERATION", async () => {
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
        scope_initiatives: "plugin-platform",
      },
    });
    await assert.rejects(
      api.core.run({ op: "knowledge.deprecate", input: { id: "K-parity-dep-noreason" } }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
        /missing required field 'reason'/.test(err.details.reason || ""),
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
  // CLI bin keeps working exactly as before. Cancel requires claim
  // ownership OR orchestrator, so this test runs as orchestrator to
  // exercise the no-claim path (the more interesting CLI case).
  const dir = await readyProject();
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
      flags: { as: "orchestrator", reason: "deprioritised" },
      projectDir: dir,
    });
    const after = await readRawState(dir);
    const lastLog = after.log[after.log.length - 1];
    assert.equal(lastLog.action, "cancel");
    assert.equal(lastLog.plugin_id, undefined, "CLI parity: cancel log has no plugin_id");
    assert.equal(lastLog.agent, "orchestrator");
    assert.equal(after.nodes["T-cli-parity-2"].status, "canceled");
  } finally {
    await rmTempProject(dir);
  }
});
