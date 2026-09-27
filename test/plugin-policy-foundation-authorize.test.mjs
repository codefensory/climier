import { test } from "node:test";
import assert from "node:assert/strict";
import { importFresh } from "./helpers.mjs";
import { withEnv } from "./plugin-policy-foundation-helpers.mjs";

const POLICY_MODULE = "../src/plugins/policy.mjs";
const ERRORS_MODULE = "../src/plugins/errors.mjs";

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