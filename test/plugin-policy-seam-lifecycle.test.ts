import { test } from "node:test";
import assert from "node:assert/strict";
import { readState, runCli, installPolicyFixture, uninstallPolicyFixture } from "./helpers.ts";
import { cli, entriesForAction, initAndSeed, installAndTake, withFreshEnv, writeClimierJson } from "./plugin-policy-seam-lifecycle-helpers.mjs";

test("seam-take: take on a free task with no policy installed succeeds (defaults core, abstain)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    // No installPolicyFixture → loadApplicablePolicy returns null →
    // authorizeAction returns abstain → defaults core handles the take.
    await initAndSeed({ projectDir });
    const out = await cli(["--project", projectDir, "take", "T-auth-1", "--as", "alice"]);
    assert.equal(out.freshly_claimed, true);
    assert.equal(out.node.claim.by, "alice");
    assert.equal(out.node.status, "in_progress");
  });
});

test("seam-take: same-actor take on an already-claimed task is idempotent (no seam invocation)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    const first = await cli(["--project", projectDir, "take", "T-auth-1", "--as", "alice"]);
    assert.equal(first.freshly_claimed, true);
    const before = first.node.revision;
    // Same actor — must be idempotent (no seam, no mutation, no log
    // entry beyond the first).
    const second = await cli(["--project", projectDir, "take", "T-auth-1", "--as", "alice"]);
    assert.equal(second.freshly_claimed, false);
    assert.equal(second.node.claim.by, "alice");
    assert.equal(second.node.revision, before);
    // Only one take log entry: idempotent second call did NOT log.
    const s = await readState(projectDir);
    const takeEntries = entriesForAction(s, "take");
    assert.equal(takeEntries.length, 1);
  });
});

test("seam-take: takeover with policy allow replaces claim and preserves previous_owner", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "allow" } },
      });
      // Alice takes first (no policy decision required; claim registered).
      await cli(["--project", projectDir, "take", "T-auth-1", "--as", "alice"]);
      // Bob takes next with policy=allow → takeover succeeds and
      // previous_owner=alice is logged.
      const out = await cli(["--project", projectDir, "take", "T-auth-1", "--as", "bob"]);
      assert.equal(out.freshly_claimed, true);
      assert.equal(out.node.claim.by, "bob");
      const s = await readState(projectDir);
      const takeEntries = entriesForAction(s, "take");
      assert.equal(takeEntries.length, 2);
      assert.equal(takeEntries[0].agent, "alice");
      assert.equal(takeEntries[0].previous_owner, undefined);
      assert.equal(takeEntries[1].agent, "bob");
      assert.equal(takeEntries[1].previous_owner, "alice");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-take: takeover with policy deny returns POLICY_DENIED and leaves claim unchanged", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installAndTake(projectDir, "alice");
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "deny", reason: "no takeover" } },
      });
      const before = await readState(projectDir);
      const result = await runCli([
        "--project", projectDir, "take", "T-auth-1", "--as", "bob",
      ]);
      assert.equal(result.code, 1, `expected exit 1, got ${result.code}: ${result.stdout}`);
      const data = JSON.parse(result.stdout);
      assert.equal(data.ok, false);
      assert.equal(data.error.code, "POLICY_DENIED");
      assert.equal(data.error.details.plugin_id, "policy-fixture");
      assert.equal(data.error.details.action, "task.takeover");
      assert.equal(data.error.details.actor, "bob");
      // No state mutation: claim remains with alice, revision unchanged,
      // and no second take log entry was written.
      const after = await readState(projectDir);
      assert.equal(after.nodes["T-auth-1"].claim.by, "alice");
      assert.equal(after.nodes["T-auth-1"].revision, before.nodes["T-auth-1"].revision);
      const takeEntries = entriesForAction(after, "take");
      assert.equal(takeEntries.length, 1);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-take: takeover with policy abstain returns ALREADY_CLAIMED (defaults core refuses)", async () => {
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
      const before = await readState(projectDir);
      const result = await runCli([
        "--project", projectDir, "take", "T-auth-1", "--as", "bob",
      ]);
      assert.equal(result.code, 1, `expected exit 1, got ${result.code}: ${result.stdout}`);
      const data = JSON.parse(result.stdout);
      assert.equal(data.ok, false);
      assert.equal(data.error.code, "ALREADY_CLAIMED");
      assert.equal(data.error.details.owner, "alice");
      const after = await readState(projectDir);
      assert.equal(after.nodes["T-auth-1"].claim.by, "alice");
      assert.equal(after.nodes["T-auth-1"].revision, before.nodes["T-auth-1"].revision);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-release: owner releases with no policy (defaults core)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await cli(["--project", projectDir, "take", "T-auth-1", "--as", "alice"]);
    const out = await cli(["--project", projectDir, "release", "T-auth-1", "--as", "alice"]);
    assert.equal(out.released, true);
    assert.equal(out.node.status, "open");
    assert.equal(out.node.claim, null);
  });
});

test("seam-release: non-owner with policy allow can release any agent's claim", async () => {
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
      const out = await cli([
        "--project", projectDir, "release", "T-auth-1", "--as", "bob",
      ]);
      assert.equal(out.released, true);
      assert.equal(out.node.status, "open");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-release: non-owner with policy deny returns POLICY_DENIED (no state mutation)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installAndTake(projectDir, "alice");
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "deny", reason: "no release" } },
      });
      const before = await readState(projectDir);
      const result = await runCli([
        "--project", projectDir, "release", "T-auth-1", "--as", "bob",
      ]);
      assert.equal(result.code, 1);
      const data = JSON.parse(result.stdout);
      assert.equal(data.ok, false);
      assert.equal(data.error.code, "POLICY_DENIED");
      assert.equal(data.error.details.action, "task.release");
      const after = await readState(projectDir);
      assert.equal(after.nodes["T-auth-1"].claim.by, "alice");
      assert.equal(after.nodes["T-auth-1"].status, "in_progress");
      assert.equal(after.nodes["T-auth-1"].revision, before.nodes["T-auth-1"].revision);
      const releaseEntries = entriesForAction(after, "release");
      assert.equal(releaseEntries.length, 0);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-release: non-owner with policy abstain succeeds (defaults core proceeds)", async () => {

  // proceeds and any actor can release. NOT_OWNER no longer applies
  // to release.
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
        "--project", projectDir, "release", "T-auth-1", "--as", "bob",
      ]);
      assert.equal(out.released, true);
      assert.equal(out.node.status, "open");
      assert.equal(out.node.claim, null);
      const after = await readState(projectDir);
      const releaseEntries = entriesForAction(after, "release");
      assert.equal(releaseEntries.length, 1);
      assert.equal(releaseEntries[0].agent, "bob");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-release: policy throw returns POLICY_ERROR (no state mutation)", async () => {
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
        "--project", projectDir, "release", "T-auth-1", "--as", "alice",
      ]);
      assert.equal(result.code, 1);
      const data = JSON.parse(result.stdout);
      assert.equal(data.ok, false);
      assert.equal(data.error.code, "POLICY_ERROR");
      assert.equal(data.error.details.action, "task.release");
      const after = await readState(projectDir);
      assert.equal(after.nodes["T-auth-1"].claim.by, "alice");
      assert.equal(after.nodes["T-auth-1"].revision, before.nodes["T-auth-1"].revision);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});
