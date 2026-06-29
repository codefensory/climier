// CLI dispatch: each command runs end-to-end via the real bin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, runCli } from "./helpers.mjs";

test("CLI: init then status", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init", "--seed", "migration"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "status"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /READY|IN PROGRESS|ready|in.progress|done/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: init --seed migration then ready lists claimable tasks", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init", "--seed", "migration"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "ready"]);
    assert.equal(r.code, 0, r.stderr);
    // expect at least one task id in output
    assert.match(r.stdout, /F1\.T1|F0\.T1/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: claim fails without --as", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "claim", "F0.T1"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--as/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: claim --as works, then done --as note works", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    // F0.T1 has no deps; claimable directly.
    const c = await runCli(["--project", dir, "claim", "F0.T1", "--as", "agent-1"]);
    assert.equal(c.code, 0, c.stderr);
    const d = await runCli(["--project", dir, "done", "F0.T1", "shipped", "--as", "agent-1"]);
    assert.equal(d.code, 0, d.stderr);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: reopen --as orchestrator rolls back a done task end-to-end", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    await runCli(["--project", dir, "claim", "F0.T1", "--as", "agent-1"]);
    await runCli(["--project", dir, "done", "F0.T1", "shipped", "--as", "agent-1"]);

    const r = await runCli([
      "--project", dir, "reopen", "F0.T1", "le falta validacion", "--as", "orchestrator",
    ]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /reopened F0\.T1/);

    // F0.T2 (depends on F0.T1) should be blocked again, not ready.
    const ready = await runCli(["--project", dir, "ready"]);
    assert.equal(ready.code, 0, ready.stderr);
    assert.equal(/F0\.T2/.test(ready.stdout), false, "F0.T2 should be blocked after reopen");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: reopen by a stranger fails with non-zero exit", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    await runCli(["--project", dir, "claim", "F0.T1", "--as", "agent-1"]);
    await runCli(["--project", dir, "done", "F0.T1", "shipped", "--as", "agent-1"]);

    const r = await runCli([
      "--project", dir, "reopen", "F0.T1", "I want to", "--as", "agent-2",
    ]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /not authorized/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: pre-claim on a ready task reports can_claim YES", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "pre-claim", "F0.T1"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /PRE-CLAIM F0\.T1/);
    assert.match(r.stdout, /can_claim: YES/);
    assert.match(r.stdout, /ready to claim/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: add-decision creates an open decision", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "add-decision", "D9", "--title", "investigar X", "--applies-to", "F9.T1,F9.T2"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /added decision D9/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: add-decision fails without --title", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "add-decision", "D9"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--title required/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: --help prints help and exits 0", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "--help"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /climier/i);
    assert.match(r.stdout, /claim/);
    assert.match(r.stdout, /pre-claim/);
    assert.match(r.stdout, /add-decision/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: -h prints help and exits 0", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "-h"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /climier/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: help command prints help and exits 0", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "help"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /claim/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: pre-claim on a missing task exits non-zero with clear error", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "pre-claim", "NOPE"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /not found/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: unknown command exits non-zero", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "nosuchcmd"]);
    assert.notEqual(r.code, 0);
  } finally {
    await rmTempProject(dir);
  }
});
