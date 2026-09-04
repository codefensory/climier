// F11 — v2 lifecycle: release, submit/accept, gate resolve, reopen, cancel.
//
// Pins the behaviors the design doc requires of v2 lifecycle commands:
//   - release: any actor (or a policy that explicitly denies); idempotent
//     on a node with no claim (no seam invocation).
//   - submit + accept: tasks move from `in_progress` to `done` through the
//     validation lifecycle; submit requires a delivery note.
//   - resolve: gates move to `resolved` with a choice and rationale; returns
//     newly_ready computed as the diff of deriveV2().ready before/after.
//   - reopen: any actor; re-opens to `open` and clears the claim plus all
//     submission/acceptance/completion metadata, which re-blocks downstream tasks.
//   - cancel: open/in_progress/submitted + any actor (or a policy that
//     explicitly denies); done/resolved tasks return INVALID_STATUS.
//
// T-plugin-policy-minimal-core-handlers / ADR-009: the historical
// owner-invariant assertions (NOT_OWNER for non-owner release /
// reopen / cancel) were inverted: with no policy, the default core lets
// any actor mutate, and the tests verify the mutation envelope
// (done_by / last log entry / claim cleared). The `policy allow` paths
// still cover the seam; policy deny/abstain coverage lives in
// plugin-policy-seam-lifecycle.

import { test } from "node:test";
import { deriveV2 } from "../src/providers/task/derivation.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  runCli,
  readState,
  installPolicyFixture,
  uninstallPolicyFixture,
  writeState,
} from "./helpers.mjs";

async function v2Project() {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
  const dir = await createTempProject();
  await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
  await addInit({ statePath: dir, flags: { desc: "auth" }, positional: ["auth"] });
  return dir;
}

async function addTask(dir, id, extra = {}) {
  const { default: addNode } = await importFresh("./cli/commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: {
      kind: "resolvable",
      subkind: "task",
      title: extra.title || id,
      initiative: "auth",
      domain: extra.domain,
      tags: extra.tags,
      ...extra,
    },
  });
}

async function addGate(dir, id, extra = {}) {
  const { default: addNode } = await importFresh("./cli/commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: {
      kind: "resolvable",
      subkind: "gate",
      title: extra.title || id,
      initiative: "auth",
      purpose: extra.purpose || "decision",
      ...extra,
    },
  });
}

async function take(dir, as, id = "T-auth-1") {
  const { default: takeCmd } = await importFresh("./cli/commands/take.mjs");
  return takeCmd({ statePath: dir, flags: { as }, positional: [id], projectDir: dir });
}

async function submitAccept(dir, id = "T-auth-1", as = "alice", note = "shipped") {
  const { default: submit } = await importFresh("./cli/commands/submit.mjs");
  const { default: accept } = await importFresh("./cli/commands/accept.mjs");
  await submit({ statePath: dir, flags: { as, note }, positional: [id], projectDir: dir });
  return accept({ statePath: dir, flags: { as }, positional: [id], projectDir: dir });
}

async function patchNode(dir, id, patch) {
  const state = await readState(dir);
  state.nodes[id] = { ...state.nodes[id], ...patch };
  await writeState(dir, state);
}

// === take ===============================================================

test("v2-take: submitted task cannot be taken", async () => {
  const { default: takeCmd } = await importFresh("./cli/commands/take.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    await patchNode(dir, "T-auth-1", { status: "submitted", claim: null });

    let caught;
    try {
      await takeCmd({ statePath: dir, flags: { as: "alice" }, positional: ["T-auth-1"] });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, "NOT_READY");
    assert.equal(caught.details.status, "submitted");
  } finally { await rmTempProject(dir); }
});

// === release ============================================================

