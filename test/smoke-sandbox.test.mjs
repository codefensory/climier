// Tests for .agents/skills/climier/smoke-sandbox.sh.
//
// Goals:
//   - The helper requires `--` and a command; bad invocations exit 64.
//   - It propagates stdout/stderr/exit unchanged.
//   - It forces CLIMIER_HOME to a private temp dir under /tmp, even when
//     the caller exports CLIMIER_HOME. The real ~/.climier is never touched.
//   - It cleans up the sandbox on EXIT and on TERM/HUP/INT.
//   - It works with a project that has .climier.json and with one that does not.
//
// These tests use real subprocesses (no mocking) because the helper is a shell
// script that mutates the filesystem and traps signals. The project root is
// the current worktree; CLIMIER_HOME is overridden with a sentinel tmpdir so
// nothing leaks to the real ~/.climier.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTempProject, rmTempProject, BIN } from "./helpers.mjs";

const ROOT = path.resolve(process.cwd());
const HELPER = path.join(ROOT, ".agents/skills/climier", "smoke-sandbox.sh");
const SENTINEL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "climier-sandbox-sentinel-"));

function sentinelEnv() {
  // Force CLIMIER_HOME to a known safe temp dir. The helper must override
  // this; if anything leaks through, the assertion below catches it.
  return { ...process.env, CLIMIER_HOME: SENTINEL_HOME, NO_COLOR: "1" };
}

function listSmokeSandboxes() {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("climier-smoke-"));
}

function runHelper(args, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn("bash", [HELPER, "--", ...args], {
      cwd: ROOT,
      env: { ...sentinelEnv(), ...env },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code, signal) => resolve({ stdout, stderr, code, signal }));
  });
}

test("smoke-sandbox.sh: helper file exists and is executable", () => {
  assert.ok(fs.existsSync(HELPER), `helper missing at ${HELPER}`);
  const st = fs.statSync(HELPER);
  // 0o111 (any execute bit). On Windows stat mode differs but this is POSIX CI.
  assert.ok((st.mode & 0o111) !== 0, "helper is not executable");
});

