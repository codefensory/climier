import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importFresh } from "./helpers.ts";
import { commandOnlyFixture, policyFailureForField, policyFixture, withEnv, writePlugin } from "./plugin-policy-foundation-helpers.mjs";

const DESCRIPTOR_MODULE = "../src/plugins/descriptor.ts";
const LOADER_MODULE = "../src/plugins/loader.ts";

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
        importEntry(path.join(dir, "entry.mjs")),
        policyFailureForField("policy"),
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
        importEntry(path.join(dir, "entry.mjs")),
        policyFailureForField("policy.authorize"),
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
        importEntry(path.join(dir, "entry.mjs")),
        policyFailureForField("policy.authorize"),
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
        importEntry(path.join(dir, "entry.mjs")),
        policyFailureForField("policy.applies"),
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
        importEntry(path.join(dir, "entry.mjs")),
        policyFailureForField("policy"),
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
        importEntry(path.join(dir, "entry.mjs")),
        policyFailureForField("policy.authorize"),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

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
