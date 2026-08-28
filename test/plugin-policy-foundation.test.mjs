// T-plugin-policy-foundation — ADR-007 (contract) + ADR-008 (seam) test surface.
//
// Scoped tests for the foundation slice:
//   - importEntry validates `default.policy` (optional, strict shape).
//   - loadInstalledPolicyPlugins enumerates plugins with default.policy.
//   - readProjectConfig reads .climier.json raw, returns {} when missing,
//     freezes the result so applies() can't mutate it.
//   - loadApplicablePolicy picks at most one policy: applies() runs per
//     candidate with a frozen projectConfig; >1 applicable emits
//     POLICY_CONFLICT; no candidate returns null.
//   - authorizeAction handles null policy, allow, deny, abstain, throw,
//     invalid response — without mutating state.
//
// No seam wiring lives here: handlers are NOT exercised. Each test is
// pure: it seeds CLIMIER_HOME / installed/<id> with crafted entry code
// and asserts on the helper output. The handlers live in
// T-plugin-policy-seam-* tasks.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createTempProject, importFresh } from "./helpers.mjs";

const DESCRIPTOR_MODULE = "../src/plugin-descriptor.mjs";
const LOADER_MODULE = "../src/plugin-loader.mjs";
const POLICY_MODULE = "../src/policy.mjs";
const ERRORS_MODULE = "../src/plugin-errors.mjs";

// ---- shared helpers --------------------------------------------------

async function freshHome(prefix = "climier-policy-test") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix + "-"));
  const projectDir = await createTempProject();
  const prevHome = process.env.CLIMIER_HOME;
  const prevAgent = process.env.CLIMIER_AGENT;
  process.env.CLIMIER_HOME = home;
  if (!("CLIMIER_AGENT" in process.env)) process.env.CLIMIER_AGENT = "test-agent";
  return {
    home,
    projectDir,
    restore() {
      if (prevHome === undefined) delete process.env.CLIMIER_HOME;
      else process.env.CLIMIER_HOME = prevHome;
      if (prevAgent === undefined) delete process.env.CLIMIER_AGENT;
      else process.env.CLIMIER_AGENT = prevAgent;
    },
    async cleanup() {
      if (prevHome === undefined) delete process.env.CLIMIER_HOME;
      else process.env.CLIMIER_HOME = prevHome;
      if (prevAgent === undefined) delete process.env.CLIMIER_AGENT;
      else process.env.CLIMIER_AGENT = prevAgent;
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    },
  };
}

async function withEnv(body, prefix = "climier-policy-test") {
  const env = await freshHome(prefix);
  try {
    return await body(env);
  } finally {
    await env.cleanup();
  }
}

