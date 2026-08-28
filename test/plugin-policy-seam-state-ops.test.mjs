// T-plugin-policy-seam-state-ops — focal matrix for the state-ops seam.
//
// ADR-008 §"`restore` e `init --force`" + plan §3.6 / §4.5:
//
//   restore:  resolve actor → read target (raw + meta) → withLock →
//             validate target (no side effects) →
//             authorize("state.restore") →
//             createSnapshot("pre-restore") → write → log
//
//   init --force: resolve actor → ensureProjectMeta → read projectConfig →
//             withLock → authorize("state.init_force") →
//             createSnapshot("force-init") → writeState fresh
//
// Invariants locked down here:
//   - restore no longer compares the actor against `orchestrator` /
//     `recovery`; a plain agent restores when no policy is installed.
//   - restore never creates the `pre-restore` snapshot before a
//     successful authorization: deny / throw / invalid target leave the
//     snapshot dir untouched (no orphan snapshot) and state unchanged.
//   - `init --force` requires an actor (MISSING_AGENT otherwise) and
//     uses the canonical action `state.init_force`.
//   - `init` without `--force` is bootstrap: no actor required, no
//     policy invoked (not even with a deny policy installed). Same for
//     the corrupt-recovery path.
//
// Every test runs against an isolated CLIMIER_HOME and a per-test temp
// project dir, mirroring test/plugin-policy-seam-lifecycle.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createTempProject,
  rmTempProject,
  readState,
  runCli,
  installPolicyFixture,
  uninstallPolicyFixture,
} from "./helpers.mjs";

const PROJECT_ID = "seam-state-ops-project";

