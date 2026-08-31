// state-resilience-regression.test.mjs — end-to-end regression for ADR-004.
//
// Reproduce the incident that motivated ADR-004: a temp project that
// copied the same `project_id` ran `init --force` against a real,
// shared CLIMIER_HOME and clobbered the live state with no backup. The
// mitigation has two parts that we exercise here:
//   - `.agents/skills/climier/smoke-sandbox.sh` forces a private
//     CLIMIER_HOME per smoke run, so a copied `project_id` cannot
//     touch the caller's home.
//   - The `init --force` path takes a `force-init` snapshot under
//     `<state-dir>/snapshots/` before resetting, and `restore
//     <snapshot-id> --as orchestrator|recovery` lets recovery roll
//     the state back. Both pieces were shipped in Plan 1 and Plan 3
//     of ADR-004.
//
// What this test asserts (Plan 4 / acceptance):
//   - NEGATIVE CONTROL — without the helper, the same scenario DOES
//     clobber a sentinel control home. This pins the bug as the
//     lower bound: isolation is not free; the helper is what saves
//     us. If a future change "simplifies" the helper and drops the
//     override, the regression test below fails because the
//     sentinel would change.
//   - REGRESSION + ROUNDTRIP — with the helper, the same scenario
//     leaves the sentinel home untouched, while the sandbox home
//     goes through the full lifecycle: `init` → plant sentinel →
//     `init --force` (force-init snapshot) → `snapshots` lists it →
//     `restore` brings the sentinel back → `show` confirms the
//     sentinel survives → log carries a `{ action: "restore",
//     agent, snapshot_id }` entry plus a `pre-restore` snapshot.
//   - ISOLATION OVERRIDE — even when the caller exports
//     `CLIMIER_HOME=<control>`, the helper's `export CLIMIER_HOME=…`
//     wins. The orchestrator's `summary.sandbox_home` proves the
//     helper replaced the parent value.
//
// The test does NOT touch `~/.climier`. CONTROL_HOME lives under
// `os.tmpdir()`. We only mutate files we own under `os.tmpdir()`, and
// we clean them up in `finally`.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(process.cwd());
const BIN = path.join(ROOT, "bin", "climier.mjs");
const HELPER = path.join(ROOT, ".agents/skills/climier", "smoke-sandbox.sh");

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function newPid() {
  return "regression-pid-" + crypto.randomBytes(4).toString("hex");
}

const SENTINEL_STATE = Object.freeze({
  version: 2,
  nodes: { Sentinel: { id: "Sentinel", title: "alive" } },
  edges: [],
  initiatives: {},
  log: [],
});
const SENTINEL_BYTES = JSON.stringify(SENTINEL_STATE, null, 2) + "\n";

