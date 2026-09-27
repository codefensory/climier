// Split from test/plugin-api.test.mjs; complete original test bodies and cleanup are retained.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmTempProject, readState as readRawState, installPolicyFixture, uninstallPolicyFixture } from "../../helpers.mjs";
import { freshApi, readyProject } from "./fixtures.mjs";

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
    assert.equal(out.result.node.subkind, "gate", "provider's result.node.subkind === gate");
    assert.equal(out.result.node.status, "resolved", "provider's result.node.status === resolved");
    assert.deepEqual(
      out.result.resolution,
      { choice: "approve V2", rationale: "ADR-006 defines it; parity closes the surface" },
      "provider's result.resolution carries {choice, rationale}",
    );
    // Kernel-stamped post-state lives on diff.updated[0].node.
    assert.equal(out.diff.updated[0].id, "G-parity-resolve");
    assert.equal(out.diff.updated[0].node.revision, seedRevision + 1, "resolve advances the global revision");
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
    assert.equal(after.nodes["G-parity-resolve"].revision, seedRevision + 1, "persisted revision matches the kernel diff");
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
    const reopenCreated = await apiAlice.core.run({
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
      reopenCreated.diff.created[0].node.revision + 2,
      "reopen advances beyond create and resolve revisions",
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
    const cancelCreated = await apiAlice.core.run({
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
      cancelCreated.diff.created[0].node.revision + 1,
      "cancel advances beyond the created gate revision",
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
    assert.equal(after.nodes["G-parity-reopen"].revision, reopened.diff.updated[0].node.revision);
    assert.equal(after.nodes["G-parity-cancel"].status, "canceled", "persisted cancel status is canceled");
    assert.equal(after.nodes["G-parity-cancel"].revision, canceled.diff.updated[0].node.revision);
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
