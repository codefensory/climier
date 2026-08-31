// Tests for the worker preflight + start-worktree flow.
//
// Goals:
//   - worker-guard.sh: prints project_root, fails loudly when the worktree is dirty.
//   - start-worktree.sh: calls worker-guard.sh exactly once per invocation
//     (the SKILL.md should describe the path; the script enforces it).
//   - start-worktree.sh: writes a WORKTREE note with path, branch, base, base_ref,
//     base_sha — backwards compatible with the validator's parser.
//   - start-worktree.sh: captures base_ref/base_sha from the main branch before
//     any state mutation, so the values are immutable provenance for the task.
//   - start-worktree.sh: if git worktree add fails after a successful take,
//     the script releases the claim and exits non-zero with a clear message.
//   - start-worktree.sh: rejects existing branch/path before touching state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { BIN, runCli, stateFilePath } from "./helpers.mjs";

const ROOT = path.resolve(process.cwd());
const SCRIPTS = path.join(ROOT, ".agents/skills/climier-worker");
const GUARD = path.join(SCRIPTS, "worker-guard.sh");
const START = path.join(SCRIPTS, "start-worktree.sh");

// The workflow scripts intentionally call the stable `climier` command in
// production. Tests must point that command at this worktree's binary so a
// v3 state fixture is not handed to an older globally linked control binary.
const CLIMIER_SHIM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "climier-test-cli-shim-"));
const CLIMIER_SHIM = path.join(CLIMIER_SHIM_DIR, "climier");
fs.writeFileSync(CLIMIER_SHIM, `#!/usr/bin/env bash\nexec ${process.execPath} ${JSON.stringify(BIN)} "$@"\n`);
fs.chmodSync(CLIMIER_SHIM, 0o755);
process.on("exit", () => { try { fs.rmSync(CLIMIER_SHIM_DIR, { recursive: true, force: true }); } catch {} });

function testPath(prefix = process.env.PATH) {
  return `${prefix ? `${prefix}:` : ""}${process.env.PATH}`;
}

function shortId(prefix = "id") {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
}

async function initRepo(dir) {
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  const r = await runCli(["--project", dir, "init"]);
  assert.equal(r.code, 0, `init failed: ${r.stderr}`);
  // Commit .climier.json so the guard treats the worktree as clean.
  execFileSync("git", ["add", ".climier.json"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "climier init"], { cwd: dir });
}

async function addOpenTask(projectRoot, taskId) {
  const r0 = await runCli([
    "--project", projectRoot,
    "add-initiative", "workflow-speed",
    "--desc", "Worker-script probe initiative.",
    "--as", "test-agent",
  ]);
  assert.equal(r0.code, 0, `add-initiative failed: ${r0.stderr}; stdout=${r0.stdout}`);
  const r = await runCli([
    "--project", projectRoot,
    "add-task", taskId,
    "--initiative", "workflow-speed",
    "--title", `Probe ${taskId}`,
    "--body", "Probe body for worker-script tests.",
    "--acceptance", "Probe acceptance.",
    "--blocked-by", "",
    "--as", "test-agent",
  ]);
  assert.equal(r.code, 0, `add-task failed: ${r.stderr}; stdout=${r.stdout}`);
}

function worktreeRelPath(taskId, agentId) {
  return path.join("..", "climier-worktrees", `${taskId}-${agentId}`);
}

function worktreeAbsPath(projectRoot, taskId, agentId) {
  return path.resolve(projectRoot, worktreeRelPath(taskId, agentId));
}

async function cleanupWorktree(projectRoot, taskId, agentId) {
  const branch = `work/${taskId}-${agentId}`;
  const wtAbs = worktreeAbsPath(projectRoot, taskId, agentId);
  // Remove the worktree if it still exists.
  try {
    execFileSync("git", ["-C", projectRoot, "worktree", "remove", "--force", wtAbs], {
      stdio: "ignore",
    });
  } catch {
    // Worktree may have already been removed or never created.
  }
  // Drop the branch if it exists.
  try {
    execFileSync("git", ["-C", projectRoot, "branch", "-D", branch], { stdio: "ignore" });
  } catch {
    // ignore
  }
  try {
    execFileSync("git", ["-C", projectRoot, "worktree", "prune"], { stdio: "ignore" });
  } catch {}
  try {
    fs.rmSync(wtAbs, { recursive: true, force: true });
  } catch {}
}

async function rmProject(projectRoot) {
  try {
    // Best-effort prune worktrees first so the directory can be removed.
    execFileSync("git", ["-C", projectRoot, "worktree", "prune"], { stdio: "ignore" });
  } catch {}
  await fsp.rm(projectRoot, { recursive: true, force: true });
}

