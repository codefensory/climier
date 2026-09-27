import { test } from "node:test";
import assert from "node:assert/strict";
import { readState, runCli, installPolicyFixture, uninstallPolicyFixture } from "./helpers.mjs";
import { assertPolicyError, cli, entriesForAction, initAndSeed, installAndTake, withFreshEnv, writeClimierJson } from "./plugin-policy-seam-lifecycle-helpers.mjs";

test("seam-reopen: done_by reopens with no policy (defaults core)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await cli(["--project", projectDir, "take", "T-auth-1", "--as", "alice"]);
    await cli([
      "--project", projectDir, "submit", "T-auth-1",
      "--note", "shipped", "--as", "alice",
    ]);
    await cli(["--project", projectDir, "accept", "T-auth-1", "--as", "alice"]);
    const out = await cli([
      "--project", projectDir, "reopen", "T-auth-1",
      "--reason", "rollback", "--as", "alice",
    ]);
    assert.equal(out.node.status, "open");
    assert.equal(out.node.claim, null);
  });
});

test("seam-reopen: any actor reopens with policy allow", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "allow" } },
      });
      await cli(["--project", projectDir, "take", "T-auth-1", "--as", "alice"]);
      await cli([
        "--project", projectDir, "submit", "T-auth-1",
        "--note", "shipped", "--as", "alice",
      ]);
      await cli(["--project", projectDir, "accept", "T-auth-1", "--as", "alice"]);
      const out = await cli([
        "--project", projectDir, "reopen", "T-auth-1",
        "--reason", "auditing", "--as", "auditor",
      ]);
      assert.equal(out.node.status, "open");
      assert.equal(out.node.claim, null);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-reopen: policy deny returns POLICY_DENIED (no state mutation)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installPolicyFixture(projectDir);
    try {
      // Take + submit + accept with allow, then switch to deny for the reopen call.
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "allow" } },
      });
      await cli(["--project", projectDir, "take", "T-auth-1", "--as", "alice"]);
      await cli([
        "--project", projectDir, "submit", "T-auth-1",
        "--note", "shipped", "--as", "alice",
      ]);
      await cli(["--project", projectDir, "accept", "T-auth-1", "--as", "alice"]);
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "deny", reason: "no reopen" } },
      });
      const before = await readState(projectDir);
      const result = await runCli([
        "--project", projectDir, "reopen", "T-auth-1",
        "--reason", "rollback", "--as", "alice",
      ]);
      assertPolicyError(result, "POLICY_DENIED", "task.reopen");
      const after = await readState(projectDir);
      assert.equal(after.nodes["T-auth-1"].status, "done");
      assert.equal(after.nodes["T-auth-1"].revision, before.nodes["T-auth-1"].revision);
      const reopenEntries = entriesForAction(after, "reopen");
      assert.equal(reopenEntries.length, 0);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-reopen: not-done_by with policy abstain succeeds (defaults core proceeds)", async () => {
  // ADR-009 §"Resto de operaciones": the core no longer compares the
  // actor against done_by. Any actor with --as can reopen; the
  // plugin's abstain falls through to the default core, which proceeds.
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "abstain" } },
      });
      await cli(["--project", projectDir, "take", "T-auth-1", "--as", "alice"]);
      await cli([
        "--project", projectDir, "submit", "T-auth-1",
        "--note", "shipped", "--as", "alice",
      ]);
      await cli(["--project", projectDir, "accept", "T-auth-1", "--as", "alice"]);
      const out = await cli([
        "--project", projectDir, "reopen", "T-auth-1",
        "--reason", "auditing", "--as", "bob",
      ]);
      assert.equal(out.node.status, "open");
      assert.equal(out.node.claim, null);
      assert.equal(out.node.done_by, undefined);
      const after = await readState(projectDir);
      const reopenEntries = entriesForAction(after, "reopen");
      assert.equal(reopenEntries.length, 1);
      assert.equal(reopenEntries[0].agent, "bob");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-reopen: policy throw returns POLICY_ERROR (no state mutation)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installPolicyFixture(projectDir);
    try {
      // Take + submit + accept with allow, then switch to throw for the reopen call.
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "allow" } },
      });
      await cli(["--project", projectDir, "take", "T-auth-1", "--as", "alice"]);
      await cli([
        "--project", projectDir, "submit", "T-auth-1",
        "--note", "shipped", "--as", "alice",
      ]);
      await cli(["--project", projectDir, "accept", "T-auth-1", "--as", "alice"]);
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "throw" } },
      });
      const before = await readState(projectDir);
      const result = await runCli([
        "--project", projectDir, "reopen", "T-auth-1",
        "--reason", "rollback", "--as", "alice",
      ]);
      assert.equal(result.code, 1);
      const data = JSON.parse(result.stdout);
      assert.equal(data.ok, false);
      assert.equal(data.error.code, "POLICY_ERROR");
      assert.equal(data.error.details.action, "task.reopen");
      const after = await readState(projectDir);
      assert.equal(after.nodes["T-auth-1"].status, "done");
      assert.equal(after.nodes["T-auth-1"].revision, before.nodes["T-auth-1"].revision);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-cancel: claim owner cancels with no policy (defaults core)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await cli(["--project", projectDir, "take", "T-auth-1", "--as", "alice"]);
    const out = await cli([
      "--project", projectDir, "cancel", "T-auth-1",
      "--reason", "out of scope", "--as", "alice",
    ]);
    assert.equal(out.node.status, "canceled");
    assert.equal(out.node.claim, null);
  });
});