test("v2-release: claim owner releases; returns released=true, claim=null, status=open, revision bumped", async () => {
  const { default: release } = await importFresh("./cli/commands/release.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    await take(dir, "alice");
    const out = await release({
      statePath: dir,
      flags: { as: "alice" },
      positional: ["T-auth-1"],
    });
    assert.equal(out.released, true);
    assert.equal(out.node.claim, null);
    assert.equal(out.node.status, "open");
    // revision: 1 (init) -> 2 (take) -> 3 (release)
    assert.equal(out.node.revision, 3);

    const s = await readState(dir);
    assert.equal(s.nodes["T-auth-1"].claim, null);
    assert.equal(s.nodes["T-auth-1"].status, "open");
    const last = s.log.at(-1);
    assert.equal(last.action, "release");
    assert.equal(last.agent, "alice");
    assert.equal(last.node, "T-auth-1");
  } finally { await rmTempProject(dir); }
});

test("v2-release: any actor may release another agent's claim with no policy (defaults core)", async () => {
  // ADR-009 §"Resto de operaciones": the core no longer compares the
  // actor against the claim owner. Without a policy plugin, any actor
  // with --as may release a claimed task. A policy plugin may still
  // deny the action.
  const { default: release } = await importFresh("./cli/commands/release.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    await take(dir, "alice");
    const out = await release({
      statePath: dir,
      flags: { as: "bob" },
      positional: ["T-auth-1"],
    });
    assert.equal(out.released, true);
    assert.equal(out.node.claim, null);
    assert.equal(out.node.status, "open");
    const s = await readState(dir);
    const last = s.log.at(-1);
    assert.equal(last.action, "release");
    assert.equal(last.agent, "bob");
    assert.equal(last.node, "T-auth-1");
  } finally { await rmTempProject(dir); }
});

test("v2-release: any agent may release another agent's claim when policy allow applies", async () => {
  // T-plugin-policy-seam-lifecycle / ADR-008: the historical
  // orchestrator/recovery bypass is replaced by a policy seam allow.
  const { default: release } = await importFresh("./cli/commands/release.mjs");
  const dir = await v2Project();
  await installPolicyFixture(dir);
  try {
    await addTask(dir, "T-auth-1");
    await take(dir, "alice");
    const out = await release({
      statePath: dir,
      flags: { as: "recovery-agent" },
      positional: ["T-auth-1"],
    });
    assert.equal(out.released, true);
    assert.equal(out.node.claim, null);
    assert.equal(out.node.status, "open");
  } finally {
    await uninstallPolicyFixture(dir);
    await rmTempProject(dir);
  }
});

test("v2-release: a policy-allow actor can release any agent's claim (ex-recovery role equivalent)", async () => {
  // T-plugin-policy-seam-lifecycle / ADR-008: the historical
  // recovery-bypass path is replaced by a policy seam allow.
  const { default: release } = await importFresh("./cli/commands/release.mjs");
  const dir = await v2Project();
  await installPolicyFixture(dir);
  try {
    await addTask(dir, "T-auth-1");
    await take(dir, "alice");
    const out = await release({
      statePath: dir,
      flags: { as: "second-admin" },
      positional: ["T-auth-1"],
    });
    assert.equal(out.released, true);
  } finally {
    await uninstallPolicyFixture(dir);
    await rmTempProject(dir);
  }
});

test("v2-release: idempotent — a task with no claim returns released=false without mutating", async () => {
  const { default: release } = await importFresh("./cli/commands/release.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    const before = (await readState(dir)).nodes["T-auth-1"].revision;
    const out = await release({
      statePath: dir,
      flags: { as: "alice" },
      positional: ["T-auth-1"],
    });
    assert.equal(out.released, false);
    assert.ok(!out.node.claim, "claim must be falsy");
    assert.equal(out.node.revision, before);
    // No log entry appended.
    const s = await readState(dir);
    assert.equal(s.log.filter((e) => e.action === "release").length, 0);
  } finally { await rmTempProject(dir); }
});

test("v2-release: idempotent — re-releasing a previously-released task is still released=false", async () => {
  const { default: release } = await importFresh("./cli/commands/release.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    await take(dir, "alice");
    await release({ statePath: dir, flags: { as: "alice" }, positional: ["T-auth-1"] });
    const out = await release({
      statePath: dir,
      flags: { as: "alice" },
      positional: ["T-auth-1"],
    });
    assert.equal(out.released, false);
    assert.equal(out.node.claim, null);
    assert.equal(out.node.status, "open");
  } finally { await rmTempProject(dir); }
});

