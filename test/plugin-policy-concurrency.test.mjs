// T-plugin-policy-migration-tests — concurrency matrix for the policy seam.
//
// ADR-008 §"Seam por handler" requires the seam's authorize() to run
// INSIDE the handler's withLock block, so the lock is held for the
// full duration of the policy decision. Concurrent takes against the
// same CLIMIER_HOME / project state exercise:
//
//   1. Free take race           → two processes take the same task
//                                  concurrently; one wins the original
//                                  `task.take`, the other sees an
//                                  in_progress claim and turns into a
//                                  `task.takeover`. With mode=allow,
//                                  the takeover succeeds and the final
//                                  owner is the second process.
//   2. Takeover deny            → second process gets POLICY_DENIED,
//                                  no state mutation, no log entry.
//   3. Takeover abstain         → second process gets ALREADY_CLAIMED,
//                                  no state mutation, no log entry.
//   4. Slow policy under lock   → with mode=slow and a measurable
//                                  sleep, a concurrent take is blocked
//                                  at the lock until authorize returns,
//                                  proving the lock spans the seam.
//   5. previous_owner integrity → log records the previous_owner on
//                                  every successful takeover.
//   6. State integrity          → exactly one claim owner per node, no
//                                  interleaving, exactly one log entry
//                                  per state transition.
//
// All tests share a single CLIMIER_HOME across the parent + N children
// (per the seam-dag lifecycle contract) and never touch the real
// ~/.climier (helpers.mjs guard).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

import {
  createTempProject,
  rmTempProject,
  runCli,
  readState,
  installPolicyFixture,
  uninstallPolicyFixture,
  stateFilePath,
} from "./helpers.mjs";

const REPO_ROOT = path.resolve(".");
const BIN = path.join(REPO_ROOT, "bin", "climier.mjs");

// ---- Per-test environment -------------------------------------------

async function withFreshEnv(body) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-policy-conc-"));
  const projectDir = await createTempProject();
  const prev = {
    CLIMIER_HOME: process.env.CLIMIER_HOME,
    CLIMIER_AGENT: process.env.CLIMIER_AGENT,
  };
  process.env.CLIMIER_HOME = home;
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
        `stdout: ${result.stdout}\n` +
        `stderr: ${result.stderr}`,
    );
  }
  if (!result.stdout.trim()) return null;
  return JSON.parse(result.stdout);
}

async function writeClimierJson(projectDir, mode, extra = {}) {
  // project_id MUST be pinned before init so the state file lands in
  // <CLIMIER_HOME>/projects/<project_id>/tasks.json and both children
  // resolve to the same path (same as plugin-policy-seam-* helpers).
  const value = {
    version: 1,
    project_id: "policy-concurrency-project",
    plugins: { "policy-fixture": { mode, ...extra } },
  };
  await fs.writeFile(
    path.join(projectDir, ".climier.json"),
    JSON.stringify(value, null, 2) + "\n",
    "utf8",
  );
}

