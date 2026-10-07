import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { importFresh } from "./helpers.ts";
import { policyFixture, withEnv, writePlugin } from "./plugin-policy-foundation-helpers.ts";

const LOADER_MODULE = "../src/plugins/loader.ts";
const POLICY_MODULE = "../src/plugins/policy.ts";

test("policy-foundation: readProjectConfig returns {} when .climier.json is missing", async () => {
  await withEnv(async (env) => {
    const { readProjectConfig } = await importFresh(LOADER_MODULE);
    const cfg = await readProjectConfig(env.projectDir);
    assert.deepEqual(cfg, {});
    assert.ok(Object.isFrozen(cfg), "missing-config object must be frozen");
  });
});

test("policy-foundation: readProjectConfig reads .climier.json raw and freezes the result", async () => {
  await withEnv(async (env) => {
    // Seed .climier.json with arbitrary keys (plugins.<id> lives here).
    await fs.writeFile(
      path.join(env.projectDir, ".climier.json"),
      JSON.stringify({
        version: 1,
        project_id: "demo",
        plugins: { "team-policy": { mode: "strict" } },
      }) + "\n",
      "utf8",
    );
    const { readProjectConfig } = await importFresh(LOADER_MODULE);
    const cfg = await readProjectConfig(env.projectDir);
    assert.equal(cfg.version, 1);
    assert.equal(cfg.project_id, "demo");
    assert.deepEqual(cfg.plugins["team-policy"], { mode: "strict" });
    assert.ok(Object.isFrozen(cfg), "config object must be frozen");
    assert.ok(
      Object.isFrozen(cfg.plugins),
      "plugins sub-object must be frozen (deep freeze)",
    );
    assert.ok(
      Object.isFrozen(cfg.plugins["team-policy"]),
      "plugins.<id> sub-object must be frozen (deep freeze)",
    );
  });
});

test("policy-foundation: loadApplicablePolicy returns the only policy plugin when applies() is absent", async () => {
  await withEnv(async (env) => {
    await writePlugin(env.home, {
      id: "only",
      command: "only",
      entryCode:
        "export default { commands: {}, policy: { authorize: () => ({ decision: \"allow\" }) } };\n",
    });
    const { loadApplicablePolicy } = await importFresh(POLICY_MODULE);
    const selected = await loadApplicablePolicy({ projectDir: env.projectDir });
    assert.ok(selected);
    assert.equal(selected.pluginId, "only");
    assert.equal(selected.namespace, "only");
    assert.equal(typeof selected.policy.authorize, "function");
  });
});

test("policy-foundation: loadApplicablePolicy returns null when applies() returns false", async () => {
  await withEnv(async (env) => {
    await writePlugin(env.home, {
      id: "skip",
      command: "skip",
      entryCode: policyFixture({ appliesMode: "false", authorizeMode: "allow" }),
    });
    const { loadApplicablePolicy } = await importFresh(POLICY_MODULE);
    const selected = await loadApplicablePolicy({ projectDir: env.projectDir });
    assert.equal(selected, null);
  });
});

test("policy-foundation: loadApplicablePolicy returns null when no plugins installed", async () => {
  await withEnv(async (env) => {
    const { loadApplicablePolicy } = await importFresh(POLICY_MODULE);
    const selected = await loadApplicablePolicy({ projectDir: env.projectDir });
    assert.equal(selected, null);
  });
});

test("policy-foundation: loadApplicablePolicy throws POLICY_CONFLICT when >1 policy is applicable", async () => {
  await withEnv(async (env) => {
    await writePlugin(env.home, {
      id: "alpha",
      command: "alpha",
      entryCode: policyFixture({ appliesMode: "true", authorizeMode: "allow" }),
    });
    await writePlugin(env.home, {
      id: "beta",
      command: "beta",
      entryCode: policyFixture({ appliesMode: "true", authorizeMode: "allow" }),
    });
    const { loadApplicablePolicy } = await importFresh(POLICY_MODULE);
    let caught;
    try {
      await loadApplicablePolicy({ projectDir: env.projectDir });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "expected POLICY_CONFLICT");
    assert.equal(caught.code, "POLICY_CONFLICT");
    assert.deepEqual(
      new Set(caught.details.plugin_ids),
      new Set(["alpha", "beta"]),
    );
    assert.deepEqual(
      new Set(caught.details.namespaces),
      new Set(["alpha", "beta"]),
    );
  });
});

