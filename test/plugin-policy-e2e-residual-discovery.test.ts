// Policy fixture focused e2e tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { FIXTURE_ID, FIXTURE_COMMAND, withFreshEnv, cli, baseClimierJson, writeClimierJson, installPolicyFixture } from "./plugin-policy-e2e-residual-helpers.mjs";

test("e2e: install — fixture installs under CLIMIER_HOME and dispatches by command namespace", async () => {
  await withFreshEnv(async ({ home, projectDir }) => {
    const installedDir = path.join(home, "plugins", "installed", FIXTURE_ID);
    const installRes = await installPolicyFixture(projectDir);
    assert.equal(installRes.plugin.id, FIXTURE_ID);
    assert.equal(installRes.plugin.command, FIXTURE_COMMAND);
    assert.equal(installRes.plugin.entry, "./climier.mjs");
    assert.equal(installRes.plugin.installed_dir, installedDir);
    assert.ok((await fs.stat(installedDir)).isDirectory(), "installed/<id> exists");

    // bin's discovery scans installed/*/package.json for
    // descriptor.command === "policy" (no manifest).
    await baseClimierJson(projectDir);
    const out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "applies-check",
    ]);
    assert.equal(out.command, "applies-check");
    // Without a namespace config, applies returns true (default applicable).
    assert.equal(out.applies, true);
    assert.equal(out.namespace_present, false);
  });
});
test("e2e: applies — true when no namespace; true when applies=true; false when applies=false", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);

    // Case 1: no namespace at all.
    await baseClimierJson(projectDir);
    let out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "applies-check",
    ]);
    assert.equal(out.applies, true);
    assert.equal(out.namespace_present, false);
    assert.deepEqual(out.namespace_keys, null);

    // Case 2: namespace present, applies=true (explicit opt-in).
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { applies: true, mode: "allow" } },
    });
    out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "applies-check",
    ]);
    assert.equal(out.applies, true);
    assert.equal(out.namespace_present, true);
    assert.ok(out.namespace_keys.includes("applies"));
    assert.ok(out.namespace_keys.includes("mode"));

    // Case 3: namespace present, applies=false (explicit opt-out).
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { applies: false, mode: "allow" } },
    });
    out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "applies-check",
    ]);
    assert.equal(out.applies, false);
    assert.equal(out.namespace_present, true);
  });
});
test("e2e: applies — ignores other plugins' namespaces (own namespace only)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    // Other plugins' applies=false in their own namespaces must NOT
    // affect policy-fixture's applies decision. ADR-007 §"Discovery
    // global": "El plugin solo lee su propio namespace".
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: {
        "other-plugin": { applies: false },
        "policy-fixture": { mode: "allow" },
      },
    });
    const out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "applies-check",
    ]);
    assert.equal(out.applies, true);
    assert.equal(out.namespace_present, true);
    assert.ok(out.namespace_keys.includes("mode"));
    assert.ok(!out.namespace_keys.includes("applies"));
  });
});
test("e2e: applies — empty/malformed namespace falls back to true (defensive)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    // Non-boolean applies value (string) must not silently opt out —
    // the fixture does strict boolean coercion.
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { applies: "false" } },
    });
    const out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "applies-check",
    ]);
    assert.equal(out.applies, true);
  });
});