// spawnCli — fork a real bin child_process with the SAME CLIMIER_HOME
// and --project as the calling test. Returns { stdout, stderr, code }
// once the child exits. Errors here propagate so a child failure is a
// regression.
function spawnCli(args, { env } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let proc;
    try {
      proc = spawn("node", [BIN, ...args], {
        env: { ...process.env, ...(env || {}), NO_COLOR: "1" },
      });
    } catch (err) {
      reject(err);
      return;
    }
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

async function bootstrap(projectDir, mode, extra = {}) {
  await writeClimierJson(projectDir, mode, extra);
  await cli(["--project", projectDir, "init"]);
  await cli([
    "--project", projectDir, "--as", "setup",
    "add-initiative", "auth", "--desc", "auth",
  ]);
  await cli([
    "--project", projectDir, "--as", "setup",
    "add-node", "T-conc-1",
    "--kind", "resolvable", "--subkind", "task", "--title", "conc",
    "--initiative", "auth",
  ]);
  await installPolicyFixture(projectDir);
}

// ===========================================================================
// 1. Free take race: one wins task.take, the other transitions to task.takeover
// ===========================================================================

test("policy-concurrency: two concurrent takes — one wins task.take, the other sees task.takeover and (with allow) wins the claim", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await bootstrap(projectDir, "allow");

    const aliceArgs = [
      "--project", projectDir, "--as", "alice",
      "take", "T-conc-1",
    ];
    const bobArgs = [
      "--project", projectDir, "--as", "bob",
      "take", "T-conc-1",
    ];

    const [aliceRes, bobRes] = await Promise.all([
      spawnCli(aliceArgs),
      spawnCli(bobArgs),
    ]);

    // Both processes must finish — one is the original task.take winner,
    // the other is a task.takeover that the policy authorised.
    assert.equal(aliceRes.code, 0, `alice failed\nstdout: ${aliceRes.stdout}\nstderr: ${aliceRes.stderr}`);
    assert.equal(bobRes.code, 0, `bob failed\nstdout: ${bobRes.stdout}\nstderr: ${bobRes.stderr}`);

    // State integrity: exactly one claim owner per node.
    const s = await readState(projectDir);
    const claimEntries = s.log.filter((e) => e.action === "take" && e.node === "T-conc-1");
    assert.equal(claimEntries.length, 2, `expected 2 take entries, got ${claimEntries.length}`);
    assert.equal(s.nodes["T-conc-1"].claim.by === "alice" || s.nodes["T-conc-1"].claim.by === "bob", true);
    assert.equal(s.nodes["T-conc-1"].status, "in_progress");

    // previous_owner is set on the second take entry (takeover), never on
    // the first (free take). Exactly one entry has previous_owner set.
    const withPrev = claimEntries.filter((e) => e.previous_owner);
    assert.equal(withPrev.length, 1, `expected exactly 1 takeover entry with previous_owner, got ${withPrev.length}`);
    const takeoverEntry = withPrev[0];
    const firstEntry = claimEntries.find((e) => e !== takeoverEntry);
    assert.equal(firstEntry.previous_owner, undefined, "first take must not carry previous_owner");
    assert.equal(takeoverEntry.previous_owner, firstEntry.agent, "takeover previous_owner must equal the first take's agent");

    // Final owner is the second process (the one that did the takeover).
    assert.equal(s.nodes["T-conc-1"].claim.by, takeoverEntry.agent);
  });
});

// ===========================================================================
// 2. Takeover deny — second process gets POLICY_DENIED, no log entry
// ===========================================================================

test("policy-concurrency: takeover with policy deny returns POLICY_DENIED with no state mutation and no log entry", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await bootstrap(projectDir, "allow");
    // First, alice claims with policy=allow (so the take is recorded).
    await cli(["--project", projectDir, "take", "T-conc-1", "--as", "alice"]);
    // Now switch to deny for the bob takeover.
    await writeClimierJson(projectDir, "deny", { reason: "no takeover" });

    const before = await readState(projectDir);

    const bobRes = await spawnCli([
      "--project", projectDir, "--as", "bob",
      "take", "T-conc-1",
    ]);

    assert.equal(bobRes.code, 1, `bob must fail\nstdout: ${bobRes.stdout}\nstderr: ${bobRes.stderr}`);
    const body = JSON.parse(bobRes.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "POLICY_DENIED");
    assert.equal(body.error.details.action, "task.takeover");
    assert.equal(body.error.details.actor, "bob");

    const after = await readState(projectDir);
    assert.equal(after.nodes["T-conc-1"].claim.by, "alice", "claim must remain with alice");
    assert.equal(
      after.nodes["T-conc-1"].revision,
      before.nodes["T-conc-1"].revision,
      "revision must not change when deny short-circuits",
    );

    const takeEntries = after.log.filter((e) => e.action === "take" && e.node === "T-conc-1");
    assert.equal(takeEntries.length, 1, `expected 1 take entry (alice's), got ${takeEntries.length}`);

    // The deny decision MUST NOT add a success log entry. The only log
    // entry added during the deny should be a single 'take' from alice.
    const bobLogEntries = after.log.filter((e) => e.agent === "bob");
    assert.equal(bobLogEntries.length, 0, `deny must not add any log entry for bob; got ${JSON.stringify(bobLogEntries)}`);
  });
});

// ===========================================================================
// 3. Takeover abstain — second process gets ALREADY_CLAIMED, no log entry
// ===========================================================================

