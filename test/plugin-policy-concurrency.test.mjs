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
    if (prev.CLIMIER_HOME === undefined) {
      delete process.env.CLIMIER_HOME;
    } else {
      process.env.CLIMIER_HOME = prev.CLIMIER_HOME;
    }
    if (prev.CLIMIER_AGENT === undefined) {
      delete process.env.CLIMIER_AGENT;
    } else {
      process.env.CLIMIER_AGENT = prev.CLIMIER_AGENT;
    }

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
  if (!result.stdout.trim()) {
    return null;
  }
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
        env: { ...process.env, ...env, NO_COLOR: "1" },
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

function isConcurrentTaskTake(entry) {
  return entry.action === "take" && entry.node === "T-conc-1";
}

function hasPreviousOwner(entry) {
  return Boolean(entry.previous_owner);
}

function isBobEntry(entry) {
  return entry.agent === "bob";
}

function isFreeTake(entry) {
  return !entry.previous_owner;
}

function assertBobDidNotMutate(state, previousState, message) {
  assert.equal(state.nodes["T-conc-1"].claim.by, "alice");
  assert.equal(
    state.nodes["T-conc-1"].revision,
    previousState.nodes["T-conc-1"].revision,
    message,
  );
  assertNoBobLogEntries(state);
}

function assertNoBobLogEntries(state) {
  const bobLogEntries = state.log.filter(isBobEntry);
  assert.equal(bobLogEntries.length, 0, `no log entry should be added for bob; got ${JSON.stringify(bobLogEntries)}`);
}

function contentionTakeArgs(projectDir, index) {
  return [
    "--project", projectDir, "--as", `agent-${index}`,
    "take", "T-conc-1",
  ];
}

function spawnContentionTake(projectDir, index) {
  return spawnCli(contentionTakeArgs(projectDir, index));
}

async function spawnContendingChildren(projectDir, fanout) {
  const results = [];
  for (let index = 0; index < fanout; index++) {
    results.push(spawnContentionTake(projectDir, index));
  }
  return Promise.all(results);
}

function assertTakeoverChain(takeEntries) {
  const withPreviousOwner = takeEntries.filter(hasPreviousOwner);
  assert.equal(withPreviousOwner.length, 1, "expected exactly one takeover");
  const takeoverEntry = withPreviousOwner[0];
  const firstEntry = takeEntries.find((entry) => entry !== takeoverEntry);
  assert.equal(firstEntry.previous_owner, undefined, "first take must not carry previous_owner");
  assert.equal(takeoverEntry.previous_owner, firstEntry.agent, "takeover previous_owner must equal the first take's agent");
  return takeoverEntry;
}

function assertIntactLogEntries(takeEntries) {
  for (const entry of takeEntries) {
    assert.equal(typeof entry.ts, "string");
    assert.equal(typeof entry.action, "string");
    assert.equal(typeof entry.agent, "string");
    assert.equal(typeof entry.node, "string");
  }
}

