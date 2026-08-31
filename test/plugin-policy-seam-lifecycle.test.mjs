// T-plugin-policy-seam-lifecycle — focal matrix for the lifecycle seam.
//
// Per ADR-008 §"Tabla de take/resolve/release/reopen/cancel/note/initiative"
// and ADR-009 §"Única invariancia de autoridad del core", every lifecycle
// mutator must:
//   - read state under withLock;
//   - invoke `authorizeAction` with the action listed in §"Acciones
//     canónicas" (task.take / task.takeover / task.resolve /
//     task.release / task.reopen / task.cancel / note.add /
//     initiative.create);
//   - deny / throw short-circuit before any state mutation or log
//     entry; allow / abstain defer to the default core.
//
// ADR-009 §"Resto de operaciones" removes the pre-seam ownership checks
// from resolve / release / reopen / cancel. The seam is now the SOLE
// authority on those actions; with no policy plugin (or abstain), the
// default core lets any actor with `--as` mutate. The `take` and
// `takeover` paths preserve their exclusion-mutuelle invariant
// (ALREADY_CLAIMED without takeover authorization; `task.takeover`
// requires policy=allow and records `previous_owner`).
//
// Coverage:
//   - take: free / same-actor idempotent / takeover allow-deny-abstain
//   - resolve: no-owner with policy absent / allow / abstain
//     (defaults core proceeds); owner allow / deny / abstain
//   - release / reopen / cancel: allow / deny / abstain / throw
//     (non-owner with abstain now succeeds — the default core no
//     longer rejects on ownership)
//   - add-note: note.add (allow/deny/abstain; deny short-circuits
//     before updateState)
//   - add-initiative: initiative.create (allow/abstain/deny; deny
//     short-circuits before updateState and preserves the auto-create
//     behaviour for callers without an existing state file)
//   - "no policy installed" path is exercised by `uninstallPolicyFixture`
//     after `installPolicyFixture`, mirroring the seam contract
//     (`policy === null` → abstain → defaults core).
//
// All mutations run through helpers.mjs (auto-managed CLIMIER_HOME
// under os.tmpdir()) and per-test temp project dirs. Each test
// installs and uninstalls the fixture explicitly so the seam state
// stays isolated.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createTempProject,
  rmTempProject,
  importFresh,
  readState,
  stateExists,
  runCli,
  installPolicyFixture,
  uninstallPolicyFixture,
} from "./helpers.mjs";

// ---- shared helpers --------------------------------------------------

async function withFreshEnv(body) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-seam-lifecycle-"));
  const projectDir = await createTempProject();
  const prev = {
    CLIMIER_HOME: process.env.CLIMIER_HOME,
    CLIMIER_AGENT: process.env.CLIMIER_AGENT,
  };
  process.env.CLIMIER_HOME = home;
  // Force every dispatch to pass --as explicitly so the agent identity
  // is reproducible across the plugin and CLI paths.
  delete process.env.CLIMIER_AGENT;
  try {
    return await body({ home, projectDir });
  } finally {
    if (prev.CLIMIER_HOME === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = prev.CLIMIER_HOME;
    if (prev.CLIMIER_AGENT === undefined) process.env.CLIMIER_AGENT = prev.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prev.CLIMIER_AGENT;
    await fs.rm(home, { recursive: true, force: true });
    await rmTempProject(projectDir);
  }
}