// -------------------------------------------------------------------------
// Orchestrator: runs the full lifecycle inside the helper. The helper sets
// CLIMIER_HOME to a private sandbox; this script reads tasks.json from that
// sandbox and emits a single JSON summary to stdout.
// -------------------------------------------------------------------------
const ORCHESTRATOR_SOURCE = `
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BIN = process.env.CLIMIER_BIN;
const PROJECT = process.env.CLIMIER_PROJECT;
const PID = process.env.CLIMIER_PID;
const SANDBOX_HOME = process.env.CLIMIER_HOME;

if (!BIN || !PROJECT || !PID || !SANDBOX_HOME) {
  console.error(
    "orchestrator: missing env (CLIMIER_BIN, CLIMIER_PROJECT, CLIMIER_PID, CLIMIER_HOME required)"
  );
  process.exit(2);
}

const TASKS_FILE = path.join(SANDBOX_HOME, "projects", PID, "tasks.json");

function cli(...args) {
  const result = execFileSync("node", [BIN, "--project", PROJECT, ...args], {
    encoding: "utf8",
  });
  return JSON.parse(result);
}

const SENTINEL = {
  version: 2,
  nodes: { Sentinel: { id: "Sentinel", title: "alive" } },
  edges: [],
  initiatives: {},
  log: [],
};

// 1. init creates an empty v3 state in the sandbox.
cli("init");

// 2. Plant sentinel directly into the sandbox tasks.json. We write the
// exact same bytes writeState would have produced so the upcoming
// init --force sees a real pre-existing state.
fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
fs.writeFileSync(TASKS_FILE, JSON.stringify(SENTINEL, null, 2) + "\\n");

// 3. init --force: snapshots the sentinel (reason=force-init) and
// then resets the state to empty.
// ADR-008 §"restore e init --force" (T-plugin-policy-seam-state-ops):
// init --force now requires an explicit actor (--as / CLIMIER_AGENT).
cli("init", "--force", "--as", "test-agent");

// 4. List snapshots. We expect exactly one force-init snapshot.
const list1 = cli("snapshots");
if (list1.snapshots.length !== 1) {
  console.error(
    "orchestrator: expected 1 snapshot after force-init, got " +
      list1.snapshots.length
  );
  process.exit(2);
}
const forceInitSnap = list1.snapshots[0];
if (forceInitSnap.reason !== "force-init") {
  console.error(
    "orchestrator: expected reason=force-init, got " + forceInitSnap.reason
  );
  process.exit(2);
}

// 5. Restore the force-init snapshot. The restore command validates
// the target, takes a pre-restore raw snapshot of the current state,
// writes the raw bytes back to tasks.json, and appends a
// { action: "restore", agent, snapshot_id } log entry.
const restored = cli("restore", forceInitSnap.id, "--as", "test-agent");
if (!restored.snapshot || restored.snapshot.id !== forceInitSnap.id) {
  console.error(
    "orchestrator: restore did not echo the requested snapshot"
  );
  process.exit(2);
}

// 6. Show the sentinel. It must be alive in the restored state.
const show = cli("show", "Sentinel");
if (!show.node || show.node.title !== "alive") {
  console.error(
    "orchestrator: show Sentinel did not return alive sentinel"
  );
  process.exit(2);
}

// 7. Re-list snapshots to confirm the pre-restore pair.
const list2 = cli("snapshots");
const preRestoreSnaps = list2.snapshots.filter((s) => s.reason === "pre-restore");

// 8. Read the live state to verify the restore log entry.
const after = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8"));
const restoreEntries = after.log.filter((e) => e.action === "restore");

// 9. Capture file modes INSIDE the sandbox while it is still alive.
// The helper's EXIT trap removes the sandbox right after we return,
// so the parent test cannot stat these files afterwards.
let sandboxStateMode = null;
let sandboxHomeMode = null;
let sandboxSnapDirMode = null;
try {
  sandboxStateMode = fs.statSync(TASKS_FILE).mode & 0o777;
  sandboxHomeMode = fs.statSync(SANDBOX_HOME).mode & 0o777;
  const snapDir = path.join(SANDBOX_HOME, "projects", PID, "snapshots");
  sandboxSnapDirMode = fs.statSync(snapDir).mode & 0o777;
} catch (e) {
  console.error("orchestrator: failed to stat sandbox files: " + e.message);
  process.exit(2);
}

// 10. Single JSON summary line. The test parses this verbatim.
console.log(
  JSON.stringify({
    ok: true,
    sandbox_home: SANDBOX_HOME,
    pid: PID,
    pre_force_init_count: list1.snapshots.length,
    force_init_reason: list1.snapshots[0].reason,
    force_init_id: list1.snapshots[0].id,
    restored_snapshot_id: restored.snapshot.id,
    sentinel_alive: show.node.title,
    pre_restore_count: preRestoreSnaps.length,
    restore_log_count: restoreEntries.length,
    restore_log_first: restoreEntries[0] || null,
    restored_nodes_keys: Object.keys(after.nodes || {}),
    sandbox_state_mode: sandboxStateMode,
    sandbox_home_mode: sandboxHomeMode,
    sandbox_snap_dir_mode: sandboxSnapDirMode,
  })
);
`;

function writeOrchestrator(dir) {
  const file = path.join(dir, "orchestrator.mjs");
  fs.writeFileSync(file, ORCHESTRATOR_SOURCE, "utf8");
  return file;
}

