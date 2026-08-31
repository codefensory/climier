// Tests for the EVIDENCE note emission in finish-task.sh and the read-only
// integration-preflight.sh.
//
// These tests exercise the bash scripts via real subprocesses against a
// temporary git repo and a sandboxed Climier state. The scripts are the
// contract for "structured evidence + preflight" agreed in
// T-workflow-evidence-preflight.
//
// Important: each invocation runs in its own private CLIMIER_HOME under
// /tmp/climier-wp-test-* (a namespace distinct from smoke-sandbox's
// climier-smoke-*). Tests run setup + finish-task + preflight inside a
// SINGLE subprocess invocation so state is shared, and the private home
// is removed when that subprocess closes. We deliberately avoid
// smoke-sandbox.sh here because its /tmp/climier-smoke-* namespace is
// observed by test/smoke-sandbox.test.mjs; running both files in
// parallel under npm test would race on that directory listing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BIN } from "./helpers.mjs";

const ROOT = path.resolve(process.cwd());
const FINISH = path.join(ROOT, ".agents/skills/climier-worker", "finish-task.sh");
const PREFLIGHT = path.join(ROOT, ".agents/skills/climier-validator", "integration-preflight.sh");

// finish-task.sh intentionally uses the stable `climier` command in
// production. Point it at this worktree only inside these subprocess tests,
// whose setup creates v3 state through the local binary.
const CLIMIER_SHIM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "climier-test-cli-shim-"));
const CLIMIER_SHIM = path.join(CLIMIER_SHIM_DIR, "climier");
fs.writeFileSync(CLIMIER_SHIM, `#!/usr/bin/env bash\nexec ${process.execPath} ${JSON.stringify(BIN)} "$@"\n`);
fs.chmodSync(CLIMIER_SHIM, 0o755);
process.on("exit", () => { try { fs.rmSync(CLIMIER_SHIM_DIR, { recursive: true, force: true }); } catch {} });

function tmp(prefix = path.join(os.tmpdir(), "climier-wp-test-")) {
  return fs.mkdtempSync(prefix);
}

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

// Run a script body with a private CLIMIER_HOME under a namespace that
// does not collide with /tmp/climier-smoke-* (used by smoke-sandbox.sh
// and asserted by test/smoke-sandbox.test.mjs). The home is removed
// after the subprocess closes; if the test runner is killed mid-flight,
// the dir is left under /tmp and never touches the real ~/.climier.
function runIsolated(script, env = process.env) {
  const home = tmp();
  fs.chmodSync(home, 0o700);
  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", script], {
      env: {
        ...env,
        PATH: `${CLIMIER_SHIM_DIR}:${env.PATH || process.env.PATH}`,
        CLIMIER_HOME: home,
      },
      cwd: ROOT,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
      resolve({ stdout, stderr, code });
    });
  });
}

