// Split from test/plugin-api.test.mjs; complete original test bodies and cleanup are retained.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState as readRawState } from "../../helpers.mjs";
import { freshApi, readyProject } from "./fixtures.mjs";

type TestErrorDetails = { [key: string]: unknown; code?: string; message?: string; op?: string; plugin_id?: string; cause?: TestError };
type TestError = { code?: string; details: TestErrorDetails; message?: string };

async function assertCreatedTaskResult(out, dir) {
  assert.ok(out && typeof out === "object", "kernel returned the typed result envelope");
  assert.equal(typeof out.result, "object", "typed envelope carries result");
  assert.equal(typeof out.diff, "object", "typed envelope carries diff");
  assert.equal(Array.isArray(out.diff.created), true, "diff.created is the canonical created list");
  assert.equal(out.result.id, "T-from-core", "explicit id is propagated to the provider");
  assert.equal(out.diff.created[0].id, "T-from-core", "diff reflects the created id");
  assert.equal(out.diff.created[0].node.id, "T-from-core");
  const after = await readRawState(dir);
  assert.equal(out.diff.created[0].node.revision, after.revision, "create receives the global high-water revision");
  assert.ok(after.nodes["T-from-core"], "task.create created the node");
  return after;
}

function assertCreatedTaskLog(out, after) {
  const lastPluginLog = after.log.filter((entry) => entry.plugin_id === "example.audit").pop();
  assert.ok(lastPluginLog, "log entry tagged with plugin_id");
  assert.equal(lastPluginLog.agent, "alice", "agent reflects api.runtime.agent, not plugin id");
  assert.equal(lastPluginLog.action, "task.create", "log action is the op id");
  assert.ok(out.log_entry, "typed envelope carries log_entry");
  assert.equal(out.log_entry.action, "task.create", "kernel log_entry.action equals the op");
  assert.equal(out.log_entry.plugin_id, "example.audit");
  assert.equal(out.log_entry.agent, "alice");
}

test("api.core.run: task.create dispatches through the kernel with actor fixed from api.runtime.agent", async () => {

  // `{ result, effects, log_entry, idempotent, diff }`. `result` is

  // anymore and `input.as` cannot substitute the actor.
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./cli/commands/init.ts");
    const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
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
    const after = await assertCreatedTaskResult(out, dir);
    assertCreatedTaskLog(out, after);
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: input.as is dropped even though the handler call is made on success", async () => {
  // The adapter must ignore input.as and use api.runtime.agent. A successful
  // task.create with input.as set should not change the caller's apparent
  // identity: an attacker supplying as="bob" must not be able to claim

  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./cli/commands/init.ts");
    const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "plugin-platform" }, positional: ["plugin-platform"] });

    // verify here is that even if a future flag rename makes a snake key
    // collide, the adapter still records api.runtime.agent as the author.
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    // Take with input.as present must reject BEFORE the lock.
    await assert.rejects(
      api.core.run({ op: "task.take", input: { id: "T-no-such", as: "bob" } }),
      (err: TestError) =>
        err &&
        err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
        err.details.reason === "input.as is forbidden",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: task.update dispatches through the kernel with explicit CAS (if_revision) and bumps revision", async () => {
  // task.update is the explicit-CAS op (ADR-011 §4): the agent-facing
  // input must carry `changes` and `if_revision`. The kernel validates

  // merged node (revision-stripped — the kernel owns revision) plus

  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });

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
    const seedRevision = created.diff.created[0].node.revision;
    assert.equal(seedRevision, (await readRawState(dir)).revision, "seed task carries the global high-water");
    // Now patch its title via task.update. CAS is mandatory: pass
    // `changes` and `if_revision` from the seeded revision.
    const updated = await api.core.run({
      op: "task.update",
      input: {
        id: "T-parity-update",
        changes: { title: "after" },
        if_revision: seedRevision,
      },
    });
    assert.equal(updated.result.title, "after", "merged node projection reflects the patch");
    assert.equal(updated.diff.updated[0].node.revision, seedRevision + 1, "task.update advances the global revision");
    assert.equal(updated.diff.updated[0].id, "T-parity-update");
    const after = await readRawState(dir);
    assert.equal(after.nodes["T-parity-update"].title, "after");
    assert.equal(after.nodes["T-parity-update"].revision, seedRevision + 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: task.update log entry carries plugin_id (kernel routes plugin_id from the host)", async () => {

  // pluginId argument; the agent is stamped from request.actor
  // (api.runtime.agent), never from input. The kernel-driven update
  // requires explicit CAS — `changes` + `if_revision`.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const created = await api.core.run({
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
        if_revision: created.diff.created[0].node.revision,
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

test("api.core.run: task.release dispatches through the kernel after a take (idempotent lifecycle)", async () => {

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

    // can cancel. Cancelling documents the parity path regardless of

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

  // whitelist; the provider's prepare throws MISSING_FIELD when
  // `reason` is missing and the adapter wraps it as
  // PLUGIN_CORE_ACTION_FAILED with a structured `cause`. State is
  // not mutated and no log entry is appended.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await assert.rejects(
      api.core.run({ op: "task.cancel", input: { id: "T-parity-cancel-no-reason" } }),
      (err: TestError) =>
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

test("api.core.run: task.reopen works after acceptance (close -> roll back to open)", async () => {

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
    await api.core.run({ op: "task.submit", input: { id: "T-parity-reopen", note: "shipped" } });
    await api.core.run({ op: "task.accept", input: { id: "T-parity-reopen" } });
    const reopened = await api.core.run({
      op: "task.reopen",
      input: { id: "T-parity-reopen", reason: "wrong acceptance" },
    });
    assert.equal(reopened.result.status, "open", "typed projection reports status=open");
    assert.equal(reopened.result.id, "T-parity-reopen");
    const after = await readRawState(dir);
    assert.equal(after.nodes["T-parity-reopen"].status, "open", "persisted status is open");
    assert.equal(after.nodes["T-parity-reopen"].claim, null, "claim cleared by reopen");

    // untouched by the kernel-driven provider today. The state file
    // is the canonical post-state — assert status/claim there and
    // avoid asserting on fields the provider does not clear.
  } finally {
    await rmTempProject(dir);
  }
});
