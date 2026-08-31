// T-graph-kernel-core-api-impl — `src/plugins/core-adapter.mjs` unit tests.
//
// The adapter is the V2 plugin core surface: `createCore` returns
// `{ version, run }`. `run` consumes the built-in registry from
// `bootstrapBuiltins()` (17 ops) and forwards every call to
// `kernel.mutate` with the host's actor/pluginId. Selection of the
// policy runs outside the kernel lock; decision runs inside via the
// kernel's `policyAction.decide`. The adapter must:
//
//   - reject unknown op / non-object input / as|_as BEFORE any state
//     mutation (PLUGIN_CORE_INVALID_OPERATION);
//   - route every supported op to the right provider without ever
//     reaching for commands/, argv, locks or CORE_REGISTRY;
//   - keep the actor fixed by the host (api.runtime.agent) regardless
//     of any value supplied in input;
//   - require explicit CAS on task.update (changes+if_revision) and
//     note.add (id+text+if_revision);
//   - preserve POLICY_DENIED / POLICY_ERROR / POLICY_CONFLICT envelopes
//     after they round-trip the kernel's runPolicy catch;
//   - tag log entries with plugin_id from the host.
//
// The tests below are the bounded subset required by the acceptance.
// Fixture-based legacy shapes (the `{ node }` / `{ edge }` envelopes
// the V1 tests expect) are explicitly out of scope for this slice
// and live in the daughter fixture-migration task.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createTempProject,
  importFresh,
  rmTempProject,
  writeState,
  readState,
  installPolicyFixture,
  uninstallPolicyFixture,
} from "./helpers.mjs";

// ---- Module paths ---------------------------------------------------

const ADAPTER_MODULE = "../src/plugins/core-adapter.mjs";
const REGISTRY_MODULE = "../src/plugins/core-registry.mjs";

// 20 op IDs (ADR-012 §2 plus task submission lifecycle, without the
// removed task.resolve bypass). The adapter must accept every one of these
// before reaching for the kernel.
const EXPECTED_OPS = [
  // task lifecycle (9)
  "task.create",
  "task.update",
  "task.take",
  "task.release",
  "task.reopen",
  "task.cancel",
  "task.submit",
  "task.accept",
  "task.reject",
  // gate lifecycle (5)
  "gate.create",
  "gate.update",
  "gate.resolve",
  "gate.reopen",
  "gate.cancel",
  // knowledge (3)
  "knowledge.create",
  "knowledge.update",
  "knowledge.deprecate",
  // core utility (3)
  "edge.add",
  "note.add",
  "initiative.create",
];

// ---- Per-test environment for state-mutating cases ------------------

async function withIsolatedEnv(body) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-core-adapter-"));
  const prevHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = home;
  try {
    return await body();
  } finally {
    if (prevHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = prevHome;
    await fs.rm(home, { recursive: true, force: true });
  }
}

// freshApi — assembles a fresh createCore() bound to a brand-new temp
// project with v2 init + the canonical "plugin-platform" initiative so
// task.create / gate.create / knowledge.create have something to bind to.
async function freshCore(projectDir, { agent = "alice", pluginId = "example.audit" } = {}) {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
  await init({ statePath: projectDir, flags: { v2: true }, positional: [], projectDir });
  await addInit({
    statePath: projectDir,
    flags: { desc: "plugin platform" },
    positional: ["plugin-platform"],
  });
  const { createCore } = await importFresh(ADAPTER_MODULE);
  return createCore({ projectDir, agent, pluginId });
}

// =====================================================================
// 1. createCore — module shape (no state, no kernel)
// =====================================================================

test("plugin-core-adapter: createCore returns { version: 2, run } with run being async", async () => {
  const { createCore } = await importFresh(ADAPTER_MODULE);
  const core = createCore({ projectDir: "/tmp/whatever", agent: "alice", pluginId: "p.test" });
  assert.equal(core.version, 2);
  assert.equal(typeof core.run, "function");
});