test("policy-concurrency: takeover with policy abstain returns ALREADY_CLAIMED with no state mutation and no log entry", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await bootstrap(projectDir, "allow");
    await cli(["--project", projectDir, "take", "T-conc-1", "--as", "alice"]);
    await writeClimierJson(projectDir, "abstain");

    const before = await readState(projectDir);

    const bobRes = await spawnCli([
      "--project", projectDir, "--as", "bob",
      "take", "T-conc-1",
    ]);

    assert.equal(bobRes.code, 1, `bob must fail\nstdout: ${bobRes.stdout}\nstderr: ${bobRes.stderr}`);
    const body = JSON.parse(bobRes.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "ALREADY_CLAIMED");
    assert.equal(body.error.details.owner, "alice");

    const after = await readState(projectDir);
    assert.equal(after.nodes["T-conc-1"].claim.by, "alice");
    assert.equal(after.nodes["T-conc-1"].revision, before.nodes["T-conc-1"].revision);

    const takeEntries = after.log.filter((e) => e.action === "take" && e.node === "T-conc-1");
    assert.equal(takeEntries.length, 1);
    const bobLogEntries = after.log.filter((e) => e.agent === "bob");
    assert.equal(bobLogEntries.length, 0, `abstain must not add any log entry for bob; got ${JSON.stringify(bobLogEntries)}`);
  });
});

// ===========================================================================
// 4. Slow policy under lock — lock is held during authorizeAction sleep
// ===========================================================================

test("policy-concurrency: a slow policy under the lock delays a concurrent take until the seam returns", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    const slowMs = 250;
    await bootstrap(projectDir, "slow", { slowMs });

    // Alice takes first with policy=slow. Her seam call sleeps `slowMs`
    // INSIDE the lock, so the state file is reachable but the lock is
    // held for that whole interval.
    const aliceStart = Date.now();
    const alicePromise = spawnCli([
      "--project", projectDir, "--as", "alice",
      "take", "T-conc-1",
    ]);

    // Give alice's child a small head start so the lock is held when
    // bob arrives. Without this grace, bob could arrive before alice
    // even reaches authorizeAction.
    await new Promise((r) => setTimeout(r, 30));

    // Bob tries to take while alice is sleeping inside the seam.
    const bobStart = Date.now();
    const bobPromise = spawnCli([
      "--project", projectDir, "--as", "bob",
      "take", "T-conc-1",
    ]);

    const [aliceRes, bobRes] = await Promise.all([alicePromise, bobPromise]);
    const aliceElapsed = Date.now() - aliceStart;
    const bobElapsed = Date.now() - bobStart;

    // Alice must have slept at least slowMs (the seam held the lock for
    // that long).
    assert.ok(
      aliceElapsed >= slowMs,
      `alice must have slept ≥${slowMs}ms; elapsed=${aliceElapsed}ms`,
    );

    // Bob must have arrived AFTER alice was well into her sleep. With
    // policy=allow, bob will succeed as a takeover and end up as the
    // final owner.
    assert.equal(aliceRes.code, 0, `alice failed\nstdout: ${aliceRes.stdout}\nstderr: ${aliceRes.stderr}`);
    assert.equal(bobRes.code, 0, `bob failed\nstdout: ${bobRes.stdout}\nstderr: ${bobRes.stderr}`);
    assert.ok(
      bobElapsed >= slowMs - 30,
      `bob must have waited at least until alice's seam returned (≈${slowMs - 30}ms); elapsed=${bobElapsed}ms`,
    );

    const s = await readState(projectDir);
    const claimEntries = s.log.filter((e) => e.action === "take" && e.node === "T-conc-1");
    assert.equal(claimEntries.length, 2);
    const withPrev = claimEntries.filter((e) => e.previous_owner);
    assert.equal(withPrev.length, 1, `expected exactly 1 takeover entry; got ${withPrev.length}`);
    assert.equal(s.nodes["T-conc-1"].claim.by, withPrev[0].agent);
    assert.equal(withPrev[0].previous_owner, claimEntries.find((e) => e !== withPrev[0]).agent);
  });
});

// ===========================================================================
// 5. State integrity — interleaving-free under contention
// ===========================================================================

