// Split from test/plugin-api.test.mjs; complete original test bodies and cleanup are retained.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState as readRawState } from "../../helpers.mjs";
import { seedState, freshApi } from "./fixtures.mjs";

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

test("api.data.node.set uses kernel revision accounting while preserving the plugin API result", async () => {
  const dir = await createTempProject();
  try {
    const seeded = await seedState(dir);
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const value = { perNode: "kernel-backed" };
    assert.deepEqual(await api.data.node.set("T1", value), value);
    const after = await readRawState(dir);
    assert.equal(after.nodes.T1.revision, seeded.revision + 1);
    assert.equal(after.log.length, 1);
    assert.deepEqual(after.nodes.T1.plugins["example.audit"].data, value);
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

test("api.data node/project delete is idempotent and isolated to the caller namespace", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir, (s) => {
      s.nodes.T1.plugins = {
        "example.audit": { data: { remove: true, keep: "audit" }, metadata: { owner: "audit" } },
        "example.other": { data: { remove: "other" } },
      };
      s.plugins = {
        "example.audit": { data: { remove: true, keep: "audit" }, metadata: { owner: "audit" } },
        "example.other": { data: { remove: "other" } },
      };
    });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });

    assert.deepEqual(await api.data.node.delete("T1"), { removed: true });
    assert.deepEqual(await api.data.node.delete("T1"), { removed: false });
    assert.deepEqual(await api.data.project.delete("remove"), { removed: true });
    assert.deepEqual(await api.data.project.delete("remove"), { removed: false });

    const after = await readRawState(dir);
    assert.deepEqual(after.nodes.T1.plugins["example.audit"], {
      metadata: { owner: "audit" },
    });
    assert.deepEqual(after.nodes.T1.plugins["example.other"], { data: { remove: "other" } });
    assert.deepEqual(after.plugins["example.audit"], {
      data: { keep: "audit" },
      metadata: { owner: "audit" },
    });
    assert.deepEqual(after.plugins["example.other"], { data: { remove: "other" } });
    assert.deepEqual(after.log.map((entry) => entry.action), ["plugin-data-delete", "plugin-data-delete"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("api.data rejects non-JSON values before state or log mutation", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir);
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const before = await readRawState(dir);
    const invalid = [undefined, NaN, Infinity, 1n, new Map([["x", 1]]), new Date()];
    const circular = {};
    circular.self = circular;
    invalid.push(circular);
    for (const value of invalid) {
      await assert.rejects(api.data.node.set("T1", value), (err) => err && err.code === "PLUGIN_DATA_INVALID");
      await assert.rejects(api.data.project.set("bad", value), (err) => err && err.code === "PLUGIN_DATA_INVALID");
    }
    const after = await readRawState(dir);
    assert.deepEqual(after.nodes, before.nodes);
    assert.deepEqual(after.plugins, before.plugins);
    assert.deepEqual(after.log, before.log);
  } finally {
    await rmTempProject(dir);
  }
});

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
      importFresh("./cli/commands/take.mjs"),
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

test("createApi rejects calls to data.*.set without agent identity (agent must be a non-empty string)", async () => {
  const dir = await createTempProject();
  try {
    await seedState(dir);
    const { createApi } = await importFresh("./plugins/api.mjs");
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

test("createApi accepts pluginId that matches the V1 regex shape", async () => {
  const dir = await createTempProject();
  try {
    const { createApi } = await importFresh("./plugins/api.mjs");
    // The API applies the same safety validation as the descriptor before
    // using pluginId as a filesystem path. Confirm canonical id shapes work.
    assert.ok(createApi({ projectDir: dir, agent: "x", pluginId: "example.audit" }));
    assert.ok(createApi({ projectDir: dir, agent: "x", pluginId: "a" }));
    assert.throws(() => createApi({ projectDir: dir, agent: "x", pluginId: "" }));
  } finally {
    await rmTempProject(dir);
  }
});
