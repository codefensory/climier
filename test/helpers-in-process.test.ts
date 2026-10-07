// The default runCli must exercise the real dispatch pipeline inside the
// test process: spawning one node per CLI call is the dominant cost of the
// suite. runCliSpawn stays available for the few tests that need real
// process isolation (parallel writers, stdin consumers).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  createTempProject,
  rmTempProject,
  runCli,
  runCliInProcess,
  runCliSpawn,
  exampleState,
  writeCanonicalState,
} from "./helpers.ts";

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function assertSameResult(inProcess, spawned, label) {
  assert.equal(
    inProcess.code,
    spawned.code,
    `${label}: exit code mismatch (in-process ${inProcess.code} vs spawn ${spawned.code})\nin-process stdout: ${inProcess.stdout}\nspawn stdout: ${spawned.stdout}\nspawn stderr: ${spawned.stderr}`,
  );
  assert.equal(inProcess.stdout, spawned.stdout, `${label}: stdout mismatch`);
  assert.equal(inProcess.stderr, spawned.stderr, `${label}: stderr mismatch`);
}

test("runCli defaults to the in-process harness and runCliSpawn stays opt-in", () => {
  assert.equal(runCli, runCliInProcess, "runCli must be the in-process implementation");
  assert.notEqual(runCli, runCliSpawn, "runCliSpawn must stay a distinct spawned-process path");
});

test("in-process runCli restores cwd and env around a successful call", async () => {
  const dir = await createTempProject();
  const cwdBefore = process.cwd();
  const agentBefore = process.env.CLIMIER_AGENT;
  try {
    process.env.CLIMIER_AGENT = "before-agent";
    const result = await runCli(["init"], { cwd: dir, env: { CLIMIER_AGENT: "" } });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(process.cwd(), cwdBefore, "cwd must be restored after the call");
    assert.equal(process.env.CLIMIER_AGENT, "before-agent", "env override must be restored after the call");
    const meta = JSON.parse(await fs.readFile(`${dir}/.climier.json`, "utf8"));
    assert.equal(typeof meta.project_id, "string");
  } finally {
    restoreEnv("CLIMIER_AGENT", agentBefore);
    await rmTempProject(dir);
  }
});

test("in-process runCli restores cwd and env after a failed call", async () => {
  const dir = await createTempProject();
  const cwdBefore = process.cwd();
  const agentBefore = process.env.CLIMIER_AGENT;
  try {
    process.env.CLIMIER_AGENT = "before-agent";
    const result = await runCli(["take", "T1"], { cwd: dir, env: { CLIMIER_AGENT: "" } });
    assert.equal(result.code, 1, result.stdout);
    assert.equal(process.cwd(), cwdBefore, "cwd must be restored after a failing call");
    assert.equal(process.env.CLIMIER_AGENT, "before-agent", "env override must be restored after a failing call");
  } finally {
    restoreEnv("CLIMIER_AGENT", agentBefore);
    await rmTempProject(dir);
  }
});

// Spawning parity is expensive; keep one representative per response class:
// early text (help), usage error (no command), unknown command, success JSON
// (status), missing-node error, and env-override error.
test("in-process and spawn harnesses agree on exit codes and envelopes", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, exampleState());
    const cases = [
      [["--help"], undefined],
      [[], undefined],
      [["unknown-command"], undefined],
      [["--project", dir, "status"], undefined],
      [["--project", dir, "show", "missing"], undefined],
      [["--project", dir, "take", "F0.T1"], { CLIMIER_AGENT: "" }],
    ];
    for (const [args, env] of cases) {
      const options = env ? { env } : undefined;
      assertSameResult(await runCliInProcess(args, options), await runCliSpawn(args, options), JSON.stringify(args));
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("runCliSpawn keeps cwd and env semantics for the isolation path", async () => {
  const dir = await createTempProject();
  try {
    const result = await runCliSpawn(["init"], { cwd: dir, env: { CLIMIER_AGENT: "" } });
    assert.equal(result.code, 0, result.stdout);
    const meta = JSON.parse(await fs.readFile(`${dir}/.climier.json`, "utf8"));
    assert.equal(typeof meta.project_id, "string");
  } finally {
    await rmTempProject(dir);
  }
});
