import { test } from "node:test";
import assert from "node:assert/strict";
import { installPolicyFixture } from "./helpers.ts";
import { runCliRaw } from "./plugin-policy-seam-dag-helpers.ts";
import { baseClimierJson, buildEnvNamespace, cli, initProject, recorded, registerInitiative, withFreshEnv } from "./plugin-policy-seam-dag-helpers.ts";

test("seam-dag: add-task with no policy installed mutates and logs (defaults core)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    // No policy fixture installed: loadApplicablePolicy returns null
    // → seam is inert → core mutation proceeds.
    const out = await cli([
      "--project", projectDir, "--as", "agent-a",
      "add-task", "T-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--acceptance", "acc-x",
      "--blocked-by", "",
    ]);
    assert.equal(out.node.id, "T-x");
    assert.equal(out.node.initiative, "alpha");
  });
});

test("seam-dag: add-task with policy=allow mutates and sends action=task.create to seam", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));

    const out = await cli([
      "--project", projectDir, "--as", "agent-a",
      "add-task", "T-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--acceptance", "acc-x",
      "--blocked-by", "",
    ]);
    assert.equal(out.node.id, "T-x");

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.mode, "allow");
    assert.equal(rec.recorded.received.action, "task.create");
    assert.equal(rec.recorded.received.actor, "agent-a");
    assert.equal(rec.recorded.received.target.id, "T-x");
    assert.equal(rec.recorded.received.target.kind, "resolvable");
    assert.equal(rec.recorded.received.target.subkind, "task");
    assert.equal(rec.recorded.received.projectConfig_frozen, true);
  });
});

test("seam-dag: add-task with policy=deny returns POLICY_DENIED without mutating state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("deny", { reason: "denied task.create" }));

    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-task", "T-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--acceptance", "acc-x",
      "--blocked-by", "",
    ]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "POLICY_DENIED");
    assert.equal(body.error.details.plugin_id, "policy-fixture");
    assert.equal(body.error.details.action, "task.create");
    assert.equal(body.error.details.actor, "agent-a");
    assert.equal(body.error.details.reason, "denied task.create");

    // State must be intact: no node with id T-x.
    const status = await cli(["--project", projectDir, "status"]);
    const ids = Object.keys(status.nodes || {});
    assert.ok(!ids.includes("T-x"), `state must not contain T-x; ids=${JSON.stringify(ids)}`);
  });
});

test("seam-dag: add-task with policy=abstain applies core default (mutates)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("abstain"));

    const out = await cli([
      "--project", projectDir, "--as", "agent-a",
      "add-task", "T-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--acceptance", "acc-x",
      "--blocked-by", "",
    ]);
    assert.equal(out.node.id, "T-x");
  });
});

test("seam-dag: add-task with policy=throw returns POLICY_ERROR without mutating state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("throw"));

    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-task", "T-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--acceptance", "acc-x",
      "--blocked-by", "",
    ]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "POLICY_ERROR");
    assert.equal(body.error.details.plugin_id, "policy-fixture");
    assert.equal(body.error.details.action, "task.create");

    const status = await cli(["--project", projectDir, "status"]);
    const ids = Object.keys(status.nodes || {});
    assert.ok(!ids.includes("T-x"));
  });
});

test("seam-dag: add-gate with policy=allow sends action=gate.create to seam", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));

    const out = await cli([
      "--project", projectDir, "--as", "agent-a",
      "add-gate", "G-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--purpose", "decision",
    ]);
    assert.equal(out.node.id, "G-x");

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.mode, "allow");
    assert.equal(rec.recorded.received.action, "gate.create");
    assert.equal(rec.recorded.received.target.id, "G-x");
    assert.equal(rec.recorded.received.target.subkind, "gate");
  });
});

test("seam-dag: add-gate with policy=deny returns POLICY_DENIED without mutating state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("deny", { reason: "no gate.create" }));

    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-gate", "G-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--purpose", "decision",
    ]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "POLICY_DENIED");
    assert.equal(body.error.details.action, "gate.create");
  });
});

test("seam-dag: add-knowledge with policy=allow sends action=knowledge.create to seam", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));

    const out = await cli([
      "--project", projectDir, "--as", "agent-a",
      "add-knowledge", "K-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--scope-domains", "core",
    ]);
    assert.equal(out.node.id, "K-x");

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.mode, "allow");
    assert.equal(rec.recorded.received.action, "knowledge.create");
    assert.equal(rec.recorded.received.target.id, "K-x");
    assert.equal(rec.recorded.received.target.kind, "knowledge");
  });
});

test("seam-dag: add-knowledge with policy=deny returns POLICY_DENIED without mutating state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("deny", { reason: "no knowledge.create" }));

    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-knowledge", "K-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--scope-domains", "core",
    ]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "POLICY_DENIED");
    assert.equal(body.error.details.action, "knowledge.create");
  });
});
