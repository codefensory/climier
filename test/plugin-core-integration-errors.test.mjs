import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  initProject,
  makeApi,
  readState,
  rejectUnknownCoreOperation,
  rejectSpoofedActor,
  rejectNonObjectCoreInput,
  taskInput,
} from "./plugin-core-integration-helpers.mjs";

test("plugin-core-integration: PLUGIN_CORE_INVALID_OPERATION does not mutate and lists supported ops", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    const api = await makeApi(dir, { agent: "alice", pluginId: "example.core" });
    const before = await readState(dir);
    const beforeEdges = before.edges.length;
    const beforeNodes = Object.keys(before.nodes).length;
    const beforeLogs = before.log.length;
    // Unknown op — must reject before any lock.
    await rejectUnknownCoreOperation(api);
    // input.as — must reject.
    await rejectSpoofedActor(api);
    // Non-object input is rejected before the provider and lock.
    await rejectNonObjectCoreInput(api);
    const after = await readState(dir);
    assert.equal(after.edges.length, beforeEdges, "no edges added by rejected runs");
    assert.equal(Object.keys(after.nodes).length, beforeNodes, "no nodes added by rejected runs");
    assert.equal(after.log.length, beforeLogs, "no log entries added by rejected runs");
  } finally {
    await rmTempProject(dir);
  }
});

test("plugin-core-integration: handler-rejected actions surface as PLUGIN_CORE_ACTION_FAILED with structured cause", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    const api = await makeApi(dir, { agent: "alice", pluginId: "example.core" });
    // task.take against a non-existent task throws NODE_NOT_FOUND.
    await assert.rejects(
      api.core.run({ op: "task.take", input: { id: "T-bogus" } }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.op === "task.take" &&
        err.details.plugin_id === "example.core" &&
        err.details.cause &&
        err.details.cause.code === "NODE_NOT_FOUND",
    );
    // add-edge from a missing node → INVALID_EDGE_TARGET (add-edge
    // validates both endpoints before mutating). The adapter wraps it
    // as PLUGIN_CORE_ACTION_FAILED with the structured cause.
    await assert.rejects(
      api.core.run({
        op: "edge.add",
        input: { from: "T-no", to: "T-still-no", type: "BLOCKS" },
      }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.op === "edge.add" &&
        err.details.cause &&
        (err.details.cause.code === "INVALID_EDGE_TARGET" ||
          err.details.cause.code === "NODE_NOT_FOUND" ||
          err.details.cause.code === "CORE_ERROR"),
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("plugin-core-integration: a successful task.create is preserved when a subsequent edge.add fails", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    const api = await makeApi(dir, { agent: "alice", pluginId: "example.core" });
    // Success: create the task.
    await api.core.run({ op: "task.create", input: taskInput("T-partial-1", "t") });
    // Failure: edge.add to a missing target.
    await assert.rejects(
      api.core.run({
        op: "edge.add",
        input: { from: "T-partial-1", to: "T-partial-2-missing", type: "BLOCKS" },
      }),
      (err) => err && err.code === "PLUGIN_CORE_ACTION_FAILED",
    );
    // The previously created task is still present (no roll-back).
    const after = await readState(dir);
    assert.ok(after.nodes["T-partial-1"], "T-partial-1 survives a failed follow-up");
    assert.equal(after.nodes["T-partial-1"].status, "open");
    assert.equal(after.edges.length, 0, "no BLOCKS edge added because edge.add failed before the lock");
  } finally {
    await rmTempProject(dir);
  }
});
