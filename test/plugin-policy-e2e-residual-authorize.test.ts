// Policy fixture focused e2e tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_COMMAND, withFreshEnv, cli, runCli, writeClimierJson, installPolicyFixture } from "./plugin-policy-e2e-residual-helpers.ts";

test("e2e: authorize — allow mode returns {decision:'allow'}", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { mode: "allow" } },
    });
    const out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "authorize-check", "task.take",
    ]);
    assert.equal(out.command, "authorize-check");
    assert.deepEqual(out.decision, { decision: "allow" });
    assert.equal(out.received.action, "task.take");
    assert.equal(out.received.actor, "fixture-agent");
  });
});
test("e2e: authorize — deny mode returns {decision:'deny', reason}", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: {
        "policy-fixture": { mode: "deny", reason: "explicit deny from fixture" },
      },
    });
    const out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "authorize-check", "gate.resolve",
    ]);
    assert.deepEqual(out.decision, { decision: "deny", reason: "explicit deny from fixture" });
    assert.equal(out.received.action, "gate.resolve");
  });
});
test("e2e: authorize — deny mode uses default reason when none configured", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { mode: "deny" } },
    });
    const out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "authorize-check", "task.take",
    ]);
    assert.equal(out.decision.decision, "deny");
    assert.equal(typeof out.decision.reason, "string");
    assert.ok(out.decision.reason.length > 0);
  });
});
test("e2e: authorize — abstain mode returns {decision:'abstain'}", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { mode: "abstain" } },
    });
    const out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "authorize-check", "task.take",
    ]);
    assert.deepEqual(out.decision, { decision: "abstain" });
  });
});
test("e2e: authorize — throw mode raises through the dispatcher", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { mode: "throw" } },
    });
    const result = await runCli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "authorize-check", "task.take",
    ]);

    // (ADR-005 §"Dispatch y contrato de errores"). The fixture's throw
    // attaches code = "POLICY_ERROR_FIXTURE" but the dispatcher keeps
    // only the message in details.cause; verifying the message is
    // enough to prove the throw propagated and was not masked.
    assert.equal(result.code, 1);
    const err = JSON.parse(result.stdout);
    assert.equal(err.ok, false);
    assert.equal(err.error.code, "PLUGIN_HANDLER_FAILED");
    assert.ok(err.error.details && err.error.details.cause, "details.cause must be present");
    assert.match(err.error.details.cause, /mode 'throw' rejected the action/);

    // The fixture still records the throw attempt for audit — verify
    // a separate `recorded` call sees mode='throw' and the original

    const recorded = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "recorded",
    ]);
    assert.ok(recorded.recorded, "recorded payload must exist");
    assert.equal(recorded.recorded.mode, "throw");
    assert.equal(recorded.recorded.received.action, "task.take");
    assert.equal(recorded.recorded.received.actor, "fixture-agent");
  });
});
test("e2e: authorize — slow mode sleeps then allows", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    const slowMs = 80;
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { mode: "slow", slowMs } },
    });
    const start = Date.now();
    const out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "authorize-check", "task.take",
    ]);
    const elapsed = Date.now() - start;
    assert.deepEqual(out.decision, { decision: "allow" });
    assert.ok(
      elapsed >= slowMs,
      `slow mode must sleep at least ${slowMs}ms; elapsed=${elapsed}ms`,
    );
    // Generous upper bound: a hung timer would exceed this.
    assert.ok(
      elapsed < slowMs + 4000,
      `slow mode should not hang; elapsed=${elapsed}ms`,
    );
  });
});
test("e2e: authorize — actor/action passed through unchanged", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { mode: "allow" } },
    });
    const out = await cli([
      "--project", projectDir,
      "--as", "alice",
      FIXTURE_COMMAND, "authorize-check", "gate.resolve",
    ]);
    assert.equal(out.received.action, "gate.resolve");
    assert.equal(out.received.actor, "alice");
    assert.equal(out.received.target_id, "T-fixture-target");
    assert.equal(out.received.target_kind, "resolvable");
    assert.equal(out.received.projectDir, projectDir);

    // to authorize (plan §3.3). The subcommand mirrors that contract.
    assert.equal(out.received.projectConfig_frozen, true);
    // The fixture only reads its own namespace; verify the namespace
    // keys were observable.
    assert.ok(Array.isArray(out.received.namespace_keys));
    assert.ok(out.received.namespace_keys.includes("mode"));
  });
});
test("e2e: authorize — distinct actor per invocation is observable in the received payload", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { mode: "allow" } },
    });
    const a = await cli([
      "--project", projectDir,
      "--as", "bob",
      FIXTURE_COMMAND, "authorize-check", "task.take",
    ]);
    const b = await cli([
      "--project", projectDir,
      "--as", "carol",
      FIXTURE_COMMAND, "authorize-check", "task.release",
    ]);
    assert.equal(a.received.actor, "bob");
    assert.equal(a.received.action, "task.take");
    assert.equal(b.received.actor, "carol");
    assert.equal(b.received.action, "task.release");
  });
});