test("policy-concurrency: state file remains coherent under contention (no torn writes, exactly one claim owner)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await bootstrap(projectDir, "allow");

    const FANOUT = 6;
    const args = Array.from({ length: FANOUT }, (_, i) => ([
      "--project", projectDir, "--as", `agent-${i}`,
      "take", "T-conc-1",
    ]));
    const results = await Promise.all(args.map((a) => spawnCli(a)));

    // Exactly one process sees status=ready (free take winner); all the
    // others see status=in_progress (takeovers). With policy=allow, all
    // succeed; the final owner is whichever child won the last lock.
    for (const r of results) {
      assert.equal(r.code, 0, `child failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }

    const s = await readState(projectDir);
    // Exactly one claim owner.
    assert.ok(s.nodes["T-conc-1"].claim, "claim must exist");
    assert.equal(typeof s.nodes["T-conc-1"].claim.by, "string");
    assert.equal(s.nodes["T-conc-1"].status, "in_progress");

    // Log has exactly FANOUT take entries (one per child).
    const takeEntries = s.log.filter((e) => e.action === "take" && e.node === "T-conc-1");
    assert.equal(
      takeEntries.length,
      FANOUT,
      `expected ${FANOUT} take entries; got ${takeEntries.length}`,
    );

    // Exactly one take has no previous_owner (the first/free take); the
    // rest are takeovers and each one's previous_owner equals the owner
    // recorded immediately before it.
    const freeTake = takeEntries.find((e) => !e.previous_owner);
    assert.ok(freeTake, "exactly one free take must exist");
    const takeovers = takeEntries.filter((e) => e.previous_owner);
    assert.equal(takeovers.length, FANOUT - 1);
    for (let i = 0; i < takeovers.length; i++) {
      const prev = takeovers[i].previous_owner;
      // The previous owner must be either the free-take agent or an
      // earlier takeover (chain integrity — no skip-over entries).
      const candidates = [
        freeTake.agent,
        ...takeovers.slice(0, i).map((e) => e.agent),
      ];
      assert.ok(
        candidates.includes(prev),
        `takeover ${i} previous_owner=${prev} must be an earlier taker; candidates=${JSON.stringify(candidates)}`,
      );
    }

    // Final owner equals the last takeover (or the free take when
    // FANOUT === 1).
    const lastEntry = takeEntries.at(-1);
    assert.equal(s.nodes["T-conc-1"].claim.by, lastEntry.agent);

    // No interleaving inside any log entry (torn-write detection): each
    // entry has exactly one ts, action, agent, node.
    for (const e of takeEntries) {
      assert.equal(typeof e.ts, "string");
      assert.equal(typeof e.action, "string");
      assert.equal(typeof e.agent, "string");
      assert.equal(typeof e.node, "string");
    }
  });
});

// ===========================================================================
// 6. Concurrency contract for the seam itself (no policy installed →
//    ALREADY_CLAIMED, the seam must observe the in_progress claim and
//    refuse the takeover with no log entry).
// ===========================================================================

test("policy-concurrency: no policy installed → takeover attempt gets ALREADY_CLAIMED with no log entry", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    // Bootstrap without installing the fixture so loadApplicablePolicy
    // returns null and the seam abstains.
    await writeClimierJson(projectDir, "allow"); // mode is irrelevant without install
    await cli(["--project", projectDir, "init"]);
    await cli([
      "--project", projectDir, "--as", "setup",
      "add-initiative", "auth", "--desc", "auth",
    ]);
    await cli([
      "--project", projectDir, "--as", "setup",
      "add-node", "T-conc-1",
      "--kind", "resolvable", "--subkind", "task", "--title", "conc",
      "--initiative", "auth",
    ]);

    // Alice claims (no seam invocation, defaults core).
    await cli(["--project", projectDir, "take", "T-conc-1", "--as", "alice"]);
    const before = await readState(projectDir);

    // Bob's concurrent take sees the in_progress claim and abstain
    // → ALREADY_CLAIMED. No log entry is added.
    const bobRes = await spawnCli([
      "--project", projectDir, "--as", "bob",
      "take", "T-conc-1",
    ]);

    assert.equal(bobRes.code, 1, `bob must fail\nstdout: ${bobRes.stdout}\nstderr: ${bobRes.stderr}`);
    const body = JSON.parse(bobRes.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "ALREADY_CLAIMED");
    assert.equal(body.error.details.owner, "alice");

    const after = await readState(projectDir);
    assert.equal(after.nodes["T-conc-1"].claim.by, "alice");
    assert.equal(
      after.nodes["T-conc-1"].revision,
      before.nodes["T-conc-1"].revision,
      "revision must not change when ALREADY_CLAIMED short-circuits",
    );
    const bobLogEntries = after.log.filter((e) => e.agent === "bob");
    assert.equal(bobLogEntries.length, 0, `abstain must not add any log entry for bob; got ${JSON.stringify(bobLogEntries)}`);
  });
});