function assertSuccessfulChildProcesses(results) {
  for (const result of results) {
    assert.equal(result.code, 0, `child failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
}

function assertContentionSnapshot(state, fanout) {
  assert.ok(state.nodes["T-conc-1"].claim, "claim must exist");
  assert.equal(typeof state.nodes["T-conc-1"].claim.by, "string");
  assert.equal(state.nodes["T-conc-1"].status, "in_progress");
  const takeEntries = state.log.filter(isConcurrentTaskTake);
  assert.equal(takeEntries.length, fanout, `expected ${fanout} take entries; got ${takeEntries.length}`);
  const freeTake = takeEntries.find(isFreeTake);
  assert.ok(freeTake, "exactly one free take must exist");
  const takeovers = takeEntries.filter(hasPreviousOwner);
  assert.equal(takeovers.length, fanout - 1);
  for (let i = 0; i < takeovers.length; i++) {
    const previousAgents = [freeTake.agent];
    for (let priorIndex = 0; priorIndex < i; priorIndex++) {
      previousAgents.push(takeovers[priorIndex].agent);
    }
    assert.ok(
      previousAgents.includes(takeovers[i].previous_owner),
      `takeover ${i} previous_owner=${takeovers[i].previous_owner} must be an earlier taker; candidates=${JSON.stringify(previousAgents)}`,
    );
  }
  assert.equal(state.nodes["T-conc-1"].claim.by, takeEntries.at(-1).agent);
  assertIntactLogEntries(takeEntries);
}

function assertSlowTakeResults(results, timings) {
  const { aliceRes, bobRes } = results;
  const { aliceElapsed, bobElapsed, slowMs } = timings;
  assert.ok(
    aliceElapsed >= slowMs,
    `alice must have slept ≥${slowMs}ms; elapsed=${aliceElapsed}ms`,
  );
  assert.equal(aliceRes.code, 0, `alice failed\nstdout: ${aliceRes.stdout}\nstderr: ${aliceRes.stderr}`);
  assert.equal(bobRes.code, 0, `bob failed\nstdout: ${bobRes.stdout}\nstderr: ${bobRes.stderr}`);
  assert.ok(
    bobElapsed >= slowMs - 30,
    `bob must have waited at least until alice's seam returned (≈${slowMs - 30}ms); elapsed=${bobElapsed}ms`,
  );
}

async function assertSlowTakeState(projectDir) {
  const state = await readState(projectDir);
  const claimEntries = state.log.filter(isConcurrentTaskTake);
  assert.equal(claimEntries.length, 2);
  const takeoverEntry = assertTakeoverChain(claimEntries);
  assert.equal(state.nodes["T-conc-1"].claim.by, takeoverEntry.agent);
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
    const claimEntries = s.log.filter(isConcurrentTaskTake);
    assert.equal(claimEntries.length, 2, `expected 2 take entries, got ${claimEntries.length}`);
    assert.equal(s.nodes["T-conc-1"].claim.by === "alice" || s.nodes["T-conc-1"].claim.by === "bob", true);
    assert.equal(s.nodes["T-conc-1"].status, "in_progress");

    // previous_owner records the single takeover and final owner.
    const takeoverEntry = assertTakeoverChain(claimEntries);
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

    const takeEntries = after.log.filter(isConcurrentTaskTake);
    assert.equal(takeEntries.length, 1, `expected 1 take entry (alice's), got ${takeEntries.length}`);
    // The deny decision MUST NOT add a success log entry. The only log
    // entry added during the deny should be a single 'take' from alice.
    assertNoBobLogEntries(after);
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
    assertBobDidNotMutate(after, before, "revision must not change when abstain short-circuits");

    const takeEntries = after.log.filter(isConcurrentTaskTake);
    assert.equal(takeEntries.length, 1);
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

    // Assert elapsed time and owner transition to prove the lock spans the seam.
    assertSlowTakeResults(
      { aliceRes, bobRes },
      { aliceElapsed, bobElapsed, slowMs },
    );
    await assertSlowTakeState(projectDir);
  });
});

// ===========================================================================
// 5. State integrity — interleaving-free under contention
// ===========================================================================

test("policy-concurrency: state file remains coherent under contention (no torn writes, exactly one claim owner)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await bootstrap(projectDir, "allow");

    const FANOUT = 6;
    const results = await spawnContendingChildren(projectDir, FANOUT);

    // Exactly one process sees status=ready (free take winner); all the
    // others see status=in_progress (takeovers). With policy=allow, all
    // succeed; the final owner is whichever child won the last lock.
    assertSuccessfulChildProcesses(results);

    const s = await readState(projectDir);
    assertContentionSnapshot(s, FANOUT);
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
    assertBobDidNotMutate(after, before, "revision must not change when ALREADY_CLAIMED short-circuits");
  });
});