function runBash(script, args, { cwd, env, input } = {}) {
  return new Promise((resolve) => {
    const proc = spawn("bash", [script, ...args], {
      cwd,
      env: {
        ...process.env,
        ...(env || {}),
        PATH: env && Object.prototype.hasOwnProperty.call(env, "PATH") ? env.PATH : testPath(CLIMIER_SHIM_DIR),
        NO_COLOR: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    if (input !== undefined) proc.stdin.end(input);
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

async function readStateSafe(projectRoot) {
  try {
    const raw = await fsp.readFile(stateFilePath(projectRoot), "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function parseWorktreeNote(taskLog) {
  for (const entry of taskLog || []) {
    const note = entry?.note || entry?.action?.note || "";
    const m = note.match(/^WORKTREE\s+(.*)$/);
    if (m) {
      const fields = {};
      for (const part of m[1].split(/\s+/)) {
        const eq = part.indexOf("=");
        if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
      }
      if (fields.path) return fields;
    }
  }
  return null;
}

async function readWorktreeNote(projectRoot, taskId) {
  const state = await readStateSafe(projectRoot);
  if (!state) return null;
  const log = (state.log || []).filter(
    (e) => e.node === taskId && typeof e.note === "string" && e.note.startsWith("WORKTREE"),
  );
  return parseWorktreeNote(log);
}

// ---------------------------------------------------------------------------
// worker-guard.sh
// ---------------------------------------------------------------------------

test("worker-guard.sh: prints project_root from the main worktree", async () => {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "climier-guard-clean-"));
  try {
    await initRepo(projectRoot);
    const r = await runBash(GUARD, [], { cwd: projectRoot });
    assert.equal(r.code, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.equal(r.stdout.trim(), projectRoot);
  } finally {
    await rmProject(projectRoot);
  }
});

test("worker-guard.sh: fails non-zero when the worktree is dirty", async () => {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "climier-guard-dirty-"));
  try {
    await initRepo(projectRoot);
    // Create an unstaged change so the guard fails.
    fs.writeFileSync(path.join(projectRoot, "dirty.txt"), "unsaved\n");
    const r = await runBash(GUARD, [], { cwd: projectRoot });
    assert.notEqual(r.code, 0, "expected non-zero exit on dirty worktree");
    assert.match(r.stderr, /NO-GO worker guard/);
    assert.match(r.stderr, /dirty\.txt/);
  } finally {
    await rmProject(projectRoot);
  }
});

test("worker-guard.sh: fails non-zero when a tracked file is modified", async () => {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "climier-guard-mod-"));
  try {
    await initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, "README.md"), "modified\n");
    const r = await runBash(GUARD, [], { cwd: projectRoot });
    assert.notEqual(r.code, 0, "expected non-zero exit on modified tracked file");
    assert.match(r.stderr, /NO-GO worker guard/);
  } finally {
    await rmProject(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// start-worktree.sh — arg validation
// ---------------------------------------------------------------------------

test("start-worktree.sh: requires two positional args", () => {
  const r = spawn("bash", [START], { encoding: "utf8" });
  return new Promise((resolve) => {
    let stderr = "";
    r.stderr.on("data", (d) => (stderr += d.toString()));
    r.on("close", (code) => {
      assert.notEqual(code, 0);
      assert.match(stderr, /Usage:/);
      resolve();
    });
  });
});

// ---------------------------------------------------------------------------
// start-worktree.sh — happy path
// ---------------------------------------------------------------------------

test("start-worktree.sh: takes, creates worktree, writes WORKTREE note with base_ref and base_sha", async () => {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "climier-start-happy-"));
  const taskId = shortId("T-start");
  const agentId = shortId("agent");
  try {
    await initRepo(projectRoot);
    await addOpenTask(projectRoot, taskId);

    const baseSha = execFileSync("git", ["-C", projectRoot, "rev-parse", "HEAD"]).toString().trim();
    const baseRef = execFileSync("git", ["-C", projectRoot, "branch", "--show-current"])
      .toString()
      .trim();

    const r = await runBash(START, [taskId, agentId], { cwd: projectRoot });
    assert.equal(r.code, 0, `expected exit 0; got ${r.code}; stderr=${r.stderr}`);

    // Stdout summary preserves the validator-facing fields.
    assert.match(r.stdout, new RegExp(`WORKTREE path=\\.\\./climier-worktrees/${taskId}-${agentId}`));
    assert.match(r.stdout, new RegExp(`BRANCH work/${taskId}-${agentId}`));
    assert.match(r.stdout, new RegExp(`BASE ${baseRef}`));
    assert.match(r.stdout, new RegExp(`BASE_SHA ${baseSha}`));
    assert.match(r.stdout, /NEXT cd /);

    // The persisted WORKTREE note carries every required key.
    const note = await readWorktreeNote(projectRoot, taskId);
    assert.ok(note, "expected a WORKTREE note on the task log");
    assert.ok(note.path, "WORKTREE note must include path");
    assert.ok(note.branch, "WORKTREE note must include branch");
    assert.ok(note.base, "WORKTREE note must include base (validator compat)");
    assert.ok(note.base_ref, "WORKTREE note must include base_ref");
    assert.ok(note.base_sha, "WORKTREE note must include base_sha");
    assert.equal(note.base_ref, baseRef);
    assert.equal(note.base_sha, baseSha);
    // Validator still parses path/branch/base; the new keys are additive.
    assert.equal(note.path, worktreeRelPath(taskId, agentId));
    assert.equal(note.branch, `work/${taskId}-${agentId}`);

    // Worktree was actually created and references the expected commit.
    const wtAbs = worktreeAbsPath(projectRoot, taskId, agentId);
    assert.ok(fs.existsSync(path.join(wtAbs, "README.md")), "worktree must contain repo files");
    const wtBranch = execFileSync("git", ["-C", wtAbs, "branch", "--show-current"]).toString().trim();
    assert.equal(wtBranch, `work/${taskId}-${agentId}`);

    // Claim was placed by the script.
    const state = await readStateSafe(projectRoot);
    const node = state.nodes[taskId];
    assert.ok(node?.claim, "claim must be present after take");
    assert.equal(node.claim.by, agentId);
    // Status flips to in_progress once taken.
    assert.equal(node.status, "in_progress");
  } finally {
    await cleanupWorktree(projectRoot, taskId, agentId);
    await rmProject(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// start-worktree.sh — guard runs exactly once
// ---------------------------------------------------------------------------

test("start-worktree.sh: calls worker-guard.sh exactly once per invocation", async () => {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "climier-start-once-"));
  const taskId = shortId("T-once");
  const agentId = shortId("agent");
  // Fake sibling directory: we copy start-worktree.sh in here and replace its
  // sibling worker-guard.sh with a counter that still prints project_root.
  // start-worktree.sh resolves worker-guard.sh via BASH_SOURCE, so a sibling
  // copy picks up our shim without any other surgery.
  const fakeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "climier-worker-shim-"));
  try {
    await initRepo(projectRoot);
    await addOpenTask(projectRoot, taskId);

    await fsp.copyFile(START, path.join(fakeDir, "start-worktree.sh"));
    fs.chmodSync(path.join(fakeDir, "start-worktree.sh"), 0o755);

    const counterFile = path.join(fakeDir, "guard-counter.log");
    const shim = [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$$" >> "${counterFile}"`,
      `printf '%s\\n' "${projectRoot}"`,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(fakeDir, "worker-guard.sh"), shim);
    fs.chmodSync(path.join(fakeDir, "worker-guard.sh"), 0o755);

    const r = await runBash(path.join(fakeDir, "start-worktree.sh"), [taskId, agentId], {
      cwd: projectRoot,
    });
    assert.equal(r.code, 0, `expected exit 0; got ${r.code}; stderr=${r.stderr}`);

    const calls = fs
      .readFileSync(counterFile, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    assert.equal(
      calls.length,
      1,
      `worker-guard.sh must run exactly once; observed ${calls.length} invocations`,
    );
  } finally {
    await cleanupWorktree(projectRoot, taskId, agentId);
    await rmProject(projectRoot);
    await fsp.rm(fakeDir, { recursive: true, force: true });
  }
});

test("start-worktree.sh: aborts with NO-GO when the worker-guard shim reports a dirty worktree", async () => {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "climier-start-no-go-"));
  const taskId = shortId("T-no-go");
  const agentId = shortId("agent");
  const fakeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "climier-worker-shim-"));
  try {
    await initRepo(projectRoot);
    await addOpenTask(projectRoot, taskId);

    // Shim that mimics the real guard's failure mode.
    await fsp.copyFile(START, path.join(fakeDir, "start-worktree.sh"));
    fs.chmodSync(path.join(fakeDir, "start-worktree.sh"), 0o755);
    fs.writeFileSync(
      path.join(fakeDir, "worker-guard.sh"),
      `#!/usr/bin/env bash
echo "NO-GO worker guard: simulated dirty state" >&2
echo "  staged-changes.txt" >&2
exit 2
`,
    );
    fs.chmodSync(path.join(fakeDir, "worker-guard.sh"), 0o755);

    const r = await runBash(path.join(fakeDir, "start-worktree.sh"), [taskId, agentId], {
      cwd: projectRoot,
    });
    assert.equal(r.code, 2, `expected exit 2 on guard failure; got ${r.code}; stderr=${r.stderr}`);
    assert.match(r.stderr, /NO-GO worker guard/);

    // The task must NOT have been claimed — guard runs before take.
    const state = await readStateSafe(projectRoot);
    const claim = state.nodes[taskId]?.claim;
    assert.ok(
      !claim || !claim.by,
      `guard failure must not claim; got ${JSON.stringify(claim)}`,
    );
  } finally {
    await cleanupWorktree(projectRoot, taskId, agentId);
    await rmProject(projectRoot);
    await fsp.rm(fakeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// start-worktree.sh — pre-take rejection
// ---------------------------------------------------------------------------

test("start-worktree.sh: rejects when the branch already exists (before take)", async () => {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "climier-start-branch-"));
  const taskId = shortId("T-branch");
  const agentId = shortId("agent");
  try {
    await initRepo(projectRoot);
    await addOpenTask(projectRoot, taskId);

    const branch = `work/${taskId}-${agentId}`;
    execFileSync("git", ["-C", projectRoot, "branch", branch]);

    const r = await runBash(START, [taskId, agentId], { cwd: projectRoot });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /branch already exists/);

    const state = await readStateSafe(projectRoot);
    const claim = state.nodes[taskId]?.claim;
    assert.ok(
      !claim || !claim.by,
      `branch collision must not claim; got ${JSON.stringify(claim)}`,
    );
  } finally {
    await cleanupWorktree(projectRoot, taskId, agentId);
    await rmProject(projectRoot);
  }
});

test("start-worktree.sh: rejects when the worktree path already exists (before take)", async () => {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "climier-start-path-"));
  const taskId = shortId("T-path");
  const agentId = shortId("agent");
  try {
    await initRepo(projectRoot);
    await addOpenTask(projectRoot, taskId);

    const wtAbs = worktreeAbsPath(projectRoot, taskId, agentId);
    fs.mkdirSync(wtAbs, { recursive: true });

    const r = await runBash(START, [taskId, agentId], { cwd: projectRoot });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /path already exists/);

    const state = await readStateSafe(projectRoot);
    const claim = state.nodes[taskId]?.claim;
    assert.ok(
      !claim || !claim.by,
      `path collision must not claim; got ${JSON.stringify(claim)}`,
    );
  } finally {
    await cleanupWorktree(projectRoot, taskId, agentId);
    await rmProject(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// start-worktree.sh — recovery after take
// ---------------------------------------------------------------------------

test("start-worktree.sh: releases the claim when git worktree add fails after take", async () => {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "climier-start-fail-"));
  const taskId = shortId("T-fail");
  const agentId = shortId("agent");
  const fakeBin = await fsp.mkdtemp(path.join(os.tmpdir(), "climier-start-failbin-"));
  try {
    await initRepo(projectRoot);
    await addOpenTask(projectRoot, taskId);

    // A fake `git` shim that lets everything pass except `worktree add`,
    // which fails. We rely on PATH ordering: shim first, real git as fallback.
    // start-worktree.sh invokes git as `git -C <dir> worktree add ...`. Match
    // the adjacent "worktree" + "add" pair anywhere in the argv.
    const shimGit = [
      "#!/usr/bin/env bash",
      'prev=""',
      'for arg in "$@"; do',
      '  if [[ "$prev" == "worktree" && "$arg" == "add" ]]; then',
      '    echo "shim: simulated git worktree add failure" >&2',
      "    exit 128",
      "  fi",
      '  prev="$arg"',
      "done",
      'exec /usr/bin/env -i PATH="/usr/bin:/bin" /usr/bin/git "$@"',
      "",
    ].join("\n");
    fs.writeFileSync(path.join(fakeBin, "git"), shimGit);
    fs.chmodSync(path.join(fakeBin, "git"), 0o755);

    const r = await runBash(START, [taskId, agentId], {
      cwd: projectRoot,
      env: { PATH: `${fakeBin}:${CLIMIER_SHIM_DIR}:${process.env.PATH}` },
    });
    assert.notEqual(r.code, 0, `expected non-zero exit after worktree add failure; stderr=${r.stderr}`);
    assert.match(r.stderr, /worktree add failed/, "stderr must mention worktree add failure");
    assert.match(r.stderr, /claim .* was released|released/, "stderr must confirm claim release");

    // Most important: the task must NOT carry an orphan claim.
    const state = await readStateSafe(projectRoot);
    const node = state.nodes[taskId];
    assert.ok(node, "task should still exist");
    // climier release nulls out the claim rather than deleting the key;
    // either shape means the claim is gone.
    const stillClaimed =
      node.claim && typeof node.claim === "object" && node.claim.by;
    assert.ok(
      !stillClaimed,
      `claim must be released after worktree add failure; got ${JSON.stringify(node.claim)}`,
    );
    assert.equal(node.status, "open", "task should be back to open status");
  } finally {
    await cleanupWorktree(projectRoot, taskId, agentId);
    await rmProject(projectRoot);
    await fsp.rm(fakeBin, { recursive: true, force: true });
  }
});
