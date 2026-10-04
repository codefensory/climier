import { test } from "node:test";
import assert from "node:assert/strict";
import * as helpers from "./plugin-core-adapter-helpers.mjs";

// 3. run — rejection BEFORE any kernel call (no state required)

test("plugin-core-adapter: run rejects non-string op with PLUGIN_CORE_INVALID_OPERATION and lists supported ops", async () => {
  const { createCore } = await helpers.importFresh(helpers.ADAPTER_MODULE);
  const core = createCore({ projectDir: "/tmp/no-state-needed", agent: "alice", pluginId: "p.test" });
  // NOTE: assert by `code` + `details`, NOT by `instanceof
  // PluginCoreInvalidOperation`. Each `helpers.importFresh(ERRORS_MODULE)` call
  // returns a fresh class instance (ESM query-string cache bust), so a
  // cross-module `err instanceof PluginCoreInvalidOperation` check
  // always fails — the adapter's import is cached separately from the
  // test's. The structured envelope is the contract, not the JS class.
  for (const bad of [undefined, null, 1, true, [], {}, ""]) {
    await assert.rejects(
      core.run({ op: bad, input: {} }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
        err.details &&
        Array.isArray(err.details.supported) &&
        err.details.supported.length === helpers.EXPECTED_OPS.length,
      `expected PLUGIN_CORE_INVALID_OPERATION for op=${JSON.stringify(bad)}`,
    );
  }
});

test("plugin-core-adapter: run rejects unknown op with the full supported list", async () => {
  const { createCore } = await helpers.importFresh(helpers.ADAPTER_MODULE);
  const core = createCore({ projectDir: "/tmp/no-state-needed", agent: "alice", pluginId: "p.test" });
  await assert.rejects(
    core.run({ op: "edge.unknown", input: {} }),
    (err) =>
      err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
      err.details.op === "edge.unknown" &&
      err.details.reason === "unknown operation" &&
      err.details.supported.includes("edge.add") &&
      err.details.supported.includes("edge.remove") &&
      err.details.supported.includes("note.add") &&
      err.details.supported.includes("task.update"),
  );
});

test("plugin-core-adapter: run rejects non-object input with PLUGIN_CORE_INVALID_OPERATION", async () => {
  const { createCore } = await helpers.importFresh(helpers.ADAPTER_MODULE);
  const core = createCore({ projectDir: "/tmp/no-state-needed", agent: "alice", pluginId: "p.test" });
  for (const bad of [null, undefined, "string", 1, true, []]) {
    await assert.rejects(
      core.run({ op: "task.create", input: bad }),
      (err) =>
        err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
        /input must be an object/.test(err.details.reason || ""),
      `expected input-must-be-object for ${JSON.stringify(bad)}`,
    );
  }
});

test("plugin-core-adapter: run rejects input.as with reason 'input.as is forbidden'", async () => {
  const { createCore } = await helpers.importFresh(helpers.ADAPTER_MODULE);
  const core = createCore({ projectDir: "/tmp/no-state-needed", agent: "alice", pluginId: "p.test" });
  await assert.rejects(
    core.run({
      op: "task.create",
      input: {
        id: "T-x",
        initiative: "plugin-platform",
        title: "x",
        body: "b",
        acceptance: "a",
        blocked_by: "",
        as: "bob",
      },
    }),
    (err) =>
      err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
      err.details.reason === "input.as is forbidden" &&
      err.details.plugin_id === "p.test",
  );
});

test("plugin-core-adapter: run rejects input._as with the same reason (no alias sneaks past)", async () => {
  const { createCore } = await helpers.importFresh(helpers.ADAPTER_MODULE);
  const core = createCore({ projectDir: "/tmp/no-state-needed", agent: "alice", pluginId: "p.test" });
  await assert.rejects(
    core.run({ op: "task.take", input: { id: "T1", _as: "bob" } }),
    helpers.isInputAsForbidden,
  );
});

// 4. run — accepts any of the 18 ops without rejection; rejects unknown

test("plugin-core-adapter: run rejects unknown op without mutating state (rejection happens before any lock)", async () => {
  await helpers.withIsolatedEnv(async () => {
    const dir = await helpers.createTempProject();
    try {
      const core = await helpers.freshCore(dir, { agent: "alice", pluginId: "p.test" });
      // Baseline log AFTER setup. helpers.freshCore() runs `init` + `add-initiative`
      // — both emit a log entry. The "no new entries after the rejected
      // call" contract must compare against the post-setup baseline,
      // not against an empty array. Without this, the assert would
      // double-count the add-initiative entry as a mutation from the
      // plugin helpers.pathModule under test.
      const baseline = await helpers.readState(dir);
      const baselineLogLen = baseline.log.length;
      const baselineUserNodes = Object.keys(baseline.nodes).filter(helpers.isUserNodeId);
      await assert.rejects(
        core.run({ op: "task.unknown", input: {} }),
        helpers.isInvalidPluginCoreOperation,
      );
      const after = await helpers.readState(dir);
      // No user-shaped nodes created after the rejected call (the
      // baseline already carries whatever init/add-initiative planted).
      const userNodes = Object.keys(after.nodes).filter(helpers.isUserNodeId);
      assert.equal(
        userNodes.length,
        baselineUserNodes.length,
        "no new user-shaped nodes after rejection",
      );
      // The log MUST be byte-for-byte the same length and content as

      // touched state (it must not).
      assert.equal(
        after.log.length,
        baselineLogLen,
        "no new log entries after rejection",
      );
      for (let i = 0; i < baselineLogLen; i++) {
        assert.deepEqual(after.log[i], baseline.log[i], `log[${i}] unchanged`);
      }
    } finally {
      await helpers.rmTempProject(dir);
    }
  });
});