test("seam-cancel: any actor cancels unclaimed node with policy allow", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "allow" } },
      });
      const out = await cli([
        "--project", projectDir, "cancel", "T-auth-1",
        "--reason", "kickoff-cancel", "--as", "second-admin",
      ]);
      assert.equal(out.node.status, "canceled");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-cancel: policy deny returns POLICY_DENIED (no state mutation)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installAndTake(projectDir, "alice");
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "deny", reason: "no cancel" } },
      });
      const before = await readState(projectDir);
      const result = await runCli([
        "--project", projectDir, "cancel", "T-auth-1",
        "--reason", "oops", "--as", "alice",
      ]);
      assert.equal(result.code, 1);
      const data = JSON.parse(result.stdout);
      assert.equal(data.ok, false);
      assert.equal(data.error.code, "POLICY_DENIED");
      assert.equal(data.error.details.action, "task.cancel");
      const after = await readState(projectDir);
      assert.equal(after.nodes["T-auth-1"].status, "in_progress");
      assert.equal(after.nodes["T-auth-1"].claim.by, "alice");
      assert.equal(after.nodes["T-auth-1"].revision, before.nodes["T-auth-1"].revision);
      const cancelEntries = entriesForAction(after, "cancel");
      assert.equal(cancelEntries.length, 0);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-cancel: non-owner with policy abstain succeeds (defaults core proceeds)", async () => {
  // ADR-009 §"Resto de operaciones": the core no longer compares the
  // actor against the claim owner. Any actor with --as can cancel an
  // open/in_progress node; the plugin's abstain falls through to the
  // default core, which proceeds.
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "abstain" } },
      });
      await cli(["--project", projectDir, "take", "T-auth-1", "--as", "alice"]);
      const out = await cli([
        "--project", projectDir, "cancel", "T-auth-1",
        "--reason", "scope changed", "--as", "bob",
      ]);
      assert.equal(out.node.status, "canceled");
      assert.equal(out.node.claim, null);
      const after = await readState(projectDir);
      const cancelEntries = entriesForAction(after, "cancel");
      assert.equal(cancelEntries.length, 1);
      assert.equal(cancelEntries[0].agent, "bob");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-cancel: policy throw returns POLICY_ERROR (no state mutation)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installAndTake(projectDir, "alice");
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "throw" } },
      });
      const before = await readState(projectDir);
      const result = await runCli([
        "--project", projectDir, "cancel", "T-auth-1",
        "--reason", "oops", "--as", "alice",
      ]);
      assert.equal(result.code, 1);
      const data = JSON.parse(result.stdout);
      assert.equal(data.ok, false);
      assert.equal(data.error.code, "POLICY_ERROR");
      assert.equal(data.error.details.action, "task.cancel");
      const after = await readState(projectDir);
      assert.equal(after.nodes["T-auth-1"].status, "in_progress");
      assert.equal(after.nodes["T-auth-1"].claim.by, "alice");
      assert.equal(after.nodes["T-auth-1"].revision, before.nodes["T-auth-1"].revision);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});