// Make a small git repo + worktree with one commit ready to validate.
function makeRepo() {
  const repo = tmp();
  git(repo, ["init", "-q", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "t@example.io"]);
  git(repo, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  fs.mkdirSync(path.join(repo, "sub"));
  fs.writeFileSync(path.join(repo, "sub", "x.sh"), "#!/usr/bin/env bash\necho ok\n");
  git(repo, ["add", "sub/x.sh"]);
  git(repo, ["commit", "-q", "-m", "add x.sh"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const wt = path.join(path.dirname(repo), `wt-${path.basename(repo)}`);
  git(repo, ["branch", "work/T-wp-test-agent1", "main"]);
  git(repo, ["worktree", "add", "-q", wt, "work/T-wp-test-agent1"]);
  fs.appendFileSync(path.join(wt, "README.md"), "task change\n");
  git(wt, ["add", "README.md"]);
  git(wt, ["commit", "-q", "-m", "do task [T-wp-test]"]);
  return { repo, wt, baseSha };
}

function setupFinishScript({ repo, wt, extraFinishArgs = "" }) {
  return [
    `cd '${repo}'`,
    `node ${BIN} --project '${repo}' init >/dev/null`,
    `node ${BIN} --project '${repo}' add-initiative workflow --as orchestrator >/dev/null`,
    `node ${BIN} --project '${repo}' add-task T-wp-test --initiative workflow --title "wp test" --body "b" --acceptance "a" --blocked-by "" --as orchestrator >/dev/null`,
    `node ${BIN} --project '${repo}' update T-wp-test --body "b" --acceptance "a" --meta '{"execution":{"checks":["bash -n sub/x.sh","bash -n missing-file.sh","true"]}}' --as orchestrator >/dev/null`,
    `node ${BIN} --project '${repo}' take T-wp-test --as codex-worker >/dev/null`,
    `cd '${wt}'`,
    `bash '${FINISH}' T-wp-test codex-worker 'smoke' ${extraFinishArgs}`,
  ].join("\n");
}

function cleanup({ repo, wt }) {
  try { spawnSync("git", ["-C", repo, "worktree", "remove", "--force", wt], { encoding: "utf8" }); } catch {}
  try { fs.rmSync(wt, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
}

function parseEvidence(r) {
  // Extract the EVIDENCE JSON via a node helper that locates the first
  // occurrence of 'EVIDENCE {' in the resolve JSON and returns the parsed
  // object. Robust against nested braces inside files/checks arrays.
  const snippet =
    `let s="";` +
    `process.stdin.on("data",d=>s+=d);` +
    `process.stdin.on("end",()=>{` +
    `const i=s.indexOf("EVIDENCE {");` +
    `if(i<0)process.exit(2);` +
    `const j=i+"EVIDENCE ".length;` +
    `let depth=0,k=j,ok=false;` +
    `for(;k<s.length;k++){` +
    `if(s[k]==="{")depth++;` +
    `else if(s[k]==="}"){depth--;if(depth===0){ok=true;break;}}` +
    `}` +
    `if(!ok)process.exit(3);` +
    `process.stdout.write(s.slice(j,k+1));` +
    `});`;
  const parser = spawnSync("node", ["-e", snippet], {
    input: r.stdout,
    encoding: "utf8",
  });
  if (parser.status !== 0) {
    throw new Error(
      `parseEvidence: node parser exited ${parser.status}; stderr=${parser.stderr}; stdout-head=${(r.stdout || "").slice(0, 200)}`,
    );
  }
  return JSON.parse(parser.stdout);
}

test("finish-task.sh: emits WORKTREE + EVIDENCE notes with required fields", async () => {
  const { repo, wt, baseSha } = makeRepo();
  try {
    const r = await runIsolated(setupFinishScript({ repo, wt }));
    assert.equal(r.code, 0, `finish exited ${r.code}; stderr=${r.stderr}`);
    assert.match(r.stdout, /WORKTREE path=.*branch=work\/T-wp-test-agent1/);
    const payload = parseEvidence(r);
    for (const f of ["task", "commit", "branch", "worktree", "base_ref", "base_sha", "files", "checks"]) {
      assert.ok(f in payload, `EVIDENCE missing field: ${f}`);
    }
    assert.equal(payload.task, "T-wp-test");
    assert.match(payload.commit, /^[0-9a-f]{40}$/);
    assert.equal(payload.base_ref, "main");
    assert.equal(payload.base_sha, baseSha);
    assert.ok(Array.isArray(payload.files));
    assert.ok(payload.files.some((f) => (f.path || f) === "README.md"), "README.md in files");
    assert.ok(Array.isArray(payload.checks));
  } finally {
    cleanup({ repo, wt });
  }
});

test("finish-task.sh: EVIDENCE records per-check ok and does not leak commit body", async () => {
  const { repo, wt } = makeRepo();
  try {
    const r = await runIsolated(setupFinishScript({ repo, wt }));
    assert.equal(r.code, 0, `finish exited ${r.code}; stderr=${r.stderr}`);
    const payload = parseEvidence(r);
    const body = "do task [T-wp-test]";
    assert.ok(!r.stdout.includes(body), "EVIDENCE leaked commit message body");
    assert.equal(payload.checks.length, 3);
    const byName = Object.fromEntries(payload.checks.map((c) => [c.name, c]));
    assert.equal(byName["bash -n sub/x.sh"].ok, true);
    assert.equal(byName["bash -n missing-file.sh"].ok, false);
    assert.equal(byName["true"].ok, true);
  } finally {
    cleanup({ repo, wt });
  }
});

test("finish-task.sh: --evidence-file merges caller JSON with auto-detected fields", async () => {
  const { repo, wt } = makeRepo();
  try {
    const evidencePath = path.join(repo, "caller-evidence.json");
    const caller = {
      task: "T-wp-test",
      files: [{ path: "caller-supplied.txt", status: "A" }],
      checks: [{ name: "echo ok", ok: true }],
    };
    fs.writeFileSync(evidencePath, JSON.stringify(caller));
    const script = setupFinishScript({ repo, wt, extraFinishArgs: `--evidence-file=${evidencePath}` });
    const r = await runIsolated(script);
    assert.equal(r.code, 0, `finish exited ${r.code}; stderr=${r.stderr}`);
    const payload = parseEvidence(r);
    assert.deepEqual(payload.files, caller.files);
    assert.deepEqual(payload.checks, caller.checks);
    assert.match(payload.commit, /^[0-9a-f]{40}$/);
    assert.equal(payload.base_ref, "main");
  } finally {
    cleanup({ repo, wt });
  }
});

test("integration-preflight.sh: parses EVIDENCE JSON and reports clean state", async () => {
  const { repo, wt } = makeRepo();
  try {
    const script = setupFinishScript({ repo, wt }) + `
      bash '${PREFLIGHT}' --project-root '${repo}' --task T-wp-test --json
      echo "PREFLIGHT_EC=$?"
    `;
    const r = await runIsolated(script);
    const m = r.stdout.match(/\{[\s\S]*\}\nPREFLIGHT_EC=(\d+)/);
    assert.ok(m, "no preflight output captured");
    assert.equal(m[1], "0", `preflight exit 1; stdout=${r.stdout.slice(-500)} stderr=${r.stderr}`);
    const jsonStart = r.stdout.indexOf("{\n  \"ok\":");
    const json = r.stdout.slice(jsonStart, r.stdout.indexOf("\nPREFLIGHT_EC="));
    const o = JSON.parse(json);
    assert.equal(o.ok, true);
    assert.equal(o.note.kind, "EVIDENCE");
    assert.equal(o.note.source, "climier-context");
    assert.equal(o.base.match, true);
    assert.equal(o.base.divergence, "clean");
    assert.equal(o.task_commit.match, true);
    assert.equal(o.worktree.clean, true);
    assert.equal(o.verdict, "clean");
    assert.deepEqual(o.overlap_paths, []);
  } finally {
    cleanup({ repo, wt });
  }
});

test("integration-preflight.sh: legacy WORKTREE note degrades with explicit reason", async () => {
  const { repo, wt } = makeRepo();
  try {
    // Set up climier with only WORKTREE note, no EVIDENCE.
    const script = [
      `cd '${repo}'`,
      `node ${BIN} --project '${repo}' init >/dev/null`,
      `node ${BIN} --project '${repo}' add-initiative workflow --as orchestrator >/dev/null`,
      `node ${BIN} --project '${repo}' add-task T-wp-test --initiative workflow --title "wp test" --body "b" --acceptance "a" --blocked-by "" --as orchestrator >/dev/null`,
      `node ${BIN} --project '${repo}' take T-wp-test --as codex-worker >/dev/null`,
      `WT_HEAD=$(git -C '${wt}' rev-parse HEAD)`,
      `node ${BIN} --project '${repo}' add-note T-wp-test "WORKTREE path=${wt} branch=work/T-wp-test-agent1 base=main commit=\${WT_HEAD} status=ready-for-validation" --as codex-worker >/dev/null`,
      `bash '${PREFLIGHT}' --project-root '${repo}' --task T-wp-test --json`,
      `echo "PREFLIGHT_EC=$?"`,
    ].join("\n");
    const r = await runIsolated(script);
    const m = r.stdout.match(/\{[\s\S]*\}\nPREFLIGHT_EC=(\d+)/);
    assert.ok(m);
    assert.equal(m[1], "0");
    const json = r.stdout.slice(r.stdout.indexOf('{\n  "ok":'), r.stdout.indexOf("\nPREFLIGHT_EC="));
    const o = JSON.parse(json);
    assert.equal(o.note.kind, "WORKTREE");
    assert.equal(o.verdict, "clean");
    assert.ok(o.degraded_reasons.some((s) => s.includes("WORKTREE") && s.includes("base_sha")),
      "degraded_reasons must explain missing base_sha");
    assert.equal(o.base.recorded_sha, "");
  } finally {
    cleanup({ repo, wt });
  }
});

test("integration-preflight.sh: detects overlap when main advances after finish", async () => {
  const { repo, wt } = makeRepo();
  try {
    const script = setupFinishScript({ repo, wt }) + `
      cd '${repo}'
      echo 'main advance' >> README.md
      git commit -aq -m 'main advance'
      bash '${PREFLIGHT}' --project-root '${repo}' --task T-wp-test --json
      echo "PREFLIGHT_EC=$?"
    `;
    const r = await runIsolated(script);
    const m = r.stdout.match(/\{[\s\S]*\}\nPREFLIGHT_EC=(\d+)/);
    assert.ok(m);
    assert.equal(m[1], "1", `preflight exit ${m[1]}; expected 1 on overlap`);
    const json = r.stdout.slice(r.stdout.indexOf('{\n  "ok":'), r.stdout.indexOf("\nPREFLIGHT_EC="));
    const o = JSON.parse(json);
    assert.equal(o.base.match, false);
    assert.equal(o.base.divergence, "base_advanced");
    assert.equal(o.base.main_ahead_of_recorded, 1);
    assert.ok(o.overlap_paths.includes("README.md"));
    assert.equal(o.verdict, "overlap");
  } finally {
    cleanup({ repo, wt });
  }
});

test("integration-preflight.sh: never mutates git state (read-only invariant)", async () => {
  const { repo, wt } = makeRepo();
  try {
    const script = setupFinishScript({ repo, wt }) + `
      BEFORE_HEAD=\$(git -C '${wt}' rev-parse HEAD)
      BEFORE_BRANCH=\$(git -C '${wt}' rev-parse --abbrev-ref HEAD)
      bash '${PREFLIGHT}' --project-root '${repo}' --task T-wp-test
      AFTER_HEAD=\$(git -C '${wt}' rev-parse HEAD)
      AFTER_BRANCH=\$(git -C '${wt}' rev-parse --abbrev-ref HEAD)
      AFTER_STATUS=\$(git -C '${wt}' status --short --untracked-files=all || true)
      echo "HEAD_MATCH=\$([ "\$BEFORE_HEAD" = "\$AFTER_HEAD" ] && echo yes || echo no)"
      echo "BRANCH_MATCH=\$([ "\$BEFORE_BRANCH" = "\$AFTER_BRANCH" ] && echo yes || echo no)"
      echo "STATUS_EMPTY=\$([ -z "\$AFTER_STATUS" ] && echo yes || echo no)"
    `;
    const r = await runIsolated(script);
    assert.equal(r.code, 0, `isolated exit ${r.code}; stderr=${r.stderr}`);
    assert.match(r.stdout, /HEAD_MATCH=yes/);
    assert.match(r.stdout, /BRANCH_MATCH=yes/);
    assert.match(r.stdout, /STATUS_EMPTY=yes/);
  } finally {
    cleanup({ repo, wt });
  }
});

test("integration-preflight.sh: --note-text parses EVIDENCE without touching climier", () => {
  const { repo, wt } = makeRepo();
  try {
    // Manually construct an EVIDENCE note and pass via --note-text.
    const baseSha = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
    const wtHead = git(wt, ["rev-parse", "HEAD"]).stdout.trim();
    const evidence = `EVIDENCE {"task":"T-wp-test","commit":"${wtHead}","branch":"work/T-wp-test-agent1","worktree":"${wt}","base_ref":"main","base_sha":"${baseSha}","files":[{"path":"README.md","status":"M"}],"checks":[]}`;
    const r = spawnSync(
      "bash",
      [PREFLIGHT, "--project-root", repo, "--task", "T-wp-test", "--note-text", evidence, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, `preflight exit ${r.status}; stderr=${r.stderr}`);
    const o = JSON.parse(r.stdout);
    assert.equal(o.note.source, "override");
    assert.equal(o.task, "T-wp-test");
    assert.equal(o.base.match, true);
    assert.equal(o.verdict, "clean");
  } finally {
    cleanup({ repo, wt });
  }
});

test("integration-preflight.sh: refuses malformed EVIDENCE JSON (exit 2)", () => {
  const { repo } = makeRepo();
  try {
    const r = spawnSync(
      "bash",
      [PREFLIGHT, "--project-root", repo, "--task", "T-wp-test", "--note-text", "EVIDENCE not-json-at-all", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not valid JSON/);
  } finally {
    cleanup({ repo, wt: path.join(path.dirname(repo), `wt-${path.basename(repo)}`) });
  }
});

test("integration-preflight.sh: missing note returns 2", () => {
  const { repo } = makeRepo();
  try {
    const r = spawnSync(
      "bash",
      [PREFLIGHT, "--project-root", repo, "--task", "T-missing"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no EVIDENCE or WORKTREE note/);
  } finally {
    cleanup({ repo, wt: path.join(path.dirname(repo), `wt-${path.basename(repo)}`) });
  }
});
