import { test } from "node:test";
import assert from "node:assert/strict";
import * as helpers from "./plugin-core-adapter-helpers.mjs";

// 8. policy — selection outside lock, decision inside, errors preserved
// =====================================================================

test("plugin-core-adapter: with no policy installed, run completes successfully (default abstain)", async () => {
  await helpers.withIsolatedEnv(async () => {
    const dir = await helpers.createTempProject();
    try {
      const core = await helpers.freshCore(dir, { agent: "alice", pluginId: "example.audit" });
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
      await helpers.rmTempProject(dir);
    }
  });
});

test("plugin-core-adapter: POLICY_DENIED from the selected policy surfaces with structured details", async () => {
  await policyDeniedScenario();
});

async function policyDeniedScenario() {
  await helpers.withIsolatedEnv(async () => {
    const dir = await helpers.createTempProject();
    try {
      const core = await helpers.freshCore(dir, { agent: "alice", pluginId: "example.audit" });
      const reason = "no task.creates allowed in tests";
      await helpers.installPolicyFixture(dir, {
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
          helpers.isPolicyDeniedTaskCreate,
        );
        const after = await helpers.readState(dir);
        assert.equal(after.nodes["T-deny"], undefined, "denied mutation did not touch state");
      } finally {
        await helpers.uninstallPolicyFixture(dir, { pluginId: "policy.test" });
      }
    } finally {
      await helpers.rmTempProject(dir);
    }
  });
}

test("plugin-core-adapter: applies() throwing inside the selected policy surfaces as POLICY_ERROR", async () => {
  await helpers.withIsolatedEnv(async () => {
    const dir = await helpers.createTempProject();
    try {
      const core = await helpers.freshCore(dir, { agent: "alice", pluginId: "example.audit" });
      await helpers.installPolicyFixture(dir, {
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
          helpers.isPolicyTaskCreateError,
        );
      } finally {
        await helpers.uninstallPolicyFixture(dir, { pluginId: "policy.test" });
      }
    } finally {
      await helpers.rmTempProject(dir);
    }
  });
});
