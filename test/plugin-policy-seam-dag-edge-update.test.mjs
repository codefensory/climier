import { test } from "node:test";
import assert from "node:assert/strict";
import { installPolicyFixture } from "./helpers.mjs";
import { initProject } from "./plugin-policy-seam-dag-helpers.mjs";
import { baseClimierJson, buildEnvNamespace, cli, hasBlocksEdge, recorded, registerInitiative, runCliRaw, withFreshEnv } from "./plugin-policy-seam-dag-helpers.mjs";

test("seam-dag: add-edge with no policy installed mutates", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-1",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-2",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    const out = await cli([
      "--project", projectDir, "--as", "agent-a",
      "add-edge", "T-1", "T-2", "--type", "BLOCKS",
    ]);
    assert.equal(out.edge.from, "T-1");
    assert.equal(out.edge.to, "T-2");
    assert.equal(out.edge.type, "BLOCKS");
  });
});

test("seam-dag: add-edge with policy=allow sends action=edge.add to seam", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-1",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-2",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    await cli([
      "--project", projectDir, "--as", "agent-a",
      "add-edge", "T-1", "T-2", "--type", "BLOCKS",
    ]);

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.mode, "allow");
    assert.equal(rec.recorded.received.action, "edge.add");
    assert.equal(rec.recorded.received.actor, "agent-a");
    // Snapshot under the lock must expose the live DAG so the policy
    // can make an informed decision, without leaking internal fence metadata.
    assert.deepEqual(rec.recorded.received.snapshot_keys.toSorted(), [
      "edges",
      "initiatives",
      "log",
      "nodes",
      "revision",
      "version",
    ]);
  });
});

test("seam-dag: add-edge with policy=deny returns POLICY_DENIED without mutating state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    // Seed the project with mode=allow so the bootstrap add-task calls
    // are not denied, then switch to mode=deny for the add-edge under test.
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-1",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-2",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    await baseClimierJson(projectDir, buildEnvNamespace("deny", { reason: "no edge.add" }));

    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-edge", "T-1", "T-2", "--type", "BLOCKS",
    ]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "POLICY_DENIED");
    assert.equal(body.error.details.action, "edge.add");

    // No BLOCKS edge should exist between T-1 and T-2.
    const status = await cli(["--project", projectDir, "status"]);
    assert.equal(hasBlocksEdge(status, "T-1", "T-2"), false);
  });
});

test("seam-dag: add-edge with policy=throw returns POLICY_ERROR without mutating state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    // Seed the project with mode=allow so the bootstrap add-task calls
    // are not thrown on, then switch to mode=throw for the add-edge.
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-1",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-2",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    await baseClimierJson(projectDir, buildEnvNamespace("throw"));

    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-edge", "T-1", "T-2", "--type", "BLOCKS",
    ]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "POLICY_ERROR");
    assert.equal(body.error.details.action, "edge.add");
  });
});

test("seam-dag: update on a task with policy=allow sends action=task.update", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-1",
       "--initiative", "alpha", "--title", "orig", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );

    await cli([
      "--project", projectDir, "--as", "agent-a",
      "update", "T-1", "--title", "updated",
    ]);

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.mode, "allow");
    assert.equal(rec.recorded.received.action, "task.update");
    assert.equal(rec.recorded.received.target.id, "T-1");
    assert.equal(rec.recorded.received.target.subkind, "task");
  });
});

test("seam-dag: update on a gate with policy=allow sends action=gate.update", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-gate", "G-1",
       "--initiative", "alpha", "--title", "orig", "--body", "b",
       "--purpose", "decision"],
    );

    await cli([
      "--project", projectDir, "--as", "agent-a",
      "update", "G-1", "--title", "updated",
    ]);

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.mode, "allow");
    assert.equal(rec.recorded.received.action, "gate.update");
    assert.equal(rec.recorded.received.target.id, "G-1");
    assert.equal(rec.recorded.received.target.subkind, "gate");
  });
});

test("seam-dag: update on a knowledge node with policy=allow sends action=knowledge.update", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-knowledge", "K-1",
       "--initiative", "alpha", "--title", "orig", "--body", "b",
       "--scope-domains", "core"],
    );

    await cli([
      "--project", projectDir, "--as", "agent-a",
      "update", "K-1", "--title", "updated",
    ]);

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.mode, "allow");
    assert.equal(rec.recorded.received.action, "knowledge.update");
    assert.equal(rec.recorded.received.target.id, "K-1");
    assert.equal(rec.recorded.received.target.kind, "knowledge");
  });
});

test("seam-dag: update with policy=deny returns POLICY_DENIED without mutating state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    // Seed the project with mode=allow so the bootstrap add-task is
    // not denied, then switch to mode=deny for the update under test.
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-1",
       "--initiative", "alpha", "--title", "orig", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    await baseClimierJson(projectDir, buildEnvNamespace("deny", { reason: "no update" }));

    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "update", "T-1", "--title", "updated",
    ]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "POLICY_DENIED");
    assert.equal(body.error.details.action, "task.update");

    // State must be intact after denial, including its observed revision.
    const before = await cli(["--project", projectDir, "show", "T-1"]);
    assert.equal(before.node.title, "orig");
    const show = await cli(["--project", projectDir, "show", "T-1"]);
    assert.equal(show.node.revision, before.node.revision);
  });
});

test("seam-dag: deprecate-knowledge with policy=allow mutates and logs", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-knowledge", "K-1",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--scope-domains", "core"],
    );

    const out = await cli([
      "--project", projectDir, "--as", "agent-a",
      "deprecate-knowledge", "K-1", "--reason", "obsolete",
    ]);
    assert.equal(out.node.status, "deprecated");

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.mode, "allow");
    assert.equal(rec.recorded.received.action, "knowledge.deprecate");
    assert.equal(rec.recorded.received.target.id, "K-1");
  });
});
