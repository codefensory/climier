import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTempProject,
  importFresh,
  readState,
  rmTempProject,
  runCli,
} from "./helpers.mjs";

async function command(dir, ...args) {
  const result = await runCli(["--project", dir, ...args]);
  const data = JSON.parse(result.stdout);
  return { result, data };
}

async function addTask(dir, id, blockedBy = "") {
  const { result, data } = await command(
    dir,
    "add-task",
    id,
    "--initiative", "lifecycle",
    "--title", id,
    "--body", "implementation",
    "--acceptance", "accepted",
    "--blocked-by", blockedBy,
  );
  assert.equal(result.code, 0, result.stderr);
  return data;
}

async function setupProject(dir) {
  let out = await command(dir, "init");
  assert.equal(out.result.code, 0, out.result.stderr);
  out = await command(dir, "add-initiative", "lifecycle", "--desc", "Lifecycle integration");
  assert.equal(out.result.code, 0, out.result.stderr);
  await addTask(dir, "T1");
  await addTask(dir, "T2", "T1");
}

test("CLI lifecycle integration keeps a dependent blocked until acceptance and reopens rejected work", async () => {
  const dir = await createTempProject();
  try {
    await setupProject(dir);

    let out = await command(dir, "status", "--initiative", "lifecycle");
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.deepEqual(out.data.tasks.ready.map((task) => task.id), ["T1"]);
    assert.deepEqual(out.data.tasks.blocked.map((task) => task.id), ["T2"]);
    assert.equal(out.data.summary.submitted, 0);

    out = await command(dir, "take", "T1", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.equal(out.data.node.status, "in_progress");

    out = await command(dir, "submit", "T1", "--note", "ready for validation", "--as", "other-worker");
    assert.equal(out.result.code, 1);
    assert.equal(out.data.ok, false);
    assert.equal(out.data.error.code, "NOT_OWNER");

    out = await command(dir, "submit", "T1", "--note", "ready for validation", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.equal(out.data.node.status, "submitted");
    assert.deepEqual(out.data.newly_ready, []);

    out = await command(dir, "status", "--initiative", "lifecycle");
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.deepEqual(out.data.tasks.submitted.map((task) => task.id), ["T1"]);
    assert.deepEqual(out.data.tasks.ready, []);
    assert.deepEqual(out.data.tasks.blocked.map((task) => task.id), ["T2"]);

    out = await command(dir, "context", "T1", "--as", "validator");
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.equal(out.data.derived_status, "submitted");
    assert.ok(out.data.allowed_actions.includes("accept"));
    assert.ok(out.data.allowed_actions.includes("reject"));
    assert.ok(!out.data.allowed_actions.includes("take"));
    assert.ok(!out.data.allowed_actions.includes("release"));

    for (const operation of ["take", "release"]) {
      out = await command(dir, operation, "T1", "--as", "validator");
      assert.equal(out.result.code, 1);
      assert.equal(out.data.ok, false);
    }

    out = await command(dir, "accept", "T1", "--as", "validator");
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.equal(out.data.node.status, "done");
    assert.deepEqual(out.data.newly_ready, ["T2"]);

    out = await command(dir, "take", "T2", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    out = await command(dir, "submit", "T2", "--note", "second handoff", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    out = await command(dir, "reject", "T2", "--reason", "needs another check", "--as", "validator");
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.equal(out.data.node.status, "open");
    assert.equal(out.data.node.claim, null);

    out = await command(dir, "status", "--initiative", "lifecycle");
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.deepEqual(out.data.tasks.ready.map((task) => task.id), ["T2"]);
    assert.deepEqual(out.data.tasks.submitted, []);

    const state = await readState(dir);
    const rejection = state.log.at(-1);
    assert.equal(rejection.action, "task.reject");
    assert.equal(rejection.reason, "needs another check");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI lifecycle integration preserves release/cancel/reopen and resolve compatibility", async () => {
  const dir = await createTempProject();
  try {
    await setupProject(dir);
    await addTask(dir, "T3");
    await addTask(dir, "T4");
    await addTask(dir, "T5");

    let out = await command(dir, "take", "T3", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    out = await command(dir, "release", "T3", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.equal(out.data.node.status, "open");
    assert.equal(out.data.node.claim, null);

    out = await command(dir, "take", "T3", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    out = await command(dir, "cancel", "T3", "--reason", "out of scope", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.equal(out.data.node.status, "canceled");
    assert.equal(out.data.node.claim, null);

    out = await command(dir, "take", "T4", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    out = await command(dir, "submit", "T4", "--note", "handoff", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    out = await command(dir, "accept", "T4", "--as", "validator");
    assert.equal(out.result.code, 0, out.result.stderr);
    out = await command(dir, "reopen", "T4", "--reason", "follow-up needed", "--as", "orchestrator");
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.equal(out.data.node.status, "open");
    for (const field of ["claim", "submitted_by", "submitted_at", "accepted_by", "accepted_at", "done_by", "done_at"]) {
      assert.equal(out.data.node[field] ?? null, null, `${field} should be cleared by reopen`);
    }

    out = await command(dir, "take", "T5", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    out = await command(dir, "resolve", "T5", "--note", "manual compatibility bypass", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.equal(out.data.node.status, "done");
    assert.equal(out.data.node.note, "manual compatibility bypass");
  } finally {
    await rmTempProject(dir);
  }
});

test("plugin core registry and query expose the same submission lifecycle", async () => {
  const dir = await createTempProject();
  try {
    await setupProject(dir);
    const { createApi } = await importFresh("./plugins/api.mjs");
    const worker = createApi({ projectDir: dir, agent: "worker", pluginId: "integration.worker" });
    const validator = createApi({ projectDir: dir, agent: "validator", pluginId: "integration.validator" });

    let out = await worker.core.run({ op: "task.take", input: { id: "T1" } });
    assert.equal(out.result.status, "in_progress");
    out = await worker.core.run({ op: "task.submit", input: { id: "T1", note: "plugin handoff" } });
    assert.equal(out.result.status, "submitted");
    assert.deepEqual(out.effects, { newly_ready: [] });

    let status = await validator.query.status({ initiative: "lifecycle" });
    assert.deepEqual(status.tasks.submitted.map((task) => task.id), ["T1"]);
    assert.deepEqual(status.tasks.blocked.map((task) => task.id), ["T2"]);
    let context = await validator.query.context("T1");
    assert.equal(context.derived_status, "submitted");
    assert.ok(context.allowed_actions.includes("accept"));

    out = await validator.core.run({ op: "task.accept", input: { id: "T1" } });
    assert.equal(out.result.status, "done");
    assert.deepEqual(out.effects, { newly_ready: ["T2"] });

    status = await validator.query.status({ initiative: "lifecycle" });
    assert.deepEqual(status.tasks.ready.map((task) => task.id), ["T2"]);
    const state = await readState(dir);
    assert.deepEqual(
      state.log.filter((entry) => entry.plugin_id).map((entry) => entry.action),
      ["task.take", "task.submit", "task.accept"],
    );
  } finally {
    await rmTempProject(dir);
  }
});
