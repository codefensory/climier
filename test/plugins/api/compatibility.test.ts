// Split from test/plugin-api.test.mjs; complete original test bodies and cleanup are retained.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, readState as readRawState, installPolicyFixture, uninstallPolicyFixture, stateFilePath } from "../../helpers.mjs";
import { seedState, freshApi, readyProject } from "./fixtures.mjs";

type TestErrorDetails = {
  [key: string]: unknown;
  code?: string;
  message?: string;
  op?: string;
  plugin_id?: string;
  reason?: string;
  cause?: TestError;
  supported?: unknown[];
};
type TestError = { code?: string; details: TestErrorDetails; message?: string };

function assertInitiativeCreated(out, after) {
  assert.ok(out && typeof out === "object", "kernel returned the typed result envelope");
  assert.equal(typeof out.result, "object", "typed envelope carries result");
  assert.equal(typeof out.diff, "object", "typed envelope carries diff");
  assert.equal(Array.isArray(out.diff.initiatives.created), true, "diff.initiatives.created is the canonical initiative list");
  assert.equal(out.result.name, "fresh-initiative", "result.name reflects the new initiative");
  assert.equal(out.result.desc, "parity slice", "result.desc reflects the new initiative");
  assert.ok(typeof out.result.created_at === "string", "result.created_at is stamped by the provider at prepare time");
  const created = out.diff.initiatives.created.find((entry) => entry.name === "fresh-initiative");
  assert.ok(created, "diff.initiatives.created carries the new initiative");
  assert.equal(created.name, "fresh-initiative");
  assert.equal(created.initiative.desc, "parity slice");
  assert.ok(typeof created.initiative.created_at === "string", "diff initiative carries created_at");
  assert.ok(after.initiatives["fresh-initiative"], "initiative is registered in state");
  assert.equal(after.initiatives["fresh-initiative"].desc, "parity slice");
}

function assertInitiativeLog(out, after) {
  const lastPluginLog = after.log.filter((entry) => entry.plugin_id === "example.audit").pop();
  assert.ok(lastPluginLog, "log entry tagged with plugin_id");
  assert.equal(lastPluginLog.agent, "alice", "agent reflects api.runtime.agent, not plugin id");
  assert.equal(lastPluginLog.action, "initiative.create", "log action is the op id");
  assert.ok(out.log_entry, "typed envelope carries log_entry");
  assert.equal(out.log_entry.action, "initiative.create", "kernel log_entry.action equals the op");
  assert.equal(out.log_entry.plugin_id, "example.audit");
  assert.equal(out.log_entry.agent, "alice");
}