test("v2-release: submitted task cannot be released", async () => {
  const { default: release } = await importFresh("./cli/commands/release.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    await patchNode(dir, "T-auth-1", { status: "submitted", claim: null });

    let caught;
    try {
      await release({ statePath: dir, flags: { as: "alice" }, positional: ["T-auth-1"] });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, "INVALID_STATUS");
    assert.equal(caught.details.current, "submitted");
    assert.deepEqual(caught.details.allowed, ["open", "in_progress"]);
  } finally { await rmTempProject(dir); }
});

test("v2-release: missing node returns NODE_NOT_FOUND", async () => {
  const { default: release } = await importFresh("./cli/commands/release.mjs");
  const dir = await v2Project();
  try {
    let caught;
    try {
      await release({
        statePath: dir,
        flags: { as: "alice" },
        positional: ["ghost"],
      });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, "NODE_NOT_FOUND");
    assert.equal(caught.details.id, "ghost");
  } finally { await rmTempProject(dir); }
});

test("v2-release: missing --as returns MISSING_AGENT", async () => {
  const { default: release } = await importFresh("./cli/commands/release.mjs");
  const dir = await v2Project();
  const prev = process.env.CLIMIER_AGENT;
  delete process.env.CLIMIER_AGENT;
  try {
    // Seed the task with an explicit --as so add-node doesn't trip the
    // missing-agent check before the release assertion runs.
    await addTask(dir, "T-auth-1", { as: "seeder" });
    let caught;
    try {
      await release({ statePath: dir, flags: {}, positional: ["T-auth-1"] });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, "MISSING_AGENT");
  } finally {
    if (prev === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prev;
    await rmTempProject(dir);
  }
});

// === resolve ============================================================

test("v2-resolve: task targets are rejected; accept is the done transition", async () => {
  const { default: resolve } = await importFresh("./cli/commands/resolve.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    await take(dir, "alice");
    let caught;
    try { await resolve({ statePath: dir, flags: { as: "alice", note: "done" }, positional: ["T-auth-1"] }); } catch (e) { caught = e; }
    assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
    assert.equal((await readState(dir)).nodes["T-auth-1"].status, "in_progress");
  } finally { await rmTempProject(dir); }
});

test("v2-resolve: gate resolve — --choice and --rationale required, status=resolved, resolution set", async () => {
  const { default: resolve } = await importFresh("./cli/commands/resolve.mjs");
  const dir = await v2Project();
  try {
    await addGate(dir, "G-auth-v2");
    const out = await resolve({
      statePath: dir,
      flags: { as: "test-agent", choice: "opaque sessions", rationale: "immediate revocation" },
      positional: ["G-auth-v2"],
    });
    assert.equal(out.node.status, "resolved");
    assert.equal(out.node.resolution.choice, "opaque sessions");
    assert.equal(out.node.resolution.rationale, "immediate revocation");
    assert.equal(out.node.revision, 2);
    assert.deepEqual(out.newly_ready, []);

    const s = await readState(dir);
    const last = s.log.at(-1);
    assert.equal(last.action, "resolve");
    assert.equal(last.agent, "test-agent");
    assert.equal(last.choice, "opaque sessions");
    assert.equal(last.rationale, "immediate revocation");
  } finally { await rmTempProject(dir); }
});

test("v2-resolve: gate resolve missing --choice returns MISSING_FIELD", async () => {
  const { default: resolve } = await importFresh("./cli/commands/resolve.mjs");
  const dir = await v2Project();
  try {
    await addGate(dir, "G-auth-v2");
    let caught;
    try {
      await resolve({
        statePath: dir,
        flags: { as: "test-agent", rationale: "x" },
        positional: ["G-auth-v2"],
      });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, "MISSING_FIELD");
    assert.equal(caught.details.field, "choice");
  } finally { await rmTempProject(dir); }
});

test("v2-resolve: gate resolve missing --rationale returns MISSING_FIELD", async () => {
  const { default: resolve } = await importFresh("./cli/commands/resolve.mjs");
  const dir = await v2Project();
  try {
    await addGate(dir, "G-auth-v2");
    let caught;
    try {
      await resolve({
        statePath: dir,
        flags: { as: "test-agent", choice: "x" },
        positional: ["G-auth-v2"],
      });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, "MISSING_FIELD");
    assert.equal(caught.details.field, "rationale");
  } finally { await rmTempProject(dir); }
});

test("v2-resolve: missing node returns NODE_NOT_FOUND", async () => {
  const { default: resolve } = await importFresh("./cli/commands/resolve.mjs");
  const dir = await v2Project();
  try {
    let caught;
    try {
      await resolve({
        statePath: dir,
        flags: { as: "alice", choice: "x", rationale: "missing" },
        positional: ["ghost"],
      });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, "NODE_NOT_FOUND");
    assert.equal(caught.details.id, "ghost");
  } finally { await rmTempProject(dir); }
});

// === reopen =============================================================

test("v2-reopen: original done_by can reopen a done task; status -> open, claim cleared, done_* removed", async () => {
  const { default: reopen } = await importFresh("./cli/commands/reopen.mjs");
  const { default: resolve } = await importFresh("./cli/commands/resolve.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    await take(dir, "alice");
    await submitAccept(dir, "T-auth-1", "alice", "shipped");
    await patchNode(dir, "T-auth-1", {
      submitted_by: "alice",
      submitted_at: "2026-08-31T07:00:00.000Z",
      accepted_by: "auditor",
      accepted_at: "2026-08-31T07:01:00.000Z",
    });

    const out = await reopen({
      statePath: dir,
      flags: { as: "alice", reason: "tests failed in staging" },
      positional: ["T-auth-1"],
    });
    assert.equal(out.node.status, "open");
    assert.equal(out.node.claim, null);
    assert.equal(out.node.done_by, undefined);
    assert.equal(out.node.done_at, undefined);
    assert.equal(out.node.submitted_by, null);
    assert.equal(out.node.submitted_at, null);
    assert.equal(out.node.accepted_by, null);
    assert.equal(out.node.accepted_at, null);
    assert.equal(out.node.revision, 5);

    const s = await readState(dir);
    const last = s.log.at(-1);
    assert.equal(last.action, "reopen");
    assert.equal(last.agent, "alice");
    assert.equal(last.note, "tests failed in staging");
  } finally { await rmTempProject(dir); }
});

test("v2-reopen: any agent may reopen a done task when policy allow applies", async () => {
  // T-plugin-policy-seam-lifecycle / ADR-008: the historical
  // orchestrator-reopen bypass is replaced by a policy seam allow.
  const { default: reopen } = await importFresh("./cli/commands/reopen.mjs");
  const { default: resolve } = await importFresh("./cli/commands/resolve.mjs");
  const dir = await v2Project();
  await installPolicyFixture(dir);
  try {
    await addTask(dir, "T-auth-1");
    await take(dir, "alice");
    await submitAccept(dir, "T-auth-1", "alice", "shipped");

    const out = await reopen({
      statePath: dir,
      flags: { as: "auditor", reason: "auditing" },
      positional: ["T-auth-1"],
    });
    assert.equal(out.node.status, "open");
    assert.equal(out.node.claim, null);
  } finally {
    await uninstallPolicyFixture(dir);
    await rmTempProject(dir);
  }
});

test("v2-reopen: any actor may reopen a done task with no policy (defaults core)", async () => {
  // ADR-009 §"Resto de operaciones": the core does not compare the
  // actor against done_by. Without a policy plugin, any actor with
  // --as may reopen a task in a terminal reopenable state. done_by /
  // done_at / note are cleared exactly as before.
  const { default: reopen } = await importFresh("./cli/commands/reopen.mjs");
  const { default: resolve } = await importFresh("./cli/commands/resolve.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    await take(dir, "alice");
    await submitAccept(dir, "T-auth-1", "alice", "shipped");

    const out = await reopen({
      statePath: dir,
      flags: { as: "bob", reason: "tests failed in staging" },
      positional: ["T-auth-1"],
    });
    assert.equal(out.node.status, "open");
    assert.equal(out.node.claim, null);
    assert.equal(out.node.done_by, undefined);
    assert.equal(out.node.done_at, undefined);
    const s = await readState(dir);
    const last = s.log.at(-1);
    assert.equal(last.action, "reopen");
    assert.equal(last.agent, "bob");
    assert.equal(last.note, "tests failed in staging");
  } finally { await rmTempProject(dir); }
});

test("v2-reopen: re-blocks downstream tasks (DAG consequence)", async () => {
  const { default: reopen } = await importFresh("./cli/commands/reopen.mjs");
  const { default: resolve } = await importFresh("./cli/commands/resolve.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-blocker");
    await addTask(dir, "T-down", { "blocked-by": "T-blocker" });
    await take(dir, "alice", "T-blocker");
    await submitAccept(dir, "T-blocker", "alice", "done");

    let d = deriveV2(await readState(dir));
    assert.ok(d.ready.includes("T-down"), "T-down should be ready before reopen");

    await reopen({
      statePath: dir,
      flags: { as: "alice", reason: "rollback" },
      positional: ["T-blocker"],
    });

    d = deriveV2(await readState(dir));
    assert.equal(d.ready.includes("T-down"), false, "T-down must not be ready after reopen");
    assert.ok(d.blocked.includes("T-down"), "T-down must be blocked after reopen");
  } finally { await rmTempProject(dir); }
});

