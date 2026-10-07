// Policy fixture focused e2e tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { FIXTURE_ID, FIXTURE_COMMAND, withFreshEnv, cli, writeClimierJson, installPolicyFixture, uninstallPolicyFixture } from "./plugin-policy-e2e-residual-helpers.ts";

test("e2e: recorded — authorize persists last invocation for audit", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { mode: "allow" } },
    });
    // Trigger an authorize so the fixture writes its last invocation.
    await cli([
      "--project", projectDir,
      "--as", "audit-agent",
      FIXTURE_COMMAND, "authorize-check", "task.take",
    ]);
    const recorded = await cli([
      "--project", projectDir,
      "--as", "audit-agent",
      FIXTURE_COMMAND, "recorded",
    ]);
    assert.equal(recorded.command, "recorded");
    assert.ok(recorded.recorded, "recorded payload must exist");
    assert.equal(recorded.recorded.mode, "allow");
    assert.equal(recorded.recorded.received.action, "task.take");
    assert.equal(recorded.recorded.received.actor, "audit-agent");
    assert.ok(Array.isArray(recorded.recorded.namespace_keys));
    assert.ok(recorded.recorded.namespace_keys.includes("mode"));
  });
});
test("e2e: recorded — returns null when authorize has never been invoked", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    const recorded = await cli([
      "--project", projectDir,
      "--as", "audit-agent",
      FIXTURE_COMMAND, "recorded",
    ]);
    assert.equal(recorded.command, "recorded");
    assert.equal(recorded.recorded, null);
  });
});
test("e2e: uninstall — helper cleans up installed dir", async () => {
  await withFreshEnv(async ({ home, projectDir }) => {
    await installPolicyFixture(projectDir);
    const installedDir = path.join(home, "plugins", "installed", FIXTURE_ID);
    assert.ok((await fs.stat(installedDir)).isDirectory(), "installed before uninstall");
    await uninstallPolicyFixture(projectDir);
    await assert.rejects(
      fs.stat(installedDir),
      /ENOENT/,
      "installed dir must be gone after uninstall",
    );
  });
});
test("e2e: uninstall — re-running on an already-clean dir is a successful no-op", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await uninstallPolicyFixture(projectDir);
    // Second uninstall must succeed without raising — the helper
    // surfaces PLUGIN_LOAD_FAILED-equivalent cleanly.
    const result = await uninstallPolicyFixture(projectDir);
    assert.ok(result && result.plugin);
    assert.equal(result.plugin.id, FIXTURE_ID);
    assert.equal(result.plugin.uninstalled, true);
  });
});