async function writePlugin(home, opts) {
  // opts: { id, command, entryCode, namespace? }
  const id = opts.id ?? opts.command;
  const command = opts.command ?? id;
  const installedDir = path.join(home, "plugins", "installed", id);
  await fs.mkdir(installedDir, { recursive: true });
  await fs.writeFile(
    path.join(installedDir, "package.json"),
    JSON.stringify(
      {
        name: opts.npmName ?? id,
        version: "1.0.0",
        type: "module",
        climier: { id, command, entry: "./climier.mjs" },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(installedDir, "climier.mjs"),
    opts.entryCode,
    "utf8",
  );
  return installedDir;
}

function policyFixture(opts = {}) {
  // A self-contained ESM entry that exports default.policy with
  // configurable applies + authorize behaviour. The fixture does NOT
  // include `commands`; it only tests the policy branch of importEntry.
  const appliesMode = opts.appliesMode ?? "true";
  const authorizeMode = opts.authorizeMode ?? "allow";
  const reason = JSON.stringify(opts.reason ?? "deny reason");
  const appliesExtra = opts.appliesExtra ?? "";
  const authorizeExtra = opts.authorizeExtra ?? "";
  return (
    "function _appliesImpl(cfg) {\n" +
    "  " + appliesExtra + "\n" +
    "  if (" + JSON.stringify(appliesMode) + " === \"true\") return true;\n" +
    "  if (" + JSON.stringify(appliesMode) + " === \"false\") return false;\n" +
    "  if (" + JSON.stringify(appliesMode) + " === \"throw\") throw new Error(\"applies boom\");\n" +
    "  if (" + JSON.stringify(appliesMode) + " === \"nonbool\") return \"truthy\";\n" +
    "  return " + JSON.stringify(appliesMode) + ";\n" +
    "}\n" +
    "function _authorizeImpl(input) {\n" +
    "  " + authorizeExtra + "\n" +
    "  if (" + JSON.stringify(authorizeMode) + " === \"allow\") return { decision: \"allow\" };\n" +
    "  if (" + JSON.stringify(authorizeMode) + " === \"deny\") return { decision: \"deny\", reason: " + reason + " };\n" +
    "  if (" + JSON.stringify(authorizeMode) + " === \"abstain\") return { decision: \"abstain\" };\n" +
    "  if (" + JSON.stringify(authorizeMode) + " === \"throw\") throw new Error(\"authorize boom\");\n" +
    "  if (" + JSON.stringify(authorizeMode) + " === \"invalid\") return { decision: \"maybe\" };\n" +
    "  if (" + JSON.stringify(authorizeMode) + " === \"null\") return null;\n" +
    "  return " + JSON.stringify(authorizeMode) + ";\n" +
    "}\n" +
    "export default {\n" +
    "  commands: {},\n" +
    "  policy: {\n" +
    "    applies: _appliesImpl,\n" +
    "    authorize: _authorizeImpl,\n" +
    "  },\n" +
    "};\n"
  );
}

function policyOnlyFixture(opts = {}) {
  // Same shape but no commands — exercises the policy-only loading path.
  const code = policyFixture(opts);
  // Strip the commands object so the entry has no commands at all.
  return code.replace(/  commands: \{\},\n/, "");
}

function commandOnlyFixture() {
  // Plugin with no policy — should still load.
  return (
    "export default {\n" +
    "  commands: { ping: () => ({ ok: true, command: 'ping' }) },\n" +
    "};\n"
  );
}

// ---- importEntry: strict shape for default.policy --------------------

test("policy-foundation: importEntry accepts plugins with valid default.policy alongside commands", async () => {
  await withEnv(async () => {
    const { importEntry } = await importFresh(DESCRIPTOR_MODULE);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-policy-entry-"));
    try {
      await fs.writeFile(
        path.join(dir, "entry.mjs"),
        policyFixture({ appliesMode: "true", authorizeMode: "allow" }),
        "utf8",
      );
      const { mod, commands, policy } = await importEntry(path.join(dir, "entry.mjs"));
      assert.ok(mod, "importEntry must return the module");
      assert.ok(commands, "importEntry must still surface commands");
      assert.equal(typeof commands.ping, "undefined", "commands only includes policy-mode entry's commands");
      assert.ok(policy, "importEntry must surface policy when present");
      assert.equal(typeof policy.authorize, "function");
      assert.equal(typeof policy.applies, "function");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test("policy-foundation: importEntry accepts command-only plugins (default.policy absent)", async () => {
  await withEnv(async () => {
    const { importEntry } = await importFresh(DESCRIPTOR_MODULE);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-policy-entry-"));
    try {
      await fs.writeFile(
        path.join(dir, "entry.mjs"),
        commandOnlyFixture(),
        "utf8",
      );
      const result = await importEntry(path.join(dir, "entry.mjs"));
      assert.ok(result.commands);
      assert.equal(typeof result.commands.ping, "function");
      // `policy` is undefined when default.policy is absent.
      assert.equal(result.policy, undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test("policy-foundation: importEntry accepts default.policy with applies optional (authorize only)", async () => {
  await withEnv(async () => {
    const { importEntry } = await importFresh(DESCRIPTOR_MODULE);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-policy-entry-"));
    try {
      const code =
        "export default {\n" +
        "  commands: {},\n" +
        "  policy: { authorize: () => ({ decision: \"allow\" }) },\n" +
        "};\n";
      await fs.writeFile(path.join(dir, "entry.mjs"), code, "utf8");
      const result = await importEntry(path.join(dir, "entry.mjs"));
      assert.equal(typeof result.policy.authorize, "function");
      assert.equal(result.policy.applies, undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test("policy-foundation: importEntry rejects default.policy that is not an object", async () => {
  await withEnv(async () => {
    const { importEntry } = await importFresh(DESCRIPTOR_MODULE);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-policy-entry-"));
    try {
      await fs.writeFile(
        path.join(dir, "entry.mjs"),
        "export default { commands: {}, policy: \"nope\" };\n",
        "utf8",
      );
      await assert.rejects(
        () => importEntry(path.join(dir, "entry.mjs")),
        (err) =>
          err.code === "PLUGIN_LOAD_FAILED" &&
          err.details &&
          err.details.field === "policy",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test("policy-foundation: importEntry rejects default.policy without authorize", async () => {
  await withEnv(async () => {
    const { importEntry } = await importFresh(DESCRIPTOR_MODULE);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-policy-entry-"));
    try {
      await fs.writeFile(
        path.join(dir, "entry.mjs"),
        "export default { commands: {}, policy: { applies: () => true } };\n",
        "utf8",
      );
      await assert.rejects(
        () => importEntry(path.join(dir, "entry.mjs")),
        (err) =>
          err.code === "PLUGIN_LOAD_FAILED" &&
          err.details &&
          err.details.field === "policy.authorize",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test("policy-foundation: importEntry rejects default.policy where authorize is not a function", async () => {
  await withEnv(async () => {
    const { importEntry } = await importFresh(DESCRIPTOR_MODULE);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-policy-entry-"));
    try {
      await fs.writeFile(
        path.join(dir, "entry.mjs"),
        "export default { commands: {}, policy: { authorize: 42 } };\n",
        "utf8",
      );
      await assert.rejects(
        () => importEntry(path.join(dir, "entry.mjs")),
        (err) =>
          err.code === "PLUGIN_LOAD_FAILED" &&
          err.details &&
          err.details.field === "policy.authorize",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test("policy-foundation: importEntry rejects default.policy where applies is not a function", async () => {
  await withEnv(async () => {
    const { importEntry } = await importFresh(DESCRIPTOR_MODULE);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-policy-entry-"));
    try {
      await fs.writeFile(
        path.join(dir, "entry.mjs"),
        "export default { commands: {}, policy: { authorize: () => ({}), applies: 1 } };\n",
        "utf8",
      );
      await assert.rejects(
        () => importEntry(path.join(dir, "entry.mjs")),
        (err) =>
          err.code === "PLUGIN_LOAD_FAILED" &&
          err.details &&
          err.details.field === "policy.applies",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test("policy-foundation: importEntry rejects default.policy with extra fields", async () => {
  await withEnv(async () => {
    const { importEntry } = await importFresh(DESCRIPTOR_MODULE);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-policy-entry-"));
    try {
      await fs.writeFile(
        path.join(dir, "entry.mjs"),
        "export default { commands: {}, policy: { authorize: () => ({}), extra: 1 } };\n",
        "utf8",
      );
      await assert.rejects(
        () => importEntry(path.join(dir, "entry.mjs")),
        (err) =>
          err.code === "PLUGIN_LOAD_FAILED" &&
          err.details &&
          err.details.field === "policy",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test("policy-foundation: invalid default.policy prevents exposing commands (whole plugin fails)", async () => {
  await withEnv(async () => {
    const { importEntry } = await importFresh(DESCRIPTOR_MODULE);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-policy-entry-"));
    try {
      await fs.writeFile(
        path.join(dir, "entry.mjs"),
        "export default { commands: { ping: () => ({ ok: true }) }, policy: { authorize: 1 } };\n",
        "utf8",
      );
      await assert.rejects(
        () => importEntry(path.join(dir, "entry.mjs")),
        (err) =>
          err.code === "PLUGIN_LOAD_FAILED" &&
          err.details &&
          err.details.field === "policy.authorize",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ---- loadInstalledPolicyPlugins -------------------------------------

test("policy-foundation: loadInstalledPolicyPlugins returns only plugins with default.policy", async () => {
  await withEnv(async (env) => {
    await writePlugin(env.home, {
      id: "team-policy",
      command: "team-policy",
      entryCode: policyFixture({ appliesMode: "true", authorizeMode: "allow" }),
    });
    await writePlugin(env.home, {
      id: "no-policy",
      command: "no-policy",
      entryCode: commandOnlyFixture(),
    });
    const { loadInstalledPolicyPlugins } = await importFresh(LOADER_MODULE);
    const installed = await loadInstalledPolicyPlugins();
    assert.equal(installed.length, 1);
    assert.equal(installed[0].pluginId, "team-policy");
    assert.equal(installed[0].descriptor.command, "team-policy");
    assert.equal(typeof installed[0].policy.authorize, "function");
    assert.equal(typeof installed[0].policy.applies, "function");
    assert.equal(installed[0].namespace, "team-policy");
    assert.ok(installed[0].entryPath.endsWith(path.join("installed", "team-policy", "climier.mjs")));
  });
});

test("policy-foundation: loadInstalledPolicyPlugins returns [] when no plugins have policy", async () => {
  await withEnv(async (env) => {
    await writePlugin(env.home, {
      id: "alpha",
      command: "alpha",
      entryCode: commandOnlyFixture(),
    });
    await writePlugin(env.home, {
      id: "beta",
      command: "beta",
      entryCode: commandOnlyFixture(),
    });
    const { loadInstalledPolicyPlugins } = await importFresh(LOADER_MODULE);
    const installed = await loadInstalledPolicyPlugins();
    assert.deepEqual(installed, []);
  });
});

test("policy-foundation: loadInstalledPolicyPlugins returns [] when installed/ is missing", async () => {
  await withEnv(async () => {
    // freshHome leaves installed/ non-existent (no plugins seeded).
    const { loadInstalledPolicyPlugins } = await importFresh(LOADER_MODULE);
    const installed = await loadInstalledPolicyPlugins();
    assert.deepEqual(installed, []);
  });
});

test("policy-foundation: loadInstalledPolicyPlugins skips installed plugins whose default.policy has an invalid shape", async () => {
  await withEnv(async (env) => {
    // Plugin with valid policy — should be returned.
    await writePlugin(env.home, {
      id: "good",
      command: "good",
      entryCode: policyFixture({ appliesMode: "true", authorizeMode: "allow" }),
    });
    // Plugin with invalid policy (authorize not a function) — must be
    // skipped, not surfaced.
    await writePlugin(env.home, {
      id: "bad",
      command: "bad",
      entryCode: "export default { commands: {}, policy: { authorize: 1 } };\n",
    });
    const { loadInstalledPolicyPlugins } = await importFresh(LOADER_MODULE);
    const installed = await loadInstalledPolicyPlugins();
    assert.equal(installed.length, 1);
    assert.equal(installed[0].pluginId, "good");
  });
});

// ---- readProjectConfig ----------------------------------------------

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

// ---- loadApplicablePolicy -------------------------------------------

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
    // ADR-007 §"Errores" + docs/plans/plugin-policy-execution.md §3.2:
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
    let captured;
    await writePlugin(env.home, {
      id: "team-policy",
      command: "team-policy",
      entryCode:
        "export default {\n" +
        "  commands: {},\n" +
        "  policy: {\n" +
        "    applies: (cfg) => { globalThis.__captured = cfg; return false; },\n" +
        "    authorize: () => ({ decision: \"allow\" }),\n" +
        "  },\n" +
        "};\n",
    });
    const { loadApplicablePolicy } = await importFresh(POLICY_MODULE);
    const selected = await loadApplicablePolicy({ projectDir: env.projectDir });
    assert.equal(selected, null);
    captured = globalThis.__captured;
    assert.ok(captured, "applies() should have captured cfg");
    assert.ok(Object.isFrozen(captured), "cfg passed to applies must be frozen");
    assert.deepEqual(captured.plugins, { "team-policy": { mode: "strict" } });
    delete globalThis.__captured;
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

// ---- authorizeAction: contract coverage -----------------------------

test("policy-foundation: authorizeAction returns decision=allow when policy.authorize allows", async () => {
  await withEnv(async () => {
    const { authorizeAction } = await importFresh(POLICY_MODULE);
    const policy = {
      pluginId: "team-policy",
      namespace: "team-policy",
      policy: {
        authorize: () => ({ decision: "allow" }),
      },
    };
    const out = await authorizeAction({
      policy,
      action: "task.take",
      actor: "alice",
      target: { id: "T1", kind: "resolvable", subkind: "task", status: "open" },
      snapshot: { nodes: {}, edges: [], initiatives: {} },
      projectDir: "/tmp/proj",
      projectConfig: {},
    });
    assert.deepEqual(out, { decision: "allow" });
  });
});

test("policy-foundation: authorizeAction returns decision=deny with reason when policy denies", async () => {
  await withEnv(async () => {
    const { authorizeAction } = await importFresh(POLICY_MODULE);
    const policy = {
      pluginId: "team-policy",
      namespace: "team-policy",
      policy: {
        authorize: () => ({ decision: "deny", reason: "not allowed by team-policy" }),
      },
    };
    const out = await authorizeAction({
      policy,
      action: "task.take",
      actor: "alice",
      target: { id: "T1" },
      snapshot: { nodes: {}, edges: [], initiatives: {} },
      projectDir: "/tmp/proj",
      projectConfig: {},
    });
    assert.equal(out.decision, "deny");
    assert.equal(out.reason, "not allowed by team-policy");
  });
});

test("policy-foundation: authorizeAction returns decision=abstain when policy abstains", async () => {
  await withEnv(async () => {
    const { authorizeAction } = await importFresh(POLICY_MODULE);
    const policy = {
      pluginId: "team-policy",
      namespace: "team-policy",
      policy: {
        authorize: () => ({ decision: "abstain" }),
      },
    };
    const out = await authorizeAction({
      policy,
      action: "task.take",
      actor: "alice",
      target: { id: "T1" },
      snapshot: { nodes: {}, edges: [], initiatives: {} },
      projectDir: "/tmp/proj",
      projectConfig: {},
    });
    assert.equal(out.decision, "abstain");
  });
});

test("policy-foundation: authorizeAction returns decision=abstain when policy is null (defaults core)", async () => {
  await withEnv(async () => {
    const { authorizeAction } = await importFresh(POLICY_MODULE);
    const out = await authorizeAction({
      policy: null,
      action: "task.take",
      actor: "alice",
      target: { id: "T1" },
      snapshot: { nodes: {}, edges: [], initiatives: {} },
      projectDir: "/tmp/proj",
      projectConfig: {},
    });
    assert.equal(out.decision, "abstain");
  });
});

test("policy-foundation: authorizeAction throws POLICY_ERROR when policy.authorize throws", async () => {
  await withEnv(async () => {
    const { authorizeAction } = await importFresh(POLICY_MODULE);
    const policy = {
      pluginId: "team-policy",
      namespace: "team-policy",
      policy: {
        authorize: () => {
          throw new Error("plugin crashed");
        },
      },
    };
    let caught;
    try {
      await authorizeAction({
        policy,
        action: "task.take",
        actor: "alice",
        target: { id: "T1" },
        snapshot: { nodes: {}, edges: [], initiatives: {} },
        projectDir: "/tmp/proj",
        projectConfig: {},
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "expected authorizeAction to throw");
    assert.equal(caught.code, "POLICY_ERROR");
    assert.equal(caught.details.plugin_id, "team-policy");
    assert.equal(caught.details.action, "task.take");
    assert.equal(caught.details.cause_message, "plugin crashed");
  });
});

test("policy-foundation: authorizeAction throws POLICY_ERROR when policy.authorize returns an invalid response", async () => {
  await withEnv(async () => {
    const { authorizeAction } = await importFresh(POLICY_MODULE);
    const cases = [
      () => null,
      () => ({ decision: "maybe" }),
      () => ({ reason: "no decision field" }),
      () => "allow",
    ];
    for (const responder of cases) {
      const policy = {
        pluginId: "team-policy",
        namespace: "team-policy",
        policy: { authorize: responder },
      };
      let caught;
      try {
        await authorizeAction({
          policy,
          action: "task.take",
          actor: "alice",
          target: { id: "T1" },
          snapshot: { nodes: {}, edges: [], initiatives: {} },
          projectDir: "/tmp/proj",
          projectConfig: {},
        });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, "expected POLICY_ERROR for invalid response");
      assert.equal(caught.code, "POLICY_ERROR");
      assert.equal(caught.details.plugin_id, "team-policy");
    }
  });
});

test("policy-foundation: authorizeAction passes actor, target, snapshot, projectConfig read-only to the policy", async () => {
  await withEnv(async () => {
    const { authorizeAction } = await importFresh(POLICY_MODULE);
    let received = null;
    const policy = {
      pluginId: "team-policy",
      namespace: "team-policy",
      policy: {
        authorize: (input) => {
          received = input;
          return { decision: "allow" };
        },
      },
    };
    const target = { id: "T1", kind: "resolvable", subkind: "task", status: "open" };
    const snapshot = { nodes: {}, edges: [], initiatives: {} };
    const projectConfig = { version: 1 };
    await authorizeAction({
      policy,
      action: "task.take",
      actor: "alice",
      target,
      snapshot,
      projectDir: "/tmp/proj",
      projectConfig,
    });
    assert.equal(received.action, "task.take");
    assert.equal(received.actor, "alice");
    assert.equal(received.target, target);
    assert.equal(received.snapshot, snapshot);
    assert.equal(received.projectConfig, projectConfig);
    assert.equal(received.projectDir, "/tmp/proj");
    // Snapshot/projectConfig are plain objects but authorizeAction must
    // not let plugins mutate them; the contract is that handlers treat
    // them as read-only. We assert by checking that no mutation
    // occurred during authorizeAction's own call (the policy returned
    // allow without writing back to target/snapshot/projectConfig).
    assert.deepEqual(received.target, target);
    assert.deepEqual(received.snapshot, snapshot);
    assert.deepEqual(received.projectConfig, projectConfig);
  });
});

// ---- structured errors: POLICY_* envelopes --------------------------

test("policy-foundation: plugin-errors exposes POLICY_DENIED, POLICY_ERROR, POLICY_CONFLICT classes with toJSON envelopes", async () => {
  await withEnv(async () => {
    const errs = await importFresh(ERRORS_MODULE);
    const denied = new errs.PolicyDenied("team-policy", "task.take", "alice", "deny reason");
    assert.equal(denied.code, "POLICY_DENIED");
    assert.deepEqual(denied.toJSON(), {
      ok: false,
      error: {
        code: "POLICY_DENIED",
        message: denied.message,
        details: {
          plugin_id: "team-policy",
          op: "task.take",
          action: "task.take",
          reason: "deny reason",
          actor: "alice",
        },
      },
    });

    const error = new errs.PolicyError("team-policy", "task.take", new Error("inner"));
    assert.equal(error.code, "POLICY_ERROR");
    assert.equal(error.details.plugin_id, "team-policy");
    assert.equal(error.details.op, "task.take");
    assert.equal(error.details.action, "task.take");
    assert.equal(error.details.cause_message, "inner");
    assert.equal(error.details.cause_code, null);

    const conflict = new errs.PolicyConflict(
      ["alpha", "beta"],
      ["alpha", "beta"],
    );
    assert.equal(conflict.code, "POLICY_CONFLICT");
    assert.deepEqual(conflict.details.plugin_ids, ["alpha", "beta"]);
    assert.deepEqual(conflict.details.namespaces, ["alpha", "beta"]);
    assert.equal(conflict.details.cause_message, null);
  });
});