test("v2-reopen: missing --reason returns MISSING_FIELD", async () => {
  const { default: reopen } = await importFresh("./cli/commands/reopen.mjs");
  const { default: resolve } = await importFresh("./cli/commands/resolve.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    await take(dir, "alice");
    await submitAccept(dir, "T-auth-1", "alice", "shipped");

    let caught;
    try {
      await reopen({
        statePath: dir,
        flags: { as: "alice" },
        positional: ["T-auth-1"],
      });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, "MISSING_FIELD");
    assert.equal(caught.details.field, "reason");
  } finally { await rmTempProject(dir); }
});

test("v2-reopen: not-done node returns INVALID_STATUS", async () => {
  const { default: reopen } = await importFresh("./cli/commands/reopen.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    let caught;
    try {
      await reopen({
        statePath: dir,
        flags: { as: "test-agent", reason: "x" },
        positional: ["T-auth-1"],
      });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, "INVALID_STATUS");
    assert.equal(caught.details.expected, "done");
  } finally { await rmTempProject(dir); }
});

test("v2-reopen: missing node returns NODE_NOT_FOUND", async () => {
  const { default: reopen } = await importFresh("./cli/commands/reopen.mjs");
  const dir = await v2Project();
  try {
    let caught;
    try {
      await reopen({
        statePath: dir,
        flags: { as: "test-agent", reason: "x" },
        positional: ["ghost"],
      });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, "NODE_NOT_FOUND");
  } finally { await rmTempProject(dir); }
});

