// Split from test/plugin-api.test.mjs; complete original test bodies and cleanup are retained.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmTempProject, readState as readRawState, installPolicyFixture, uninstallPolicyFixture } from "../../helpers.ts";
import { freshApi, readyProject } from "./fixtures.ts";

type TestErrorDetails = { [key: string]: unknown; code?: string; message?: string; op?: string; plugin_id?: string; cause?: TestError };
type TestError = { code?: string; details: TestErrorDetails; message?: string };

function assertGateCreatedEnvelope(out, id) {
  assert.ok(out && typeof out === "object", "kernel returned the typed result envelope");
  assert.equal(typeof out.result, "object", "typed envelope carries result");
  assert.equal(typeof out.diff, "object", "typed envelope carries diff");
  assert.equal(Array.isArray(out.diff.created), true, "diff.created is the canonical created list");
  assert.equal(out.result.node.subkind, "gate", "provider's result.node.subkind === gate");
  assert.equal(out.result.node.purpose, "decision", "provider's result.node.purpose echoes the input");
  assert.equal(out.result.superseded, null, "no superseded gate on a non-supersede create");
  assert.deepEqual(out.result.edges, [], "no blocker edges on a plain create");
  assert.equal(out.diff.created[0].id, id);
  assert.equal(out.diff.created[0].node.id, id);
}

function assertGateLogEntry(entry, action, id, agent = "alice") {
  assert.ok(entry, "typed envelope carries log_entry");
  assert.equal(entry.action, action, "kernel log_entry.action equals the op");
  assert.equal(entry.plugin_id, "example.audit");
  assert.equal(entry.agent, agent, "log records api.runtime.agent, not the plugin id");
  assert.equal(entry.node, id);
}

function assertGateResolvedResult(out, seedRevision) {
  assert.equal(out.result.node.subkind, "gate", "provider's result.node.subkind === gate");
  assert.equal(out.result.node.status, "resolved", "provider's result.node.status === resolved");
  const resolution = { choice: "approve V2", rationale: "ADR-006 defines it; parity closes the surface" };
  assert.deepEqual(out.result.resolution, resolution, "provider's result.resolution carries {choice, rationale}");
  assert.equal(out.diff.updated[0].id, "G-parity-resolve");
  assert.equal(out.diff.updated[0].node.revision, seedRevision + 1, "resolve advances the global revision");
  assert.equal(out.diff.updated[0].node.status, "resolved");
  assert.deepEqual(out.diff.updated[0].node.resolution, resolution);
  assertGateLogEntry(out.log_entry, "gate.resolve", "G-parity-resolve");
}

function assertGateResolvedState(after, revision) {
  const node = after.nodes["G-parity-resolve"];
  assert.equal(node.status, "resolved", "persisted status is resolved");
  assert.deepEqual(node.resolution, { choice: "approve V2", rationale: "ADR-006 defines it; parity closes the surface" });
  assert.equal(node.revision, revision, "persisted revision matches the kernel diff");
  const entry = after.log.filter((item) => item.plugin_id === "example.audit" && item.action === "gate.resolve").pop();
  assert.ok(entry, "resolve log entry tagged with plugin_id");
  assert.equal(entry.agent, "alice");
}

function assertGateTransitionResult(out, { id, status, revision, action, agent }) {
  assert.equal(out.result.node.subkind, "gate", "provider's result.node.subkind === gate");
  assert.equal(out.result.node.status, status, `gate ${status}`);
  if (status === "open") {
    assert.equal(out.result.node.resolution, null, "provider clears resolution on reopen");
    assert.equal(out.diff.updated[0].node.resolution, null, "kernel-stamped post-state has resolution=null");
  }
  assert.equal(out.diff.updated[0].id, id);
  assert.equal(out.diff.updated[0].node.revision, revision);
  assert.equal(out.diff.updated[0].node.status, status);
  assertGateLogEntry(out.log_entry, action, id, agent);
}

async function assertGateTransition(out, details, dir) {
  assertGateTransitionResult(out, details);
  const after = await readRawState(dir);
  assertGateTransitionState(after, details.id, details.status, out.diff.updated[0].node.revision);
}

function assertGateFailureState(after, id) {
  assert.equal(after.nodes[id].status, "open", "failed resolve leaves the gate open");
  assert.equal(after.log.filter((entry) => entry.action === "gate.resolve").length, 0, "no resolve log entry on failed run");
}

async function runGateReopen(apiAlice, apiAdmin) {
  const created = await apiAlice.core.run({
    op: "gate.create",
    input: { id: "G-parity-reopen", initiative: "plugin-platform", title: "x", body: "b", purpose: "decision" },
  });
  await apiAlice.core.run({
    op: "gate.resolve",
    input: { id: "G-parity-reopen", choice: "yes", rationale: "first decision" },
  });
  const reopened = await apiAdmin.core.run({
    op: "gate.reopen",
    input: { id: "G-parity-reopen", reason: "second thoughts" },
  });
  return { created, reopened };
}

async function runGateCancel(apiAlice, apiAdmin) {
  const created = await apiAlice.core.run({
    op: "gate.create",
    input: { id: "G-parity-cancel", initiative: "plugin-platform", title: "y", body: "b", purpose: "decision" },
  });
  const canceled = await apiAdmin.core.run({
    op: "gate.cancel",
    input: { id: "G-parity-cancel", reason: "irrelevant" },
  });
  return { created, canceled };
}

