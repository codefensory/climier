// Split from test/plugin-api.test.mjs; complete original test bodies and cleanup are retained.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmTempProject, readState as readRawState } from "../../helpers.mjs";
import { freshApi, readyProject } from "./fixtures.mjs";

function assertKnowledgeCreateResult(out) {
  assert.ok(out && typeof out === "object", "kernel returned the typed result envelope");
  assert.equal(typeof out.result, "object", "typed envelope carries result");
  assert.equal(typeof out.diff, "object", "typed envelope carries diff");
  assert.equal(Array.isArray(out.diff.created), true, "diff.created is the canonical created list");
  assert.equal(out.result.id, "K-parity-create", "provider's result.id echoes the input");
  assert.equal(out.result.kind, "knowledge", "provider's result.kind === knowledge");
  const created = out.diff.created[0].node;
  assert.equal(created.id, "K-parity-create");
  assert.equal(created.kind, "knowledge");
  assert.equal(created.status, "active");
  assert.deepEqual(created.scope.tags, ["api", "recovery"], "scope.tags echoes the input");
  assert.ok(out.log_entry, "typed envelope carries log_entry");
  assert.equal(out.log_entry.action, "knowledge.create", "kernel log_entry.action equals the op");
  assert.equal(out.log_entry.plugin_id, "example.audit");
  assert.equal(out.log_entry.agent, "alice");
}

function assertKnowledgeCreateState(out, after) {
  const created = out.diff.created[0].node;
  assert.equal(created.revision, after.revision, "kernel assigns the global high-water on create");
  const persisted = after.nodes["K-parity-create"];
  assert.equal(persisted.status, "active", "persisted status is active");
  assert.deepEqual(persisted.scope.tags, ["api", "recovery"], "scope.tags persisted");
  assert.equal(persisted.revision, created.revision, "persisted revision matches the create result");
  const pluginLogs = after.log.filter((entry) => entry.plugin_id === "example.audit");
  const lastPluginLog = pluginLogs[pluginLogs.length - 1];
  assert.equal(lastPluginLog.action, "knowledge.create", "persisted log action is the op id");
  assert.equal(lastPluginLog.agent, "alice");
}

async function assertKnowledgeCreate(out, dir) {
  assertKnowledgeCreateResult(out);
  assertKnowledgeCreateState(out, await readRawState(dir));
}

function assertKnowledgeDeprecationResult(out, created) {
  assert.ok(out && typeof out === "object", "kernel returned the typed result envelope");
  assert.equal(typeof out.result, "object", "typed envelope carries result");
  assert.equal(typeof out.diff, "object", "typed envelope carries diff");
  assert.equal(Array.isArray(out.diff.updated), true, "diff.updated is the canonical updated list");
  assert.equal(out.result.id, "K-parity-deprecate");
  assert.equal(out.result.kind, "knowledge");
  assert.equal(out.result.status, "deprecated", "provider's result.status === deprecated");
  const updated = out.diff.updated[0].node;
  assert.equal(updated.id, "K-parity-deprecate");
  assert.equal(updated.status, "deprecated", "kernel-stamped updated node carries status=deprecated");
  assert.equal(updated.deprecated_by, "alice", "deprecated_by echoes api.runtime.agent");
  assert.equal(updated.deprecation_reason, "superseded by ADR-007");
  assert.equal(typeof updated.deprecated_at, "string", "deprecated_at is an ISO string");
  assert.equal(updated.revision, created.diff.created[0].node.revision + 1, "deprecate advances the global revision");
  assert.ok(out.log_entry, "typed envelope carries log_entry");
  assert.equal(out.log_entry.action, "knowledge.deprecate");
  assert.equal(out.log_entry.plugin_id, "example.audit");
  assert.equal(out.log_entry.agent, "alice");
}

function assertKnowledgeDeprecationState(out, after) {
  const updated = out.diff.updated[0].node;
  const persisted = after.nodes["K-parity-deprecate"];
  assert.equal(persisted.status, "deprecated", "persisted status is deprecated");
  assert.equal(persisted.deprecated_by, "alice");
  assert.equal(persisted.deprecation_reason, "superseded by ADR-007");
  assert.equal(persisted.revision, updated.revision, "persisted revision matches the update result");
  const deprecateLogs = after.log.filter(
    (entry) => entry.plugin_id === "example.audit" && entry.action === "knowledge.deprecate",
  );
  assert.equal(deprecateLogs.length, 1, "exactly one knowledge.deprecate log entry");
  assert.equal(deprecateLogs[0].agent, "alice");
}

async function assertKnowledgeDeprecation(out, created, dir) {
  assertKnowledgeDeprecationResult(out, created);
  assertKnowledgeDeprecationState(out, await readRawState(dir));
}

function assertKnowledgeDeprecationFailureState(before, after) {
  assert.equal(after.nodes["K-parity-dep-noreason"].status, "active", "node remains active after rejected deprecate");
  assert.equal(
    after.nodes["K-parity-dep-noreason"].revision,
    before.nodes["K-parity-dep-noreason"].revision,
    "node revision unchanged after rejected deprecate",
  );
  assert.equal(after.log.length, before.log.length, "no log entry appended for rejected knowledge.deprecate");
}

test("api.core.run: knowledge.create dispatches to add-knowledge (requires --scope-*)", async () => {

  // `{ result, effects, log_entry, idempotent, diff }`. The

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
    await assertKnowledgeCreate(out, dir);
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: knowledge.create without any --scope-* throws PLUGIN_CORE_ACTION_FAILED", async () => {

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
    const created = await api.core.run({
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
    await assertKnowledgeDeprecation(out, created, dir);
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: knowledge.deprecate without --reason is rejected by the adapter as PLUGIN_CORE_ACTION_FAILED (provider-level MISSING_FIELD)", async () => {

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
    const before = await readRawState(dir);
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

    await assertKnowledgeDeprecationFailureState(before, await readRawState(dir));
  } finally {
    await rmTempProject(dir);
  }
});