// === cancel =============================================================

test("v2-cancel: in_progress + claim owner => status=canceled, claim cleared, log appended", async () => {
  const { default: cancel } = await importFresh("./cli/commands/cancel.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    await take(dir, "alice");
    const out = await cancel({
      statePath: dir,
      flags: { as: "alice", reason: "out of scope" },
      positional: ["T-auth-1"],
    });
    assert.equal(out.node.status, "canceled");
    assert.equal(out.node.claim, null);
    assert.equal(out.node.revision, 3);

    const s = await readState(dir);
    const last = s.log.at(-1);
    assert.equal(last.action, "cancel");
    assert.equal(last.agent, "alice");
    assert.equal(last.note, "out of scope");
  } finally { await rmTempProject(dir); }
});

test("v2-cancel: open + policy-allow actor => canceled (no claim required)", async () => {
  // T-plugin-policy-seam-lifecycle / ADR-008: the historical
  // orchestrator-bypass on an unclaimed node is replaced by a policy
  // seam allow.
  const { default: cancel } = await importFresh("./cli/commands/cancel.mjs");
  const dir = await v2Project();
  await installPolicyFixture(dir);
  try {
    await addTask(dir, "T-auth-1");
    const out = await cancel({
      statePath: dir,
      flags: { as: "release-manager", reason: "no longer needed" },
      positional: ["T-auth-1"],
    });
    assert.equal(out.node.status, "canceled");
    assert.equal(out.node.claim, null);
  } finally {
    await uninstallPolicyFixture(dir);
    await rmTempProject(dir);
  }
});