test("plugin-core-adapter: routes execution through Application Operations", async () => {
  const source = await fs.readFile(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src/plugins/core-adapter.mjs"),
    "utf8",
  );
  assert.match(source, /from [\"']\.\.\/application\/operations\/index\.mjs[\"']/);
  assert.match(source, /executeOperation\(/);
  assert.doesNotMatch(source, /from [\"']\.\/core-registry\.mjs[\"']/);
  assert.doesNotMatch(source, /mutate\(\{/);
  assert.doesNotMatch(source, /REG\.lookup\(/);
});

test("plugin-core-adapter: createCore throws when projectDir is missing or empty", async () => {
  const { createCore } = await importFresh(ADAPTER_MODULE);
  assert.throws(
    () => createCore({ projectDir: "", agent: "alice", pluginId: "p.test" }),
    /projectDir required/,
  );
  assert.throws(
    () => createCore({ agent: "alice", pluginId: "p.test" }),
    /projectDir required/,
  );
});

test("plugin-core-adapter: createCore throws when pluginId is missing or empty", async () => {
  const { createCore } = await importFresh(ADAPTER_MODULE);
  assert.throws(
    () => createCore({ projectDir: "/tmp/whatever", agent: "alice", pluginId: "" }),
    /pluginId required/,
  );
  assert.throws(
    () => createCore({ projectDir: "/tmp/whatever", agent: "alice" }),
    /pluginId required/,
  );
});

// =====================================================================
// 2. registry — bootstrapBuiltins exposes the 21-op contract
// =====================================================================

test("plugin-core-adapter: bootstrapBuiltins exposes exactly the 21 op IDs published by ADR-012 §2", async () => {
  const { bootstrapBuiltins } = await importFresh(REGISTRY_MODULE);
  const reg = bootstrapBuiltins();
  assert.equal(reg.ops.length, EXPECTED_OPS.length, `expected ${EXPECTED_OPS.length} ops, got ${reg.ops.length}`);
  for (const op of EXPECTED_OPS) {
    assert.ok(reg.has(op), `registry must expose '${op}'`);
    const entry = reg.lookup(op);
    assert.ok(entry && entry.provider, `entry for '${op}' carries a provider`);
    assert.equal(typeof entry.provider.prepare, "function");
    assert.equal(typeof entry.provider.apply, "function");
  }
});

// =====================================================================
// 3. run — rejection BEFORE any kernel call (no state required)
// =====================================================================

test("plugin-core-adapter: run rejects non-string op with PLUGIN_CORE_INVALID_OPERATION and lists supported ops", async () => {
  const { createCore } = await importFresh(ADAPTER_MODULE);
  const core = createCore({ projectDir: "/tmp/no-state-needed", agent: "alice", pluginId: "p.test" });
  // NOTE: assert by `code` + `details`, NOT by `instanceof
  // PluginCoreInvalidOperation`. Each `importFresh(ERRORS_MODULE)` call
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
        err.details.supported.length === EXPECTED_OPS.length,
      `expected PLUGIN_CORE_INVALID_OPERATION for op=${JSON.stringify(bad)}`,
    );
  }
});

test("plugin-core-adapter: run rejects unknown op with the full supported list", async () => {
  const { createCore } = await importFresh(ADAPTER_MODULE);
  const core = createCore({ projectDir: "/tmp/no-state-needed", agent: "alice", pluginId: "p.test" });
  await assert.rejects(
    core.run({ op: "edge.unknown", input: {} }),
    (err) =>
      err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
      err.details.op === "edge.unknown" &&
      err.details.reason === "unknown operation" &&
      err.details.supported.includes("edge.add") &&
      err.details.supported.includes("note.add") &&
      err.details.supported.includes("task.update"),
  );
});

test("plugin-core-adapter: run rejects non-object input with PLUGIN_CORE_INVALID_OPERATION", async () => {
  const { createCore } = await importFresh(ADAPTER_MODULE);
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
  const { createCore } = await importFresh(ADAPTER_MODULE);
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
  const { createCore } = await importFresh(ADAPTER_MODULE);
  const core = createCore({ projectDir: "/tmp/no-state-needed", agent: "alice", pluginId: "p.test" });
  await assert.rejects(
    core.run({ op: "task.take", input: { id: "T1", _as: "bob" } }),
    (err) =>
      err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
      err.details.reason === "input.as is forbidden",
  );
});

// =====================================================================
// 4. run — accepts any of the 18 ops without rejection; rejects unknown
// =====================================================================

test("plugin-core-adapter: run rejects unknown op without mutating state (rejection happens before any lock)", async () => {
  await withIsolatedEnv(async () => {
    const dir = await createTempProject();
    try {
      const core = await freshCore(dir, { agent: "alice", pluginId: "p.test" });
      // Baseline log AFTER setup. freshCore() runs `init` + `add-initiative`
      // — both emit a log entry. The "no new entries after the rejected
      // call" contract must compare against the post-setup baseline,
      // not against an empty array. Without this, the assert would
      // double-count the add-initiative entry as a mutation from the
      // plugin path under test.
      const baseline = await readState(dir);
      const baselineLogLen = baseline.log.length;
      const baselineUserNodes = Object.keys(baseline.nodes).filter((id) => !id.startsWith("F"));
      await assert.rejects(
        core.run({ op: "task.unknown", input: {} }),
        (err) => err && err.code === "PLUGIN_CORE_INVALID_OPERATION",
      );
      const after = await readState(dir);
      // No user-shaped nodes created after the rejected call (the
      // baseline already carries whatever init/add-initiative planted).
      const userNodes = Object.keys(after.nodes).filter((id) => !id.startsWith("F"));
      assert.equal(
        userNodes.length,
        baselineUserNodes.length,
        "no new user-shaped nodes after rejection",
      );
      // The log MUST be byte-for-byte the same length and content as
      // the post-setup baseline. Any drift means the rejected call
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
      await rmTempProject(dir);
    }
  });
});

// =====================================================================
// 5. run — fixed actor + pluginId on the wire (end-to-end, real kernel)
// =====================================================================

test("plugin-core-adapter: task.create logs carry plugin_id and the actor matches api.runtime.agent", async () => {
  await withIsolatedEnv(async () => {
    const dir = await createTempProject();
    try {
      const core = await freshCore(dir, { agent: "alice", pluginId: "example.audit" });
      const out = await core.run({
        op: "task.create",
        input: {
          id: "T-pca-1",
          initiative: "plugin-platform",
          title: "pca task",
          body: "b",
          acceptance: "a",
          blocked_by: "",
        },
      });
      assert.ok(out && out.result, "kernel result returned");
      assert.equal(out.result.id, "T-pca-1");
      assert.ok(out.log_entry, "kernel produced a log entry");
      assert.equal(out.log_entry.plugin_id, "example.audit", "log entry tagged with plugin_id");
      assert.equal(out.log_entry.agent, "alice", "log entry agent is fixed by the host");
      const after = await readState(dir);
      const tagged = after.log.filter((e) => e.plugin_id === "example.audit");
      assert.ok(tagged.length >= 1, "at least one plugin-tagged log entry persisted");
      assert.equal(tagged[tagged.length - 1].agent, "alice");
    } finally {
      await rmTempProject(dir);
    }
  });
});

test("plugin-core-adapter: input.as is rejected even when the rest of the input would succeed", async () => {
  // Covered above as a pure-rejection case; here we lock the
  // "rejection happens before state mutation" guarantee: the temp
  // project remains empty of user nodes after the rejected call.
  await withIsolatedEnv(async () => {
    const dir = await createTempProject();
    try {
      const core = await freshCore(dir, { agent: "alice", pluginId: "example.audit" });
      await assert.rejects(
        core.run({
          op: "task.create",
          input: {
            id: "T-spoof",
            initiative: "plugin-platform",
            title: "spoof",
            body: "b",
            acceptance: "a",
            blocked_by: "",
            as: "mallory",
          },
        }),
        (err) =>
          err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
          err.details.reason === "input.as is forbidden",
      );
      const after = await readState(dir);
      assert.equal(after.nodes["T-spoof"], undefined, "spoofed node was not created");
    } finally {
      await rmTempProject(dir);
    }
  });
});

// =====================================================================
// 6. run — task.update with changes+if_revision (typed CAS)
// =====================================================================

test("plugin-core-adapter: task.update consumes { id, changes, if_revision } and bumps revision by exactly 1", async () => {
  await withIsolatedEnv(async () => {
    const dir = await createTempProject();
    try {
      const core = await freshCore(dir, { agent: "alice", pluginId: "example.audit" });
      // Seed
      await core.run({
        op: "task.create",
        input: {
          id: "T-upd",
          initiative: "plugin-platform",
          title: "before",
          body: "b",
          acceptance: "a",
          blocked_by: "",
        },
      });
      // Update with explicit CAS (changes+if_revision). The provider
      // enforces if_revision presence; the adapter just translates.
      const out = await core.run({
        op: "task.update",
        input: {
          id: "T-upd",
          if_revision: 1,
          changes: { title: "after" },
        },
      });
      assert.equal(out.diff.updated.length, 1);
      assert.equal(out.diff.updated[0].node.title, "after");
      assert.equal(out.diff.updated[0].node.revision, 2);
      const after = await readState(dir);
      assert.equal(after.nodes["T-upd"].title, "after");
      assert.equal(after.nodes["T-upd"].revision, 2);
    } finally {
      await rmTempProject(dir);
    }
  });
});

test("plugin-core-adapter: task.update without if_revision fails inside the provider (MISSING_FIELD) and does not mutate", async () => {
  await withIsolatedEnv(async () => {
    const dir = await createTempProject();
    try {
      const core = await freshCore(dir, { agent: "alice", pluginId: "example.audit" });
      await core.run({
        op: "task.create",
        input: {
          id: "T-upd-no-cas",
          initiative: "plugin-platform",
          title: "x",
          body: "b",
          acceptance: "a",
          blocked_by: "",
        },
      });
      await assert.rejects(
        core.run({
          op: "task.update",
          input: { id: "T-upd-no-cas", changes: { title: "after" } },
        }),
        // Provider-level MISSING_FIELD is wrapped by the adapter via
        // wrapCoreError → PLUGIN_CORE_ACTION_FAILED with the original
        // code preserved under details.cause.code (see
        // src/plugin-errors.mjs:normalizeCoreCause). The contract is
        // the wrapped envelope, NOT the bare MISSING_FIELD.
        (err) =>
          err &&
          err.code === "PLUGIN_CORE_ACTION_FAILED" &&
          err.details &&
          err.details.op === "task.update" &&
          err.details.cause &&
          err.details.cause.code === "MISSING_FIELD",
      );
      const after = await readState(dir);
      assert.equal(after.nodes["T-upd-no-cas"].title, "x", "title unchanged");
      assert.equal(after.nodes["T-upd-no-cas"].revision, 1, "revision unchanged");
    } finally {
      await rmTempProject(dir);
    }
  });
});

// =====================================================================
// 7. run — note.add with explicit CAS (id+text+if_revision)
// =====================================================================

test("plugin-core-adapter: note.add consumes { id, text, if_revision } and appends exactly one note", async () => {
  await withIsolatedEnv(async () => {
    const dir = await createTempProject();
    try {
      const core = await freshCore(dir, { agent: "alice", pluginId: "example.audit" });
      await core.run({
        op: "task.create",
        input: {
          id: "T-note",
          initiative: "plugin-platform",
          title: "note target",
          body: "b",
          acceptance: "a",
          blocked_by: "",
        },
      });
      const out = await core.run({
        op: "note.add",
        input: { id: "T-note", text: "first CAS note", if_revision: 1 },
      });
      assert.equal(out.result.notes_count, 1);
      const after = await readState(dir);
      const note = after.nodes["T-note"].notes.find((n) => n.text === "first CAS note");
      assert.ok(note, "note persisted");
      assert.equal(note.agent, "alice", "note agent is host-fixed");
      assert.equal(after.nodes["T-note"].revision, 2, "node revision bumped");
    } finally {
      await rmTempProject(dir);
    }
  });
});

test("plugin-core-adapter: note.add without if_revision fails with MISSING_FIELD before mutating", async () => {
  await withIsolatedEnv(async () => {
    const dir = await createTempProject();
    try {
      const core = await freshCore(dir, { agent: "alice", pluginId: "example.audit" });
      await core.run({
        op: "task.create",
        input: {
          id: "T-note-no-cas",
          initiative: "plugin-platform",
          title: "x",
          body: "b",
          acceptance: "a",
          blocked_by: "",
        },
      });
      await assert.rejects(
        core.run({
          op: "note.add",
          input: { id: "T-note-no-cas", text: "no CAS" },
        }),
        // Provider-level MISSING_FIELD is wrapped via PLUGIN_CORE_ACTION_FAILED;
        // see the matching task.update assertion above for the rationale.
        (err) =>
          err &&
          err.code === "PLUGIN_CORE_ACTION_FAILED" &&
          err.details &&
          err.details.op === "note.add" &&
          err.details.cause &&
          err.details.cause.code === "MISSING_FIELD",
      );
      const after = await readState(dir);
      assert.deepEqual(after.nodes["T-note-no-cas"].notes || [], []);
    } finally {
      await rmTempProject(dir);
    }
  });
});

// =====================================================================
// 8. policy — selection outside lock, decision inside, errors preserved
// =====================================================================

test("plugin-core-adapter: with no policy installed, run completes successfully (default abstain)", async () => {
  await withIsolatedEnv(async () => {
    const dir = await createTempProject();
    try {
      const core = await freshCore(dir, { agent: "alice", pluginId: "example.audit" });
      const out = await core.run({
        op: "task.create",
        input: {
          id: "T-no-policy",
          initiative: "plugin-platform",
          title: "x",
          body: "b",
          acceptance: "a",
          blocked_by: "",
        },
      });
      assert.ok(out && out.diff.created.length === 1);
    } finally {
      await rmTempProject(dir);
    }
  });
});

test("plugin-core-adapter: POLICY_DENIED from the selected policy surfaces with structured details", async () => {
  await withIsolatedEnv(async () => {
    const dir = await createTempProject();
    try {
      const core = await freshCore(dir, { agent: "alice", pluginId: "example.audit" });
      const reason = "no task.creates allowed in tests";
      await installPolicyFixture(dir, {
        appliesMode: "true",
        authorizeMode: "deny",
        reason: JSON.stringify(reason),
        pluginId: "policy.test",
      });
      try {
        await assert.rejects(
          core.run({
            op: "task.create",
            input: {
              id: "T-deny",
              initiative: "plugin-platform",
              title: "x",
              body: "b",
              acceptance: "a",
              blocked_by: "",
            },
          }),
          (err) =>
            err &&
            err.code === "POLICY_DENIED" &&
            err.details &&
            typeof err.details.reason === "string" &&
            err.details.reason.includes("no task.creates") &&
            err.details.action === "task.create" &&
            err.details.plugin_id === "policy.test",
        );
        const after = await readState(dir);
        assert.equal(after.nodes["T-deny"], undefined, "denied mutation did not touch state");
      } finally {
        await uninstallPolicyFixture(dir, { pluginId: "policy.test" });
      }
    } finally {
      await rmTempProject(dir);
    }
  });
});

test("plugin-core-adapter: applies() throwing inside the selected policy surfaces as POLICY_ERROR", async () => {
  await withIsolatedEnv(async () => {
    const dir = await createTempProject();
    try {
      const core = await freshCore(dir, { agent: "alice", pluginId: "example.audit" });
      await installPolicyFixture(dir, {
        appliesMode: "throw",
        pluginId: "policy.test",
      });
      try {
        await assert.rejects(
          core.run({
            op: "task.create",
            input: {
              id: "T-policy-err",
              initiative: "plugin-platform",
              title: "x",
              body: "b",
              acceptance: "a",
              blocked_by: "",
            },
          }),
          (err) =>
            err &&
            err.code === "POLICY_ERROR" &&
            err.details &&
            err.details.action === "task.create",
        );
      } finally {
        await uninstallPolicyFixture(dir, { pluginId: "policy.test" });
      }
    } finally {
      await rmTempProject(dir);
    }
  });
});
