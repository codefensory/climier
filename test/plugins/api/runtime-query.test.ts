// Split from test/plugin-api.test.mjs; complete original test bodies and cleanup are retained.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, writeFencedState, readState as readRawState, stateFilePath } from "../../helpers.ts";
import { baseState, seedState, freshApi } from "./fixtures.mjs";

type TestError = { code?: string; details: Record<string, unknown>; message?: string };

test("createApi: public api.version and api.core.version are 1", async () => {
  const dir = await createTempProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    assert.equal(api.version, 1);
    assert.equal(api.core.version, 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("createApi: api.core.version is 1 and api.core.run is a function", async () => {
  const dir = await createTempProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    assert.equal(api.core.version, 1);
    assert.equal(typeof api.core.run, "function");

    assert.equal(typeof api.runtime, "object");
    assert.equal(typeof api.query, "object");
    assert.equal(typeof api.data, "object");
  } finally {
    await rmTempProject(dir);
  }
});

test("resolveRuntime: parses --project and --as from argv and returns { project_dir, agent }", async () => {
  const { resolveRuntime } = await importFresh("./plugins/runtime.ts");
  const out = resolveRuntime(["--project", "/tmp/example", "--as", "alice"]);
  assert.equal(out.project_dir, "/tmp/example");
  assert.equal(out.agent, "alice");
});

test("resolveRuntime: --as falls back to CLIMIER_AGENT when missing", async () => {
  const prev = process.env.CLIMIER_AGENT;
  process.env.CLIMIER_AGENT = "env-agent";
  try {
    const { resolveRuntime } = await importFresh("./plugins/runtime.ts");
    const out = resolveRuntime(["--project", "/tmp/example"]);
    assert.equal(out.project_dir, "/tmp/example");
    assert.equal(out.agent, "env-agent");
  } finally {
    if (prev === undefined) {
      delete process.env.CLIMIER_AGENT;
    } else {
      process.env.CLIMIER_AGENT = prev;
    }
  }
});

test("resolveRuntime: --as flag takes precedence over CLIMIER_AGENT", async () => {
  const prev = process.env.CLIMIER_AGENT;
  process.env.CLIMIER_AGENT = "env-agent";
  try {
    const { resolveRuntime } = await importFresh("./plugins/runtime.ts");
    const out = resolveRuntime(["--project", "/tmp/x", "--as", "alice"]);
    assert.equal(out.agent, "alice");
  } finally {
    if (prev === undefined) {
      delete process.env.CLIMIER_AGENT;
    } else {
      process.env.CLIMIER_AGENT = prev;
    }
  }
});

test("resolveRuntime: --project defaults to CWD when missing", async () => {
  const { resolveRuntime } = await importFresh("./plugins/runtime.ts");
  const out = resolveRuntime(["--as", "alice"]);
  assert.equal(out.project_dir, process.cwd());
  assert.equal(out.agent, "alice");
});

test("resolveRuntime: supports --as=<value> and --project=<value> (equals form)", async () => {
  const { resolveRuntime } = await importFresh("./plugins/runtime.ts");
  const out = resolveRuntime(["--project=/tmp/x", "--as=alice"]);
  assert.equal(out.project_dir, "/tmp/x");
  assert.equal(out.agent, "alice");
});

test("resolveRuntime: ignores unknown flags (passes them through without breaking project_dir/agent)", async () => {
  const { resolveRuntime } = await importFresh("./plugins/runtime.ts");
  const out = resolveRuntime(["--my-flag", "value", "--project", "/tmp/x", "--as", "alice"]);
  assert.equal(out.project_dir, "/tmp/x");
  assert.equal(out.agent, "alice");
});

test("createApi: requires projectDir and pluginId", async () => {
  const { createApi } = await importFresh("./plugins/api.ts");
  assert.throws(() => createApi({ projectDir: "", agent: "x", pluginId: "p" }), /projectDir/);
  assert.throws(() => createApi({ projectDir: "/tmp", agent: "x", pluginId: "" }), /pluginId/);
});

test("createApi: api.runtime exposes project_dir and agent exactly as passed in", async () => {
  const dir = await createTempProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    assert.deepEqual(api.runtime, {
      project_dir: dir,
      agent: "alice",
      dataDir: path.join(path.dirname(stateFilePath(dir)), "plugins", "example.audit"),
    });
  } finally {
    await rmTempProject(dir);
  }
});

test("createApi: creates a stable, isolated runtime.dataDir before returning", async () => {
  const dir = await createTempProject();
  try {
    const pluginId = "example.audit";
    const expected = path.join(path.dirname(stateFilePath(dir)), "plugins", pluginId);
    const api = await freshApi(dir, { pluginId });

    assert.equal(api.runtime.dataDir, expected);
    const stat = await fs.stat(api.runtime.dataDir);
    assert.equal(stat.isDirectory(), true);

    await fs.writeFile(path.join(api.runtime.dataDir, "plugin.sqlite"), "plugin-owned", "utf8");
    const restarted = await freshApi(dir, { pluginId });
    assert.equal(restarted.runtime.dataDir, expected);
    assert.equal(await fs.readFile(path.join(restarted.runtime.dataDir, "plugin.sqlite"), "utf8"), "plugin-owned");
  } finally {
    await rmTempProject(dir);
  }
});

test("createApi: runtime.dataDir is keyed by project id and plugin id", async () => {
  const first = await createTempProject();
  const second = await createTempProject();
  try {
    const metadata = JSON.stringify({ version: 1, project_id: "stable-runtime-project" });
    await fs.writeFile(path.join(first, ".climier.json"), `${metadata}\n`, "utf8");
    await fs.writeFile(path.join(second, ".climier.json"), `${metadata}\n`, "utf8");
    const { createApi } = await importFresh("./plugins/api.ts");

    const firstPlugin = createApi({ projectDir: first, agent: "alice", pluginId: "plugin.a" });
    const secondPlugin = createApi({ projectDir: second, agent: "bob", pluginId: "plugin.a" });
    const otherPlugin = createApi({ projectDir: first, agent: "alice", pluginId: "plugin.b" });

    assert.equal(firstPlugin.runtime.dataDir, secondPlugin.runtime.dataDir);
    assert.notEqual(firstPlugin.runtime.dataDir, otherPlugin.runtime.dataDir);
  } finally {
    await rmTempProject(first);
    await rmTempProject(second);
  }
});

test("createApi: rejects traversal plugin ids before creating a runtime data directory", async () => {
  const dir = await createTempProject();
  try {
    const { createApi } = await importFresh("./plugins/api.ts");
    await assert.rejects(
      async () => createApi({ projectDir: dir, agent: "alice", pluginId: "../escape" }),
      (err: TestError) => err && err.code === "PLUGIN_INVALID_DESCRIPTOR",
    );
    await assert.rejects(
      fs.access(path.join(path.dirname(stateFilePath(dir)), "escape")),
      (err: TestError) => err && err.code === "ENOENT",
    );
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
    // Replace through the fenced fixture helper to simulate another agent's update.
    const replacement = baseState();
    replacement.nodes.T1.title = "T1 (mutated)";
    const current = await readRawState(dir);
    replacement.revision = current.revision;
    replacement.fence_generation = current.fence_generation;
    await writeFencedState(dir, replacement);
    const expected = await readRawState(dir);
    const out = await api.query.node("T1");
    assert.equal(out.node.title, "T1 (mutated)");
    assert.equal(out.node.revision, expected.nodes.T1.revision);
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

    assert.ok(out.allowed_actions.includes("claim"), "ready task should include claim for named agent");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.query.context announces submit for an in_progress task", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir, (state) => {
      state.nodes.T1.status = "in_progress";
      state.nodes.T1.claim = { by: "worker", at: new Date().toISOString() };
    });
    const api = await freshApi(dir, { agent: "worker" });
    const out = await api.query.context("T1");
    assert.deepEqual(out.allowed_actions, ["submit", "release", "add-note", "update"]);
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

test("api.query exposes submitted tasks in status and validation actions in context", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir, (state) => {
      state.nodes.T1.status = "submitted";
      state.nodes.T1.claim = null;
      state.nodes.T1.submitted_by = "worker";
      state.nodes.T1.submitted_at = "2026-01-01T00:00:00.000Z";
    });
    const api = await freshApi(dir, { agent: "validator" });
    const status = await api.query.status({ status: "submitted", limit: 1 });
    assert.equal(status.summary.submitted, 1);
    assert.equal(status.tasks.submitted.length, 1);
    assert.equal(status.tasks.submitted[0].id, "T1");
    assert.deepEqual(status.tasks.ready, []);
    assert.deepEqual(status.tasks.blocked, []);

    const context = await api.query.context("T1");
    assert.equal(context.derived_status, "submitted");
    assert.ok(context.allowed_actions.includes("accept"));
    assert.ok(context.allowed_actions.includes("reject"));
    assert.ok(!context.allowed_actions.includes("take"));
    assert.ok(!context.allowed_actions.includes("release"));
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