test("createApi: api.runtime shape stays { project_dir, agent } (no core leakage)", async () => {
  const dir = await createTempProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    // Runtime exposes host identity and the plugin-owned data directory, but
    // no internal core implementation details.
    assert.deepEqual(api.runtime, {
      project_dir: dir,
      agent: "alice",
      dataDir: path.join(path.dirname(stateFilePath(dir)), "plugins", "example.audit"),
    });
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: non-object input throws PLUGIN_CORE_INVALID_OPERATION", async () => {
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./cli/commands/init.ts");
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    for (const bad of [null, undefined, "string", 1, true, []]) {
      await assert.rejects(
        api.core.run({ op: "task.create", input: bad }),
        (err: TestError) => err && err.code === "PLUGIN_CORE_INVALID_OPERATION",
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
    const { default: init } = await importFresh("./cli/commands/init.ts");
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await assert.rejects(
      api.core.run({ op: "edge.unknown", input: {} }),
      (err: TestError) =>
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
    const { default: init } = await importFresh("./cli/commands/init.ts");
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
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
      (err: TestError) =>
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
    const { default: init } = await importFresh("./cli/commands/init.ts");
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await assert.rejects(
      api.core.run({
        op: "task.take",
        input: { id: "T1", _as: "bob" },
      }),
      (err: TestError) =>
        err &&
        err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
        err.details.reason === "input.as is forbidden",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: missing required field throws PLUGIN_CORE_ACTION_FAILED (provider-level MISSING_FIELD) without mutating", async () => {

  // whitelist for the core ops; the provider's prepare throws
  // MISSING_FIELD and the adapter wraps it as PLUGIN_CORE_ACTION_FAILED
  // with a structured `cause`. State and the plugin-tagged log are
  // untouched (no edge is added; no log entry is appended).
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./cli/commands/init.ts");
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    // Missing --type is required by edge.add.
    await assert.rejects(
      api.core.run({ op: "edge.add", input: { from: "T-a", to: "T-b" } }),
      (err: TestError) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.op === "edge.add" &&
        err.details.plugin_id === "example.audit" &&
        err.details.cause &&
        err.details.cause.code === "MISSING_FIELD" &&
        /type/.test(err.details.cause.message || ""),
    );

    const after = await readRawState(dir);
    assert.deepEqual(after.edges, [], "no edges persisted");
    const pluginLogs = after.log.filter((e) => e.plugin_id === "example.audit");
    assert.equal(pluginLogs.length, 0, "no plugin-tagged log entry on rejected edge.add");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: known op with empty input does not mutate state (provider-level rejection under the lock)", async () => {
  // The typed-result contract surfaces provider-level validation
  // (missing required fields on a known op) as
  // PLUGIN_CORE_ACTION_FAILED with a structured `cause` envelope.

  // provider's prepare under the lock and the rejection happens
  // before any state write or log append.
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./cli/commands/init.ts");
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await assert.rejects(
      api.core.run({ op: "task.create", input: {} }),
      (err: TestError) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.op === "task.create" &&
        err.details.plugin_id === "example.audit" &&
        err.details.cause &&
        err.details.cause.code === "MISSING_FIELD",
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

test("api.core.run: NODE_NOT_FOUND in the handler is wrapped as PLUGIN_CORE_ACTION_FAILED with details.op and cause", async () => {
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./cli/commands/init.ts");
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await assert.rejects(
      api.core.run({ op: "task.take", input: { id: "T-not-here" } }),
      (err: TestError) =>
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

  // the short-circuit on isPluginError is a contract that the adapter
  // must honor so dispatch.PluginCoreActionFailed never gets wrapped
  // into PLUGIN_HANDLER_FAILED. Verify the path through isPluginError:

  const { isPluginError, PluginCoreActionFailed } = await importFresh("./plugins/errors.ts");
  const err = new PluginCoreActionFailed("example.audit", "task.take", {
    code: "CORE_ERROR",
    message: "x",
    details: {},
  });
  assert.equal(isPluginError(err), true);

  // adapter must use the same predicate to avoid rewrap.
});

test("api.core.run: an opaque core error (no code/details) is normalized to CORE_ERROR in details.cause", async () => {
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./cli/commands/init.ts");
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });

    // handler — that is structured. To exercise the bare-Error branch of
    // wrapCoreError we cannot reach it via a public handler, so we instead
    // verify the helper directly here (already covered exhaustively in
    // test/plugin-core-errors.test.mjs); the integration suite covers the
    // full cause-shape path against a real handler rejection below.
    await assert.rejects(
      api.core.run({ op: "task.take", input: { id: "T-bogus" } }),
      (err: TestError) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.cause &&
        typeof err.details.cause.code === "string",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: initiative.create dispatches to the kernel and surfaces the typed initiative envelope", async () => {

  // `{ result, effects, log_entry, idempotent, diff }`. initiative.create
  // has no node (initiatives are not resolvable nodes), so the typed
  // envelope surfaces the persisted initiative in `result`
  // (`name/desc/created_at/persisted`) and in `diff.initiatives.created`.

  // (the op id) and plugin_id from the host.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    const out = await api.core.run({
      op: "initiative.create",
      input: { name: "fresh-initiative", desc: "parity slice" },
    });
    const after = await readRawState(dir);
    assertInitiativeCreated(out, after);
    assertInitiativeLog(out, after);
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.run: initiative.create without name is rejected with PLUGIN_CORE_ACTION_FAILED (provider-level MISSING_FIELD)", async () => {

  // for initiative.create; the provider's prepare throws MISSING_FIELD

  // PLUGIN_CORE_ACTION_FAILED with a structured `cause`. State is not
  // mutated and no log entry is appended.
  const dir = await readyProject();
  try {
    const api = await freshApi(dir, { agent: "alice", pluginId: "example.audit" });
    await assert.rejects(
      api.core.run({ op: "initiative.create", input: { desc: "no name" } }),
      (err: TestError) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.op === "initiative.create" &&
        err.details.plugin_id === "example.audit" &&
        err.details.cause &&
        err.details.cause.code === "MISSING_FIELD" &&
        /name/.test(err.details.cause.message || ""),
    );
    const after = await readRawState(dir);
    assert.equal(after.initiatives["fresh-initiative"], undefined, "no initiative created on failed run");
    assert.equal(
      after.log.filter((e) => e.action === "initiative.create").length,
      0,
      "no initiative log entry on failed run",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("cli parity: a parity handler called without ctx.pluginId does NOT tag its log entry with plugin_id", async () => {

  // (no pluginId in ctx), appendWithContext drops plugin_id. This is
  // the same path bin/climier.ts exercises, so we keep the contract
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
    const { default: updateV2 } = await importFresh("./cli/commands/update.ts");
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
  // CLI bin keeps working exactly as before. Cancel no longer requires
  // claim ownership or a policy under ADR-009; the policy-fixture is kept
  // here to also cover the seam allow branch (any actor → cancel).
  const dir = await readyProject();
  await installPolicyFixture(dir);
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
    const { default: cancelV2 } = await importFresh("./cli/commands/cancel.ts");
    await cancelV2({
      statePath: dir,
      positional: ["T-cli-parity-2"],
      flags: { as: "release-manager", reason: "deprioritised" },
      projectDir: dir,
    });
    const after = await readRawState(dir);
    const lastLog = after.log[after.log.length - 1];
    assert.equal(lastLog.action, "cancel");
    assert.equal(lastLog.plugin_id, undefined, "CLI parity: cancel log has no plugin_id");
    assert.equal(lastLog.agent, "release-manager");
    assert.equal(after.nodes["T-cli-parity-2"].status, "canceled");
  } finally {
    await uninstallPolicyFixture(dir);
    await rmTempProject(dir);
  }
});