async function withFreshEnv(body) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-seam-state-ops-"));
  const projectDir = await createTempProject();
  const prev = {
    CLIMIER_HOME: process.env.CLIMIER_HOME,
    CLIMIER_AGENT: process.env.CLIMIER_AGENT,
  };
  process.env.CLIMIER_HOME = home;
  // Actor identity must be explicit through --as in every dispatch so
  // the MISSING_AGENT cases are reproducible.
  delete process.env.CLIMIER_AGENT;
  try {
    return await body({ home, projectDir });
  } finally {
    if (prev.CLIMIER_HOME === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = prev.CLIMIER_HOME;
    if (prev.CLIMIER_AGENT === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prev.CLIMIER_AGENT;
    await fs.rm(home, { recursive: true, force: true });
    await rmTempProject(projectDir);
  }
}

async function cli(args) {
  const result = await runCli(args);
  if (result.code !== 0) {
    throw new Error(
      `climier exited ${result.code}\nargv: ${JSON.stringify(args)}\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  if (!result.stdout.trim()) return null;
  return JSON.parse(result.stdout);
}

async function cliFail(args) {
  const result = await runCli(args);
  assert.notEqual(result.code, 0, `expected failure for ${JSON.stringify(args)}: ${result.stdout}`);
  const data = JSON.parse(result.stdout);
  assert.equal(data.ok, false);
  return data.error;
}

async function writeClimierJson(projectDir, mode) {
  const value = { version: 1, project_id: PROJECT_ID };
  if (mode !== undefined) value.plugins = { "policy-fixture": { mode } };
  await fs.writeFile(
    path.join(projectDir, ".climier.json"),
    JSON.stringify(value, null, 2) + "\n",
    "utf8",
  );
}

// initAndSeed — .climier.json MUST exist before `init` so the state
// path is pinned to PROJECT_ID (same caveat as the lifecycle suite).
async function initAndSeed({ projectDir, mode }) {
  await writeClimierJson(projectDir, mode);
  await cli(["--project", projectDir, "init"]);
  await cli(["--project", projectDir, "add-initiative", "auth", "--desc", "auth", "--as", "setup"]);
  await cli([
    "--project", projectDir,
    "add-node", "Sentinel",
    "--kind", "resolvable", "--subkind", "task", "--title", "alive",
    "--initiative", "auth", "--as", "setup",
  ]);
}

async function snapshots(projectDir) {
  const out = await cli(["--project", projectDir, "snapshots"]);
  return out.snapshots;
}

async function reasons(projectDir) {
  return (await snapshots(projectDir)).map((s) => s.reason);
}

// seedSnapshotWithSentinel — produce a restorable snapshot that carries
// the Sentinel node, then leave the live state empty. The `init --force`
// used to create it runs with NO policy installed (abstain → defaults
// core) and an explicit actor.
async function seedSnapshotWithSentinel(projectDir, mode) {
  await initAndSeed({ projectDir });
  await cli(["--project", projectDir, "init", "--force", "--as", "setup"]);
  const snaps = await snapshots(projectDir);
  const target = snaps.find((s) => s.reason === "force-init");
  assert.ok(target, "expected a force-init snapshot to restore from");
  // Re-point the fixture mode only after the setup mutations are done.
  await writeClimierJson(projectDir, mode);
  return target.id;
}

async function recorded(home) {
  try {
    const raw = await fs.readFile(path.join(home, "policy-fixture-state.json"), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

// ===========================================================================
// restore
// ===========================================================================

test("seam-restore: a plain agent restores when no policy is installed (no role hatch left)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    const id = await seedSnapshotWithSentinel(projectDir);
    const out = await cli(["--project", projectDir, "restore", id, "--as", "alice"]);
    assert.equal(out.snapshot.id, id);
    const s = await readState(projectDir);
    assert.ok(s.nodes.Sentinel, "Sentinel must be back after restore");
    assert.ok((await reasons(projectDir)).includes("pre-restore"));
    const entry = s.log.find((e) => e.action === "restore");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.snapshot_id, id);
  });
});

test("seam-restore: missing actor fails with MISSING_AGENT and creates no pre-restore snapshot", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    const id = await seedSnapshotWithSentinel(projectDir);
    const err = await cliFail(["--project", projectDir, "restore", id]);
    assert.equal(err.code, "MISSING_AGENT");
    assert.equal((await reasons(projectDir)).includes("pre-restore"), false);
    const s = await readState(projectDir);
    assert.deepEqual(s.nodes, {});
  });
});

test("seam-restore: policy allow restores and receives action=state.restore with the CLI actor", async () => {
  await withFreshEnv(async ({ projectDir, home }) => {
    const id = await seedSnapshotWithSentinel(projectDir, "allow");
    await installPolicyFixture(projectDir);
    try {
      await cli(["--project", projectDir, "restore", id, "--as", "alice"]);
      const s = await readState(projectDir);
      assert.ok(s.nodes.Sentinel);
      const rec = await recorded(home);
      assert.equal(rec.received.action, "state.restore");
      assert.equal(rec.received.actor, "alice");
      assert.deepEqual(rec.received.snapshot_keys, ["state", "nodes", "edges", "initiatives"]);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-restore: policy abstain restores (defaults core)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    const id = await seedSnapshotWithSentinel(projectDir, "abstain");
    await installPolicyFixture(projectDir);
    try {
      await cli(["--project", projectDir, "restore", id, "--as", "alice"]);
      const s = await readState(projectDir);
      assert.ok(s.nodes.Sentinel);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-restore: policy deny returns POLICY_DENIED, leaves state intact and no orphan pre-restore snapshot", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    const id = await seedSnapshotWithSentinel(projectDir, "deny");
    await installPolicyFixture(projectDir);
    try {
      const before = await reasons(projectDir);
      const err = await cliFail(["--project", projectDir, "restore", id, "--as", "alice"]);
      assert.equal(err.code, "POLICY_DENIED");
      const s = await readState(projectDir);
      assert.deepEqual(s.nodes, {}, "denied restore must not bring Sentinel back");
      assert.equal(s.log.find((e) => e.action === "restore"), undefined);
      assert.deepEqual(await reasons(projectDir), before);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-restore: policy throw returns POLICY_ERROR and leaves state and snapshots untouched", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    const id = await seedSnapshotWithSentinel(projectDir, "throw");
    await installPolicyFixture(projectDir);
    try {
      const before = await reasons(projectDir);
      const err = await cliFail(["--project", projectDir, "restore", id, "--as", "alice"]);
      assert.equal(err.code, "POLICY_ERROR");
      const s = await readState(projectDir);
      assert.deepEqual(s.nodes, {});
      assert.deepEqual(await reasons(projectDir), before);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-restore: an unknown target fails before the seam and creates no pre-restore snapshot", async () => {
  await withFreshEnv(async ({ projectDir, home }) => {
    await seedSnapshotWithSentinel(projectDir, "allow");
    await installPolicyFixture(projectDir);
    try {
      const err = await cliFail([
        "--project", projectDir, "restore", "20260101T000000000Z-force-init-deadbeef", "--as", "alice",
      ]);
      assert.equal(err.code, "NODE_NOT_FOUND");
      assert.equal((await reasons(projectDir)).includes("pre-restore"), false);
      // Target validation runs before authorizeAction: the policy is
      // never consulted for a target that does not exist.
      assert.equal(await recorded(home), null);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

// ===========================================================================
// init --force
// ===========================================================================

test("seam-init-force: init --force without an actor fails with MISSING_AGENT and does not wipe state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    const err = await cliFail(["--project", projectDir, "init", "--force"]);
    assert.equal(err.code, "MISSING_AGENT");
    const s = await readState(projectDir);
    assert.ok(s.nodes.Sentinel, "state must survive an actorless init --force");
    assert.deepEqual(await reasons(projectDir), []);
  });
});

test("seam-init-force: init --force with an actor and no policy wipes state and snapshots force-init", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    const out = await cli(["--project", projectDir, "init", "--force", "--as", "alice"]);
    assert.equal(out.ok, true);
    const s = await readState(projectDir);
    assert.deepEqual(s.nodes, {});
    assert.deepEqual(await reasons(projectDir), ["force-init"]);
  });
});

test("seam-init-force: CLIMIER_AGENT satisfies the actor requirement", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    const r = await runCli(["--project", projectDir, "init", "--force"], {
      env: { ...process.env, CLIMIER_AGENT: "env-agent" },
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const s = await readState(projectDir);
    assert.deepEqual(s.nodes, {});
  });
});

test("seam-init-force: policy allow wipes and receives action=state.init_force", async () => {
  await withFreshEnv(async ({ projectDir, home }) => {
    await initAndSeed({ projectDir, mode: "allow" });
    await installPolicyFixture(projectDir);
    try {
      await cli(["--project", projectDir, "init", "--force", "--as", "alice"]);
      const s = await readState(projectDir);
      assert.deepEqual(s.nodes, {});
      const rec = await recorded(home);
      assert.equal(rec.received.action, "state.init_force");
      assert.equal(rec.received.actor, "alice");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-init-force: policy abstain wipes (defaults core)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir, mode: "abstain" });
    await installPolicyFixture(projectDir);
    try {
      await cli(["--project", projectDir, "init", "--force", "--as", "alice"]);
      const s = await readState(projectDir);
      assert.deepEqual(s.nodes, {});
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-init-force: policy deny returns POLICY_DENIED, preserves state and creates no force-init snapshot", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir, mode: "deny" });
    await installPolicyFixture(projectDir);
    try {
      const err = await cliFail(["--project", projectDir, "init", "--force", "--as", "alice"]);
      assert.equal(err.code, "POLICY_DENIED");
      const s = await readState(projectDir);
      assert.ok(s.nodes.Sentinel);
      assert.deepEqual(await reasons(projectDir), []);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-init-force: policy throw returns POLICY_ERROR and preserves state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir, mode: "throw" });
    await installPolicyFixture(projectDir);
    try {
      const err = await cliFail(["--project", projectDir, "init", "--force", "--as", "alice"]);
      assert.equal(err.code, "POLICY_ERROR");
      const s = await readState(projectDir);
      assert.ok(s.nodes.Sentinel);
      assert.deepEqual(await reasons(projectDir), []);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

// ===========================================================================
// init without --force stays out of the seam (bootstrap)
// ===========================================================================

test("seam-init: plain init needs no actor and never invokes the policy (deny installed)", async () => {
  await withFreshEnv(async ({ projectDir, home }) => {
    await writeClimierJson(projectDir, "deny");
    await installPolicyFixture(projectDir);
    try {
      const out = await cli(["--project", projectDir, "init"]);
      assert.equal(out.ok, true);
      assert.equal(await recorded(home), null, "bootstrap init must not consult the policy");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-init: corrupt-recovery (no --force) needs no actor and never invokes the policy", async () => {
  await withFreshEnv(async ({ projectDir, home }) => {
    await initAndSeed({ projectDir, mode: "deny" });
    const stateDir = path.join(process.env.CLIMIER_HOME, "projects", PROJECT_ID);
    await fs.writeFile(path.join(stateDir, "tasks.json"), "{ not json", "utf8");
    await installPolicyFixture(projectDir);
    try {
      const out = await cli(["--project", projectDir, "init"]);
      assert.equal(out.ok, true);
      const s = await readState(projectDir);
      assert.deepEqual(s.nodes, {});
      assert.deepEqual(await reasons(projectDir), ["corrupt-recovery"]);
      assert.equal(await recorded(home), null);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});