test("v2-cancel: any actor may cancel an open task with no policy (defaults core)", async () => {
  // ADR-009 §"Resto de operaciones": the core does not require the actor
  // to be the claim owner. Without a policy plugin, any actor with --as
  // may cancel an open node.
  const { default: cancel } = await importFresh("./cli/commands/cancel.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    const out = await cancel({
      statePath: dir,
      flags: { as: "alice", reason: "no longer needed" },
      positional: ["T-auth-1"],
    });
    assert.equal(out.node.status, "canceled");
    assert.equal(out.node.claim, null);
    const s = await readState(dir);
    const last = s.log.at(-1);
    assert.equal(last.action, "cancel");
    assert.equal(last.agent, "alice");
    assert.equal(last.note, "no longer needed");
  } finally { await rmTempProject(dir); }
});

test("v2-cancel: any actor may cancel an in_progress task with no policy (defaults core)", async () => {
  // ADR-009 §"Resto de operaciones": the core does not require the actor
  // to be the claim owner. Without a policy plugin, any actor with --as
  // may cancel an in_progress node, including a third party that never
  // claimed the task.
  const { default: cancel } = await importFresh("./cli/commands/cancel.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    await take(dir, "alice");
    const out = await cancel({
      statePath: dir,
      flags: { as: "bob", reason: "out of scope" },
      positional: ["T-auth-1"],
    });
    assert.equal(out.node.status, "canceled");
    assert.equal(out.node.claim, null);
    const s = await readState(dir);
    const last = s.log.at(-1);
    assert.equal(last.action, "cancel");
    assert.equal(last.agent, "bob");
  } finally { await rmTempProject(dir); }
});

test("v2-cancel: submitted task becomes canceled and remains an unsatisfied blocker", async () => {
  const { default: cancel } = await importFresh("./cli/commands/cancel.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    await addTask(dir, "T-down", { "blocked-by": "T-auth-1" });
    await patchNode(dir, "T-auth-1", {
      status: "submitted",
      claim: null,
      submitted_by: "alice",
      submitted_at: "2026-08-31T07:00:00.000Z",
    });

    const out = await cancel({
      statePath: dir,
      flags: { as: "bob", reason: "submission abandoned" },
      positional: ["T-auth-1"],
    });
    assert.equal(out.node.status, "canceled");
    assert.equal(out.node.claim, null);
    assert.equal(out.node.submitted_by, "alice");
    const derived = deriveV2(await readState(dir));
    assert.ok(derived.blocked.includes("T-down"));
    assert.equal(derived.ready.includes("T-down"), false);
  } finally { await rmTempProject(dir); }
});

test("v2-cancel: done task returns INVALID_STATUS (cannot cancel terminal)", async () => {
  const { default: cancel } = await importFresh("./cli/commands/cancel.mjs");
  const { default: resolve } = await importFresh("./cli/commands/resolve.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    await take(dir, "alice");
    await submitAccept(dir, "T-auth-1", "alice", "shipped");
    let caught;
    try {
      await cancel({
        statePath: dir,
        flags: { as: "test-agent", reason: "x" },
        positional: ["T-auth-1"],
      });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, "INVALID_STATUS");
    assert.deepEqual(caught.details.allowed, ["open", "in_progress", "submitted"]);
  } finally { await rmTempProject(dir); }
});

test("v2-cancel: missing --reason returns MISSING_FIELD", async () => {
  const { default: cancel } = await importFresh("./cli/commands/cancel.mjs");
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    let caught;
    try {
      await cancel({ statePath: dir, flags: { as: "test-agent" }, positional: ["T-auth-1"] });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, "MISSING_FIELD");
    assert.equal(caught.details.field, "reason");
  } finally { await rmTempProject(dir); }
});

test("v2-cancel: missing node returns NODE_NOT_FOUND", async () => {
  const { default: cancel } = await importFresh("./cli/commands/cancel.mjs");
  const dir = await v2Project();
  try {
    let caught;
    try {
      await cancel({
        statePath: dir,
        flags: { as: "test-agent", reason: "x" },
        positional: ["ghost"],
      });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, "NODE_NOT_FOUND");
  } finally { await rmTempProject(dir); }
});