function spawnCli(args, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn("node", args, {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: "1", ...env },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

function spawnHelper(args, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn("bash", [HELPER, "--", ...args], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: "1", ...env },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

// Plant a sentinel v2 state at CONTROL/projects/<pid>/tasks.json and a
// temp project that copies the same project_id. Returns the paths so the
// test can assert and clean up.
function setupIncidentFixtures(pid) {
  const control = mkTempDir("climier-regression-control-");
  const tempProj = mkTempDir("climier-regression-tproj-");
  fs.mkdirSync(path.join(control, "projects", pid), { recursive: true });
  fs.writeFileSync(
    path.join(control, "projects", pid, "tasks.json"),
    SENTINEL_BYTES
  );
  fs.writeFileSync(
    path.join(tempProj, ".climier.json"),
    JSON.stringify({ project_id: pid }) + "\n"
  );
  return { control, tempProj };
}

// =============================================================================
// NEGATIVE CONTROL — proves the bug exists. Without smoke-sandbox, init --force
// on a temp project that copied project_id WILL clobber a sentinel control
// home. If this assertion ever stops failing, the bug has somehow stopped
// reproducing, which would mean the regression test below is no longer
// measuring what it claims to measure.
// =============================================================================

test("NEGATIVE CONTROL: without smoke-sandbox, init --force with copied project_id clobbers a sentinel control home (pins the original incident)", async () => {
  const pid = newPid();
  const { control, tempProj } = setupIncidentFixtures(pid);

  try {
    // Run init --force WITHOUT the helper. The parent's CLIMIER_HOME
    // is the npm test runner's tmpdir; we override to CONTROL via the
    // subprocess env so the smoke targets our sentinel home.
    const r = await spawnCli(
      // --as is mandatory for init --force since ADR-008
      // §"restore e init --force"; the actor is opaque to the core.
      [BIN, "--project", tempProj, "init", "--force", "--as", "smoke"],
      { CLIMIER_HOME: control }
    );
    assert.equal(
      r.code,
      0,
      `init --force without helper must succeed; got code=${r.code} stderr=${r.stderr}`
    );

    // The sentinel home must have been clobbered. This is the bug.
    const controlBytes = fs.readFileSync(
      path.join(control, "projects", pid, "tasks.json"),
      "utf8"
    );
    assert.notEqual(
      controlBytes,
      SENTINEL_BYTES,
      "expected the sentinel to be clobbered by an unguarded init --force; " +
        "if this assertion fails, the negative control no longer demonstrates the bug"
    );
    const after = JSON.parse(controlBytes);
    assert.equal(after.version, 3);
    assert.deepEqual(
      after.nodes,
      {},
      "sentinel nodes must be gone after init --force without isolation"
    );
  } finally {
    rmTempDir(control);
    rmTempDir(tempProj);
  }
});

// =============================================================================
// REGRESSION + FULL ROUNDTRIP — the helper isolates CLIMIER_HOME so the
// sentinel survives, while the sandbox goes through init -> init --force ->
// snapshots -> restore -> show. The orchestrator script (written into the
// temp project and run inside the helper) drives the lifecycle from inside
// the sandbox.
// =============================================================================

test("REGRESSION: with smoke-sandbox, init --force with copied project_id does NOT touch the sentinel control home", async () => {
  const pid = newPid();
  const { control, tempProj } = setupIncidentFixtures(pid);

  try {
    const orchestrator = writeOrchestrator(tempProj);
    // Pass CLIMIER_HOME=control to the parent env. The helper's
    // `export CLIMIER_HOME="$sandbox/home"` MUST override this; the
    // orchestrator's `summary.sandbox_home` (read inside the helper)
    // confirms the override.
    const r = await spawnHelper(["node", orchestrator], {
      CLIMIER_HOME: control,
      CLIMIER_BIN: BIN,
      CLIMIER_PROJECT: tempProj,
      CLIMIER_PID: pid,
    });
    assert.equal(
      r.code,
      0,
      `orchestrator failed; code=${r.code} stdout=${r.stdout} stderr=${r.stderr}`
    );

    // The sentinel control home is the central invariant of this
    // regression test. If the helper ever stops isolating CLIMIER_HOME,
    // the bytes here change and this assertion fails — which is
    // acceptance criterion #4.
    const controlBytes = fs.readFileSync(
      path.join(control, "projects", pid, "tasks.json"),
      "utf8"
    );
    assert.equal(
      controlBytes,
      SENTINEL_BYTES,
      `isolation is broken: CONTROL/projects/${pid}/tasks.json was modified by the smoke-sandbox run.\n` +
        `Expected (sentinel): ${SENTINEL_BYTES}\nActual: ${controlBytes}`
    );

    // Parse the orchestrator's single-line JSON summary.
    const summary = JSON.parse(r.stdout.trim());
    assert.equal(summary.ok, true, `orchestrator reported not-ok; summary=${JSON.stringify(summary)}`);
    assert.equal(summary.pid, pid);
    assert.notEqual(
      summary.sandbox_home,
      control,
      "helper must override CLIMIER_HOME; sandbox_home must not equal the control home"
    );
    // Lifecycle assertions.
    assert.equal(summary.pre_force_init_count, 1);
    assert.equal(summary.force_init_reason, "force-init");
    assert.equal(summary.sentinel_alive, "alive");
    assert.equal(summary.pre_restore_count, 1);
    assert.equal(summary.restore_log_count, 1);
    assert.deepEqual(summary.restored_nodes_keys, ["Sentinel"]);

    // Restore log entry shape: action, agent, snapshot_id, ts.
    const restoreEntry = summary.restore_log_first;
    assert.equal(restoreEntry.action, "restore");
    assert.equal(restoreEntry.agent, "test-agent");
    assert.equal(restoreEntry.snapshot_id, summary.restored_snapshot_id);
    assert.equal(typeof restoreEntry.ts, "string");
    assert.ok(!Number.isNaN(Date.parse(restoreEntry.ts)));
  } finally {
    rmTempDir(control);
    rmTempDir(tempProj);
  }
});

// =============================================================================
// ISOLATION OVERRIDE — explicit check that the helper REPLACES the parent
// CLIMIER_HOME, not just appends. We pass CLIMIER_HOME=<control> in the
// parent env and assert that the helper's wrapped command sees a different
// CLIMIER_HOME (= the sandbox, not control). This is acceptance criterion
// #4 framed as a direct property.
// =============================================================================

test("HELPER ISOLATION: smoke-sandbox.sh overrides the parent's CLIMIER_HOME even when the caller exports one", async () => {
  const pid = newPid();
  const { control, tempProj } = setupIncidentFixtures(pid);

  try {
    // Probe helper: print CLIMIER_HOME from inside the wrapped command.
    // The helper must replace it.
    const r = await spawnHelper(["bash", "-c", "printf 'HOME=%s\\n' \"$CLIMIER_HOME\""]);
    assert.equal(r.code, 0, `probe failed; stderr=${r.stderr}`);
    const homeLine = r.stdout.split("\n").find((l) => l.startsWith("HOME="));
    assert.ok(homeLine, "no HOME= line emitted");
    const observed = homeLine.slice("HOME=".length);
    assert.match(
      observed,
      /^\/tmp\/climier-smoke-[^/]+\/home$/,
      `expected helper's private sandbox home; got ${observed}`
    );
    assert.notEqual(
      observed,
      control,
      "helper must override the parent's CLIMIER_HOME; observed value must not equal the control home"
    );

    // The sentinel was untouched by the probe run.
    const controlBytes = fs.readFileSync(
      path.join(control, "projects", pid, "tasks.json"),
      "utf8"
    );
    assert.equal(controlBytes, SENTINEL_BYTES);
  } finally {
    rmTempDir(control);
    rmTempDir(tempProj);
  }
});

// =============================================================================
// DEEP-HOLE — the helper's umask 0077 means the sandbox dir is only
// accessible to the user running the test. The orchestrator captures the
// file modes INSIDE the sandbox (before the helper's EXIT trap wipes it)
// and the parent test asserts against the summary.
// =============================================================================

test("SANDBOX FILES: orchestrator-created state file lives under the sandbox home with private umask (0700/0600)", async () => {
  if (process.platform === "win32") {
    // chmod is best-effort on Windows; the contract is that the sandbox
    // is private enough on POSIX. Skip on Windows.
    return;
  }
  const pid = newPid();
  const { control, tempProj } = setupIncidentFixtures(pid);

  try {
    const orchestrator = writeOrchestrator(tempProj);
    const r = await spawnHelper(["node", orchestrator], {
      CLIMIER_HOME: control,
      CLIMIER_BIN: BIN,
      CLIMIER_PROJECT: tempProj,
      CLIMIER_PID: pid,
    });
    assert.equal(r.code, 0, `orchestrator failed; stderr=${r.stderr} stdout=${r.stdout}`);

    const summary = JSON.parse(r.stdout.trim());
    assert.match(summary.sandbox_home, /^\/tmp\/climier-smoke-[^/]+\/home$/);
    // The orchestrator captured modes from inside the sandbox before the
    // helper's EXIT trap removed it. The contract is that init, restore
    // and snapshot paths under smoke-sandbox inherit umask 0077.
    assert.equal(
      summary.sandbox_state_mode,
      0o600,
      `sandbox tasks.json must be 0600; got 0o${(summary.sandbox_state_mode).toString(8)}`
    );
    assert.equal(
      summary.sandbox_home_mode,
      0o700,
      `sandbox home must be 0700; got 0o${(summary.sandbox_home_mode).toString(8)}`
    );
    assert.equal(
      summary.sandbox_snap_dir_mode,
      0o700,
      `snapshots dir must be 0700; got 0o${(summary.sandbox_snap_dir_mode).toString(8)}`
    );

    // CONTROL home was untouched through this whole round.
    const controlBytes = fs.readFileSync(
      path.join(control, "projects", pid, "tasks.json"),
      "utf8"
    );
    assert.equal(controlBytes, SENTINEL_BYTES);
  } finally {
    rmTempDir(control);
    rmTempDir(tempProj);
  }
});

// Best-effort cleanup if a test exits early without hitting its finally.
process.on("exit", () => {
  try {
    const leftovers = fs.readdirSync(os.tmpdir());
    for (const name of leftovers) {
      if (
        name.startsWith("climier-regression-control-") ||
        name.startsWith("climier-regression-tproj-")
      ) {
        fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
      }
    }
  } catch {}
});