test("policy-foundation: loadApplicablePolicy wraps applies() throws as POLICY_ERROR (plugin contract violation)", async () => {
  await withEnv(async (env) => {
    await writePlugin(env.home, {
      id: "boom",
      command: "boom",
      entryCode: policyFixture({ appliesMode: "throw", authorizeMode: "allow" }),
    });
    const { loadApplicablePolicy } = await importFresh(POLICY_MODULE);
    let caught;
    try {
      await loadApplicablePolicy({ projectDir: env.projectDir });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "expected POLICY_ERROR");

    // POLICY_ERROR covers any exception or invalid response from
    // `applies` (or `authorize`); POLICY_CONFLICT is reserved for
    // two or more applicable policies. The plugin's `applies` raised
    // here, so the envelope must surface POLICY_ERROR — NOT
    // POLICY_CONFLICT — with the plugin id, the `"applies"` operation
    // name, and the original cause preserved under `cause_message`.
    assert.equal(caught.code, "POLICY_ERROR");
    assert.notEqual(caught.code, "POLICY_CONFLICT");
    assert.equal(caught.details.plugin_id, "boom");
    assert.equal(caught.details.op, "applies");
    assert.equal(caught.details.action, "applies");
    assert.equal(caught.details.cause_message, "applies boom");
  });
});

test("policy-foundation: loadApplicablePolicy freezes the projectConfig passed to applies()", async () => {
  await withEnv(async (env) => {
    // Seed .climier.json so applies() can be inspected against a real
    // config object.
    await fs.writeFile(
      path.join(env.projectDir, ".climier.json"),
      JSON.stringify({ version: 1, plugins: { "team-policy": { mode: "strict" } } }) + "\n",
      "utf8",
    );
    // Captures the cfg argument received by applies().
    await writePlugin(env.home, {
      id: "team-policy",
      command: "team-policy",
      entryCode:
        "export default {\n" +
        "  commands: {},\n" +
        "  policy: {\n" +
        "    applies: (cfg) => { globalThis.climierPolicyCaptured = cfg; return false; },\n" +
        "    authorize: () => ({ decision: \"allow\" }),\n" +
        "  },\n" +
        "};\n",
    });
    const { loadApplicablePolicy } = await importFresh(POLICY_MODULE);
    const selected = await loadApplicablePolicy({ projectDir: env.projectDir });
    assert.equal(selected, null);
    const captured = globalThis.climierPolicyCaptured;
    assert.ok(captured, "applies() should have captured cfg");
    assert.ok(Object.isFrozen(captured), "cfg passed to applies must be frozen");
    assert.deepEqual(captured.plugins, { "team-policy": { mode: "strict" } });
    delete globalThis.climierPolicyCaptured;
  });
});

test("policy-foundation: loadApplicablePolicy is not cached between calls (re-reads config + plugins)", async () => {
  await withEnv(async (env) => {
    // First: no policy installed.
    let selected = await (await importFresh(POLICY_MODULE)).loadApplicablePolicy({
      projectDir: env.projectDir,
    });
    assert.equal(selected, null);

    // Then: install a policy plugin and re-select. No cache should be in
    // play; the second call must observe the new install.
    await writePlugin(env.home, {
      id: "team-policy",
      command: "team-policy",
      entryCode:
        "export default { commands: {}, policy: { authorize: () => ({ decision: \"allow\" }) } };\n",
    });
    selected = await (await importFresh(POLICY_MODULE)).loadApplicablePolicy({
      projectDir: env.projectDir,
    });
    assert.ok(selected, "second call must observe newly installed plugin");
    assert.equal(selected.pluginId, "team-policy");
  });
});