// === CLI dispatch =======================================================

async function seedV1State(dir, state) {
  // Bootstrap a v1 state file directly (no need to run `init` first; we
  // just need the .climier.json to know the project id).
  const metaPath = path.join(dir, ".climier.json");
  let projectId;
  try {
    projectId = JSON.parse(await fs.readFile(metaPath, "utf8")).project_id;
  } catch {
    projectId = undefined;
  }
  if (!projectId) {
    const { default: init } = await importFresh("./cli/commands/init.mjs");
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    projectId = JSON.parse(await fs.readFile(metaPath, "utf8")).project_id;
  }
  const stateFile = path.join(process.env.CLIMIER_HOME, "projects", projectId, "tasks.json");
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
  return stateFile;
}

test("CLI: v2 release is routed to v2-release (clears claim, status=open)", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "auth", "--desc", "auth"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli([
      "--project", dir, "add-node", "T-auth-1",
      "--kind", "resolvable", "--subkind", "task", "--title", "t", "--initiative", "auth",
    ]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "take", "T-auth-1", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli(["--project", dir, "release", "T-auth-1", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.released, true);
    assert.equal(out.node.status, "open");
    assert.equal(out.node.claim, null);
  } finally { await rmTempProject(dir); }
});

test("CLI: v2 resolve is routed to v2-resolve and emits { node, newly_ready }", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "auth", "--desc", "auth"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli([
      "--project", dir, "add-gate", "G-auth-v2",
      "--initiative", "auth", "--title", "decide", "--body", "x",
      "--purpose", "decision",
    ]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli([
      "--project", dir, "add-node", "T-auth-1",
      "--kind", "resolvable", "--subkind", "task", "--title", "t", "--initiative", "auth",
      "--blocked-by", "G-auth-v2",
    ]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli([
      "--project", dir, "resolve", "G-auth-v2",
      "--choice", "opaque", "--rationale", "revocation",
      "--as", "test-agent",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.node.status, "resolved");
    assert.deepEqual(out.newly_ready, ["T-auth-1"]);
  } finally { await rmTempProject(dir); }
});

test("CLI: v2 reopen is routed to v2-reopen (status=open, claim cleared)", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "auth", "--desc", "auth"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli([
      "--project", dir, "add-node", "T-auth-1",
      "--kind", "resolvable", "--subkind", "task", "--title", "t", "--initiative", "auth",
    ]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "take", "T-auth-1", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli([
      "--project", dir, "submit", "T-auth-1",
      "--note", "shipped", "--as", "alice",
    ]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "accept", "T-auth-1", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli(["--project", dir, "reopen", "T-auth-1", "--reason", "rollback", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.node.status, "open");
    assert.equal(out.node.claim, null);
  } finally { await rmTempProject(dir); }
});

test("CLI: v2 cancel is routed to v2-cancel (status=canceled)", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "auth", "--desc", "auth"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli([
      "--project", dir, "add-node", "T-auth-1",
      "--kind", "resolvable", "--subkind", "task", "--title", "t", "--initiative", "auth",
    ]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "take", "T-auth-1", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli(["--project", dir, "cancel", "T-auth-1", "--reason", "out of scope", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.node.status, "canceled");
    assert.equal(out.node.claim, null);
  } finally { await rmTempProject(dir); }
});

test("CLI: v1 states are rejected with STATE_V1_UNSUPPORTED", async () => {
  // The v1 schema is no longer supported. v1 state files are rejected at
  // read time; the migration path is documented in the error message.
  const dir = await createTempProject();
  try {
    await seedV1State(dir, {
      version: 1,
      tasks: {
        T1: { id: "T1", title: "v1 done", status: "done", done_by: "alice" },
      },
      decisions: {}, gotchas: {}, initiatives: { migration: {} }, log: [],
    });

    const r = await runCli(["--project", dir, "status"]);
    assert.equal(r.code, 1, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.match(out.error.message || out.error, /version 1|STATE_V1_UNSUPPORTED|v2/i);
  } finally { await rmTempProject(dir); }
});