function assertGateTransitionState(after, id, status, revision) {
  assert.equal(after.nodes[id].status, status, "persisted status matches the gate transition");
  assert.equal(after.nodes[id].revision, revision, "persisted revision matches the gate transition");
}

function assertGateTransitionLogs(after, action, id) {
  const entries = after.log.filter((entry) => entry.action === action && entry.node === id);
  assert.equal(entries.length, 1, `exactly one ${action} log entry`);
  assert.equal(entries[0].plugin_id, "example.audit");
  assert.equal(entries[0].agent, "release-admin");
}

function assertGateLifecycleState(after, reopenRevision, cancelRevision) {
  assertGateTransitionState(after, "G-parity-reopen", "open", reopenRevision);
  assertGateTransitionState(after, "G-parity-cancel", "canceled", cancelRevision);
  assertGateTransitionLogs(after, "gate.reopen", "G-parity-reopen");
  assertGateTransitionLogs(after, "gate.cancel", "G-parity-cancel");
}

test("api.core.run: gate.create dispatches through the kernel and surfaces the typed gate envelope", async () => {

  // `{ result, effects, log_entry, idempotent, diff }`. The provider's
  // apply projects `{ node, superseded, edges }` into `result`; the
  // kernel-stamped revision lives on `diff.created[0].node`. There is

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
    assertGateCreatedEnvelope(out, "G-parity-create");
    assert.equal(out.diff.created[0].node.revision, (await readRawState(dir)).revision, "create receives the global high-water revision");
    assert.equal(out.diff.created[0].node.subkind, "gate");
    assert.equal(out.diff.created[0].node.purpose, "decision");
    const after = await readRawState(dir);
    assert.ok(after.nodes["G-parity-create"], "gate is in state");
    assert.equal(after.nodes["G-parity-create"].subkind, "gate");
    assert.equal(after.nodes["G-parity-create"].revision, out.diff.created[0].node.revision, "persisted revision matches the kernel diff");
    const lastPluginLog = after.log.filter((e) => e.plugin_id === "example.audit").pop();
    assert.ok(lastPluginLog, "log entry tagged with plugin_id");
    assert.equal(lastPluginLog.agent, "alice", "agent reflects api.runtime.agent, not plugin id");
    assert.equal(lastPluginLog.action, "gate.create", "log action is the op id");
    assert.equal(lastPluginLog.node, "G-parity-create");
    assertGateLogEntry(out.log_entry, "gate.create", "G-parity-create");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: gate.create without --purpose is rejected with PLUGIN_CORE_ACTION_FAILED (provider-level MISSING_FIELD)", async () => {

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
      (err: TestError) =>
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
    const seedRevision = created.diff.created[0].node.revision;
    assert.equal(seedRevision, (await readRawState(dir)).revision, "seed gate carries the global high-water");
    const out = await api.core.run({
      op: "gate.resolve",
      input: {
        id: "G-parity-resolve",
        choice: "approve V2",
        rationale: "ADR-006 defines it; parity closes the surface",
      },
    });
    // Provider's typed projection on out.result (revision-stripped draft view).
    assertGateResolvedResult(out, seedRevision);
    const after = await readRawState(dir);
    assertGateResolvedState(after, seedRevision + 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: gate.resolve without --rationale is rejected with PLUGIN_CORE_ACTION_FAILED (provider-level MISSING_FIELD)", async () => {

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
      (err: TestError) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.op === "gate.resolve" &&
        err.details.plugin_id === "example.audit" &&
        err.details.cause &&
        err.details.cause.code === "MISSING_FIELD" &&
        /rationale/.test(err.details.cause.message || ""),
    );
    const after = await readRawState(dir);
    assertGateFailureState(after, "G-parity-resolve-no-rationale");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: gate.reopen and gate.cancel roll back or terminate gates with --reason", async () => {

  // gate. The policy-fixture below exercises the seam allow path
  // explicitly to keep coverage of the optional policy-driven branch

  //
  // gate.reopen and gate.cancel return the provider's typed projection
  // on `out.result.node` (revision-stripped draft view). The
  // kernel-stamped post-state lives on `diff.updated[0].node`, and

  const dir = await readyProject();
  await installPolicyFixture(dir);
  try {
    const apiAlice = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const apiAdmin = await freshApi(dir, { agent: "release-admin", pluginId: "example.audit" });
    const { created: reopenCreated, reopened } = await runGateReopen(apiAlice, apiAdmin);
    const reopenDetails = {
      id: "G-parity-reopen",
      status: "open",
      revision: reopenCreated.diff.created[0].node.revision + 2,
      action: "gate.reopen",
      agent: "release-admin",
    };
    await assertGateTransition(reopened, reopenDetails, dir);

    const { created: cancelCreated, canceled } = await runGateCancel(apiAlice, apiAdmin);
    const cancelDetails = {
      id: "G-parity-cancel",
      status: "canceled",
      revision: cancelCreated.diff.created[0].node.revision + 1,
      action: "gate.cancel",
      agent: "release-admin",
    };
    await assertGateTransition(canceled, cancelDetails, dir);
    const after = await readRawState(dir);
    assert.equal(after.nodes["G-parity-reopen"].resolution, null, "persisted resolution cleared by reopen");
    assertGateLifecycleState(after, reopenDetails.revision, cancelDetails.revision);
  } finally {
    await uninstallPolicyFixture(dir);
    await rmTempProject(dir);
  }
});