test("smoke-sandbox.sh: requires -- separator", () => {
  const r = spawnSync("bash", [HELPER], {
    cwd: ROOT,
    env: sentinelEnv(),
    encoding: "utf8",
  });
  assert.equal(r.status, 64, `expected exit 64, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Usage:/);
});

test("smoke-sandbox.sh: rejects -- with no command", () => {
  const r = spawnSync("bash", [HELPER, "--"], {
    cwd: ROOT,
    env: sentinelEnv(),
    encoding: "utf8",
  });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /Usage:/);
});

test("smoke-sandbox.sh: propagates stdout, stderr, and exit code", async () => {
  const r = await runHelper([
    "bash",
    "-c",
    'printf "out-line\\n"; printf "err-line\\n" >&2; exit 7',
  ]);
  assert.equal(r.code, 7, `expected exit 7; got ${r.code}; stderr=${r.stderr}`);
  assert.match(r.stdout, /out-line/);
  assert.match(r.stderr, /err-line/);
});

test("smoke-sandbox.sh: propagates successful exit code", async () => {
  const r = await runHelper(["true"]);
  assert.equal(r.code, 0);
});

test("smoke-sandbox.sh: forces CLIMIER_HOME to a private temp dir", async () => {
  // Even with a sentinel CLIMIER_HOME in env, the helper must override it.
  const r = await runHelper([
    "bash",
    "-c",
    'printf "HOME=%s\\n" "$CLIMIER_HOME"; printf "UMASK=%s\\n" "$(umask)"',
  ]);
  assert.equal(r.code, 0);
  const homeLine = r.stdout.split("\n").find((l) => l.startsWith("HOME="));
  assert.ok(homeLine, "no HOME= line emitted");
  const home = homeLine.slice("HOME=".length);
  assert.match(home, /^\/tmp\/climier-smoke-[^/]+\/home$/);
  // Sentinel CLIMIER_HOME was overridden; the wrapped command observed
  // the helper's CLIMIER_HOME.
  assert.notEqual(home, SENTINEL_HOME);
  // Umask inside the sandbox is 0077.
  assert.match(r.stdout, /UMASK=0077/);
});

test("smoke-sandbox.sh: does not touch the real ~/.climier", async () => {
  const tmp = await createTempProject();
  try {
    const r = await runHelper(["node", BIN, "--project", tmp, "init"]);
    assert.equal(r.code, 0, `init failed; stdout=${r.stdout} stderr=${r.stderr}`);
    // Real ~/.climier is untouched: no tasks.json was created under the
    // sentinel home either, because the helper redirects CLIMIER_HOME.
    const sentinelProjects = path.join(SENTINEL_HOME, "projects");
    let entries = [];
    try {
      entries = fs.readdirSync(sentinelProjects);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    assert.equal(entries.length, 0, `sentinel home leaked: ${entries.join(",")}`);
    // The temp project got a .climier.json (proves init ran successfully).
    assert.ok(fs.existsSync(path.join(tmp, ".climier.json")));
  } finally {
    await rmTempProject(tmp);
  }
});

test("smoke-sandbox.sh: cleans up sandbox on EXIT", async () => {
  const before = new Set(listSmokeSandboxes());
  await runHelper(["true"]);
  // Allow rm -rf to settle.
  await new Promise((r) => setTimeout(r, 50));
  const leftover = listSmokeSandboxes().filter((n) => !before.has(n));
  assert.equal(leftover.length, 0, `leftover sandboxes: ${leftover.join(",")}`);
});

test("smoke-sandbox.sh: cleans up sandbox on TERM", async () => {
  const before = new Set(listSmokeSandboxes());
  // detached:true puts the helper in its own process group so we can
  // deliver TERM to the whole group and not leave the inner sleep running.
  const proc = spawn("bash", [HELPER, "--", "sleep", "5"], {
    cwd: ROOT,
    env: sentinelEnv(),
    detached: true,
  });
  // Wait for the sandbox dir to appear (umask 077 makes it owned by us).
  let appeared = null;
  for (let i = 0; i < 100 && !appeared; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const now = listSmokeSandboxes().filter((n) => !before.has(n));
    if (now.length > 0) appeared = now;
  }
  assert.ok(appeared, "sandbox dir should appear during run");
  // Kill the whole process group so the inner sleep also terminates.
  process.kill(-proc.pid, "SIGTERM");
  await new Promise((resolve) => proc.on("close", () => resolve()));
  await new Promise((r) => setTimeout(r, 50));
  const leftover = listSmokeSandboxes().filter((n) => !before.has(n));
  assert.equal(leftover.length, 0, `leftover sandboxes after TERM: ${leftover.join(",")}`);
});

test("smoke-sandbox.sh: works with a project that preserves .climier.json", async () => {
  const tmp = await createTempProject();
  try {
    // Seed a known project_id so we exercise the metadata path.
    const metaId = "smoke-sandbox-pid-meta";
    await fsp.writeFile(
      path.join(tmp, ".climier.json"),
      JSON.stringify({ project_id: metaId }) + "\n",
      "utf8",
    );
    const r = await runHelper(["node", BIN, "--project", tmp, "init"]);
    assert.equal(r.code, 0, `init failed; stdout=${r.stdout} stderr=${r.stderr}`);
    // .climier.json is preserved (init does not overwrite by default).
    const meta = JSON.parse(await fsp.readFile(path.join(tmp, ".climier.json"), "utf8"));
    assert.equal(meta.project_id, metaId);
  } finally {
    await rmTempProject(tmp);
  }
});

test("smoke-sandbox.sh: works with a project that has no metadata", async () => {
  const tmp = await createTempProject();
  try {
    // No .climier.json. The CLI derives a project_id from the path; the
    // helper must still isolate CLIMIER_HOME so init does not touch the
    // real home.
    const r = await runHelper(["node", BIN, "--project", tmp, "init"]);
    assert.equal(r.code, 0, `init failed; stdout=${r.stdout} stderr=${r.stderr}`);
    // init writes .climier.json even when starting without metadata.
    assert.ok(fs.existsSync(path.join(tmp, ".climier.json")));
  } finally {
    await rmTempProject(tmp);
  }
});

// Best-effort cleanup of the sentinel dir at process exit.
process.on("exit", () => {
  try { fs.rmSync(SENTINEL_HOME, { recursive: true, force: true }); } catch {}
});