async function cli(args) {
  const result = await runCli(args);
  if (result.code !== 0) {
    throw new Error(
      `climier exited ${result.code}\n` +
        `argv: ${JSON.stringify(args)}\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  if (!result.stdout.trim()) return null;
  return JSON.parse(result.stdout);
}

async function writeClimierJson(projectDir, value) {
  await fs.writeFile(
    path.join(projectDir, ".climier.json"),
    JSON.stringify(value, null, 2) + "\n",
    "utf8",
  );
}

async function baseClimierJson(projectDir) {
  await writeClimierJson(projectDir, {
    version: 1,
    project_id: "seam-lifecycle-project",
  });
}

async function initAndSeed({ projectDir, mode }) {
  // Init a v2 project, register the initiative, and seed a single
  // open task. The fixture (if installed) reads its mode from the
  // namespace plugins["policy-fixture"].mode.
  //
  // .climier.json MUST be written BEFORE `climier init`: the host
  // pins the project_id in <CLIMIER_HOME>/projects/<project_id>/tasks.json
  // from the existing meta file when present. Writing it after init
  // changes the resolved state path under our feet and the test
  // process ends up looking for state at a directory that init never
  // touched.
  if (mode !== undefined) {
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "seam-lifecycle-project",
      plugins: { "policy-fixture": { mode } },
    });
  } else {
    await baseClimierJson(projectDir);
  }
  await cli(["--project", projectDir, "init"]);
  await cli(["--project", projectDir, "add-initiative", "auth", "--desc", "auth", "--as", "setup"]);
  await cli([
    "--project", projectDir,
    "add-node", "T-auth-1",
    "--kind", "resolvable", "--subkind", "task", "--title", "t",
    "--initiative", "auth", "--as", "setup",
  ]);
}

async function taskRevision(state, id) {
  return state.nodes[id].revision;
}

// installAndTake — install the policy fixture, pin mode=allow in
// .climier.json, and take T-auth-1. Used by tests that need to set up
// a claimed node before exercising the action under test (which then
// switches the mode to deny/throw). Without this pattern, a take with
// mode=deny/throw would itself fail before the action under test runs.
async function installAndTake(projectDir, as = "alice") {
  await installPolicyFixture(projectDir);
  await writeClimierJson(projectDir, {
    version: 1,
    project_id: "seam-lifecycle-project",
    plugins: { "policy-fixture": { mode: "allow" } },
  });
  return await cli(["--project", projectDir, "take", "T-auth-1", "--as", as]);
}

// installResolveAndReady — install fixture, take with allow, submit, and
// accept. After this helper runs, the node is in status=done with
// done_by=alice, ready for a reopen test that needs to switch the mode.
async function installResolveAndReady(projectDir, as = "alice") {
  await installAndTake(projectDir, as);
  await cli([
    "--project", projectDir, "submit", "T-auth-1",
    "--note", "shipped", "--as", as,
  ]);
  await cli([
    "--project", projectDir, "accept", "T-auth-1", "--as", as,
  ]);
}

// ===========================================================================
// take: free / same-actor / takeover (allow / deny / abstain)
// ===========================================================================

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
    const takeEntries = s.log.filter((e) => e.action === "take");
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
      const takeEntries = s.log.filter((e) => e.action === "take");
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
      const takeEntries = after.log.filter((e) => e.action === "take");
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

// ===========================================================================
// task.resolve was removed; task acceptance is covered by the
// submission lifecycle tests.
// ===========================================================================
/*
test("seam-resolve: no-owner resolves with policy allow (defaults core no longer blocks)", async () => {
  // ADR-009 §"Resto de operaciones": the core does NOT block a
  // non-owner from resolving. The pre-seam `NOT_OWNER` invariant
  // (ADR-008 §"Tabla de resolve" item 1) is gone. A plugin returning
  // `allow` still authorizes the action, but the default core also
  // lets a non-owner resolve when the policy abstains or is absent.
  // This test exercises the allow path with a non-special actor to
  // pin the seam contract.
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installAndTake(projectDir, "alice");
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "allow" } },
      });
      const result = await runCli([
        "--project", projectDir, "resolve", "T-auth-1",
        "--note", "shipped by auditor", "--as", "bob",
      ]);
      assert.equal(result.code, 0, `expected exit 0, got ${result.code}: ${result.stdout}`);
      const data = JSON.parse(result.stdout);
      assert.equal(data.node.status, "done");
      assert.equal(data.node.done_by, "bob");
      assert.equal(data.node.note, "shipped by auditor");
      assert.equal(data.node.claim, null);
      // Resolve log entry recorded with bob as the agent.
      const after = await readState(projectDir);
      const resolveEntries = after.log.filter((e) => e.action === "resolve");
      assert.equal(resolveEntries.length, 1);
      assert.equal(resolveEntries[0].agent, "bob");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-resolve: no-owner resolves with policy absent (defaults core proceeds)", async () => {
  // ADR-009 §"Resto de operaciones": with no policy plugin installed,
  // the default core lets any actor with `--as` resolve a task whose
  // state is valid for the transition. done_by records the actor that
  // actually mutated.
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installAndTake(projectDir, "alice");
    // No policy installed (no installPolicyFixture, no mode write).
    const result = await runCli([
      "--project", projectDir, "resolve", "T-auth-1",
      "--note", "rolled by ops", "--as", "bob",
    ]);
    assert.equal(result.code, 0, `expected exit 0, got ${result.code}: ${result.stdout}`);
    const data = JSON.parse(result.stdout);
    assert.equal(data.node.status, "done");
    assert.equal(data.node.done_by, "bob");
    assert.equal(data.node.note, "rolled by ops");
  });
});

test("seam-resolve: no-owner resolves with policy abstain (defaults core proceeds)", async () => {
  // ADR-009 §"Resto de operaciones": abstain falls through to the
  // default core, which proceeds. NOT_OWNER is no longer raised for
  // resolve / release / reopen / cancel.
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installAndTake(projectDir, "alice");
    // installAndTake already installed the fixture with mode=allow;
    // re-pin the mode to abstain for this resolve.
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "abstain" } },
      });
      const out = await cli([
        "--project", projectDir, "resolve", "T-auth-1",
        "--note", "shipped by bob", "--as", "bob",
      ]);
      assert.equal(out.node.status, "done");
      assert.equal(out.node.done_by, "bob");
      assert.equal(out.node.note, "shipped by bob");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-resolve: owner resolves with no policy installed (defaults core)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    // No fixture installed → defaults core handles the resolve.
    await cli(["--project", projectDir, "take", "T-auth-1", "--as", "alice"]);
    const out = await cli([
      "--project", projectDir, "resolve", "T-auth-1",
      "--note", "done", "--as", "alice",
    ]);
    assert.equal(out.node.status, "done");
    assert.equal(out.node.done_by, "alice");
    assert.equal(out.node.note, "done");
    assert.equal(out.node.claim, null);
  });
});

test("seam-resolve: owner resolves with policy allow (seam runs, allow, resolve)", async () => {
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
        "--project", projectDir, "resolve", "T-auth-1",
        "--note", "shipped", "--as", "alice",
      ]);
      assert.equal(out.node.status, "done");
      assert.equal(out.node.done_by, "alice");
      assert.equal(out.node.note, "shipped");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-resolve: owner resolves with policy deny returns POLICY_DENIED with no state mutation", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installAndTake(projectDir, "alice");
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "deny", reason: "blocked" } },
      });
      const before = await readState(projectDir);
      const result = await runCli([
        "--project", projectDir, "resolve", "T-auth-1",
        "--note", "should not happen", "--as", "alice",
      ]);
      assert.equal(result.code, 1);
      const data = JSON.parse(result.stdout);
      assert.equal(data.ok, false);
      assert.equal(data.error.code, "POLICY_DENIED");
      assert.equal(data.error.details.action, "task.resolve");
      assert.equal(data.error.details.actor, "alice");
      const after = await readState(projectDir);
      assert.equal(after.nodes["T-auth-1"].status, "in_progress");
      assert.equal(after.nodes["T-auth-1"].revision, before.nodes["T-auth-1"].revision);
      const resolveEntries = after.log.filter((e) => e.action === "resolve");
      assert.equal(resolveEntries.length, 0);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-resolve: owner resolves with policy abstain (defaults core resolves for owner)", async () => {
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
        "--project", projectDir, "resolve", "T-auth-1",
        "--note", "ok", "--as", "alice",
      ]);
      assert.equal(out.node.status, "done");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});
*/

// ===========================================================================
// release: allow / deny / abstain / throw
// ===========================================================================

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
      const releaseEntries = after.log.filter((e) => e.action === "release");
      assert.equal(releaseEntries.length, 0);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-release: non-owner with policy abstain succeeds (defaults core proceeds)", async () => {
  // ADR-009 §"Resto de operaciones": with abstain, the default core
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
      const releaseEntries = after.log.filter((e) => e.action === "release");
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

// ===========================================================================
// reopen: allow / deny / abstain / throw
// ===========================================================================

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
      assert.equal(result.code, 1);
      const data = JSON.parse(result.stdout);
      assert.equal(data.ok, false);
      assert.equal(data.error.code, "POLICY_DENIED");
      assert.equal(data.error.details.action, "task.reopen");
      const after = await readState(projectDir);
      assert.equal(after.nodes["T-auth-1"].status, "done");
      assert.equal(after.nodes["T-auth-1"].revision, before.nodes["T-auth-1"].revision);
      const reopenEntries = after.log.filter((e) => e.action === "reopen");
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
      const reopenEntries = after.log.filter((e) => e.action === "reopen");
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

// ===========================================================================
// cancel: allow / deny / abstain / throw
// ===========================================================================

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
      const cancelEntries = after.log.filter((e) => e.action === "cancel");
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
      const cancelEntries = after.log.filter((e) => e.action === "cancel");
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

// ===========================================================================
// add-note: note.add (allow / deny / abstain; deny short-circuits before updateState)
// ===========================================================================

test("seam-add-note: note.add with no policy installed succeeds (defaults core)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    const out = await cli([
      "--project", projectDir, "add-note", "T-auth-1",
      "context note", "--as", "alice",
    ]);
    assert.ok(Array.isArray(out.node.notes));
    assert.equal(out.node.notes.length, 1);
    assert.equal(out.node.notes[0].text, "context note");
  });
});

test("seam-add-note: policy deny short-circuits BEFORE updateState (no notes appended, no log)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "deny", reason: "no notes" } },
      });
      const before = await readState(projectDir);
      const beforeRev = before.nodes["T-auth-1"].revision;
      const result = await runCli([
        "--project", projectDir, "add-note", "T-auth-1",
        "should not appear", "--as", "alice",
      ]);
      assert.equal(result.code, 1);
      const data = JSON.parse(result.stdout);
      assert.equal(data.ok, false);
      assert.equal(data.error.code, "POLICY_DENIED");
      assert.equal(data.error.details.action, "note.add");
      assert.equal(data.error.details.actor, "alice");
      const after = await readState(projectDir);
      // No notes appended.
      assert.equal((after.nodes["T-auth-1"].notes || []).length, 0);
      // No state mutation: revision unchanged, claim/status intact.
      assert.equal(after.nodes["T-auth-1"].revision, beforeRev);
      // No log entry for the rejected note.
      const noteEntries = after.log.filter((e) => e.action === "add-note");
      assert.equal(noteEntries.length, 0);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-add-note: policy allow appends the note and logs it", async () => {
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
        "--project", projectDir, "add-note", "T-auth-1",
        "audit", "--as", "alice",
      ]);
      assert.equal(out.node.notes.length, 1);
      assert.equal(out.node.notes[0].text, "audit");
      const s = await readState(projectDir);
      const noteEntries = s.log.filter((e) => e.action === "add-note");
      assert.equal(noteEntries.length, 1);
      assert.equal(noteEntries[0].node, "T-auth-1");
      assert.equal(noteEntries[0].agent, "alice");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-add-note: policy abstain falls back to defaults core (note appended)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "abstain" } },
      });
      const out = await cli([
        "--project", projectDir, "add-note", "T-auth-1",
        "ok", "--as", "alice",
      ]);
      assert.equal(out.node.notes.length, 1);
      assert.equal(out.node.notes[0].text, "ok");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

// ===========================================================================
// add-initiative: initiative.create (allow / deny / abstain; deny short-circuits before updateState)
// ===========================================================================

test("seam-add-initiative: initiative.create with no policy installed succeeds and preserves auto-create", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    // Bootstrap path: no init, no state file. add-initiative must
    // auto-create the state via updateState and register the
    // initiative. The seam receives an emptyState() snapshot so a
    // plugin that only inspects shape sees a valid input.
    const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
    const out = await addInit({
      statePath: projectDir,
      flags: { desc: "the big move", as: "setup" },
      positional: ["bootstrap"],
    });
    assert.equal(out.initiative.name, "bootstrap");
    assert.ok(out.initiative.created_at);
    assert.equal(await stateExists(projectDir), true, "state file must be created on success");
    const s = await readState(projectDir);
    assert.equal(s.initiatives.bootstrap.desc, "the big move");
    const initEntries = s.log.filter((e) => e.action === "add-initiative");
    assert.equal(initEntries.length, 1);
    assert.equal(initEntries[0].agent, "setup");
    assert.equal(initEntries[0].node, "bootstrap");
    assert.equal(initEntries[0].plugin_id, undefined);
  });
});

test("seam-add-initiative: policy deny short-circuits BEFORE updateState (no state file, no log)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    // No state, no init. install the fixture and configure deny.
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "deny", reason: "no bootstrap" } },
      });
      const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
      let caught;
      try {
        await addInit({
          statePath: projectDir,
          flags: { desc: "should not stick", as: "setup" },
          positional: ["blocked"],
        });
      } catch (e) { caught = e; }
      assert.ok(caught, "should have thrown POLICY_DENIED");
      assert.equal(caught.code, "POLICY_DENIED");
      assert.equal(caught.details.action, "initiative.create");
      assert.equal(caught.details.actor, "setup");
      // No state file created.
      assert.equal(await stateExists(projectDir), false, "deny must NOT auto-create state");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-add-initiative: policy allow registers the initiative and writes a log entry (no plugin_id for CLI)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "allow" } },
      });
      const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
      const out = await addInit({
        statePath: projectDir,
        flags: { desc: "allowed", as: "setup" },
        positional: ["allowed"],
      });
      assert.equal(out.initiative.name, "allowed");
      const s = await readState(projectDir);
      assert.equal(s.initiatives.allowed.desc, "allowed");
      const initEntries = s.log.filter((e) => e.action === "add-initiative");
      assert.equal(initEntries.length, 1);
      assert.equal(initEntries[0].node, "allowed");
      // CLI call (no pluginId) — plugin_id MUST NOT be added.
      assert.equal(initEntries[0].plugin_id, undefined);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-add-initiative: pluginId null (CLI path) does NOT add plugin_id to the log entry", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    // No fixture → defaults core. We still want to assert that the
    // CLI path (no pluginId, pluginId=null/undefined) does NOT inject
    // plugin_id into the log entry — the seam contract from
    // ADR-006 §"Locks y logs" requires appendWithContext to omit
    // plugin_id when ctx.pluginId is not a non-empty string.
    const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
    await addInit({
      statePath: projectDir,
      flags: { desc: "cli", as: "setup" },
      positional: ["cli"],
    });
    await addInit({
      statePath: projectDir,
      flags: { desc: "cli-explicit-null", as: "setup" },
      positional: ["cli-explicit-null"],
      pluginId: null,
    });
    const s = await readState(projectDir);
    const initEntries = s.log.filter((e) => e.action === "add-initiative");
    assert.equal(initEntries.length, 2);
    for (const entry of initEntries) {
      assert.equal(entry.plugin_id, undefined, `unexpected plugin_id on log entry: ${JSON.stringify(entry)}`);
    }
  });
});

test("seam-add-initiative: policy allow with ctx.pluginId writes plugin_id to the log entry", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "allow" } },
      });
      const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
      await addInit({
        statePath: projectDir,
        flags: { desc: "audit", as: "setup" },
        positional: ["audit"],
        pluginId: "example.audit",
      });
      const s = await readState(projectDir);
      const initEntries = s.log.filter((e) => e.action === "add-initiative");
      assert.equal(initEntries.length, 1);
      assert.equal(initEntries[0].plugin_id, "example.audit");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-add-initiative: policy abstain (allow-and-decline) registers the initiative", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "abstain" } },
      });
      const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
      const out = await addInit({
        statePath: projectDir,
        flags: { desc: "abstain", as: "setup" },
        positional: ["abstain"],
      });
      assert.equal(out.initiative.name, "abstain");
      const s = await readState(projectDir);
      assert.equal(s.initiatives.abstain.desc, "abstain");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-add-initiative: deny-after-existing-state does not remove the previous initiative", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    // Bootstrap first so the state exists. Pre-write project meta
    // (with canonical project_id) BEFORE addInit so the state path
    // stays stable for the rest of the test.
    await baseClimierJson(projectDir);
    const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
    await addInit({
      statePath: projectDir,
      flags: { desc: "first", as: "setup" },
      positional: ["first"],
    });
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "deny", reason: "no second" } },
      });
      let caught;
      try {
        await addInit({
          statePath: projectDir,
          flags: { desc: "second", as: "setup" },
          positional: ["second"],
        });
      } catch (e) { caught = e; }
      assert.ok(caught);
      assert.equal(caught.code, "POLICY_DENIED");
      // First initiative survives.
      const s = await readState(projectDir);
      assert.equal(s.initiatives.first.desc, "first");
      assert.equal(s.initiatives.second, undefined);
      // Exactly one add-initiative log entry (the first one); the
      // denied call did not log.
      const initEntries = s.log.filter((e) => e.action === "add-initiative");
      assert.equal(initEntries.length, 1);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});