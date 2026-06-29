// CLI dispatch: each command runs end-to-end via the real bin.
// All output is JSON to stdout. All errors are JSON to stdout.
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
    const data = JSON.parse(r.stdout);
    assert.ok(data.counts);
    assert.ok(Array.isArray(data.in_progress));
    assert.ok(Array.isArray(data.ready));
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
    const data = JSON.parse(r.stdout);
    assert.ok(Array.isArray(data));
    assert.ok(data.some((t) => ["F0.T1", "F1.T1"].includes(t.id)));
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
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error, /--as/i);
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
    const cdata = JSON.parse(c.stdout);
    assert.equal(cdata.task.id, "F0.T1");
    const d = await runCli(["--project", dir, "done", "F0.T1", "shipped", "--as", "agent-1"]);
    assert.equal(d.code, 0, d.stderr);
    const ddata = JSON.parse(d.stdout);
    assert.equal(ddata.task.status, "done");
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
    const data = JSON.parse(r.stdout);
    assert.equal(data.task.id, "F0.T1");
    assert.equal(data.task.status, "in_progress");

    // F0.T2 (depends on F0.T1) should be blocked again, not ready.
    const ready = await runCli(["--project", dir, "ready"]);
    assert.equal(ready.code, 0, ready.stderr);
    const readyData = JSON.parse(ready.stdout);
    assert.equal(readyData.some((t) => t.id === "F0.T2"), false, "F0.T2 should be blocked after reopen");
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
    const data = JSON.parse(r.stdout);
    assert.match(data.error, /not authorized/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: pre-claim on a ready task reports can_claim true", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "pre-claim", "F0.T1"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.id, "F0.T1");
    assert.equal(data.derived_status, "ready");
    assert.equal(data.can_claim, true);
    assert.deepEqual(data.blockers, []);
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
    const data = JSON.parse(r.stdout);
    assert.equal(data.decision.id, "D9");
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
    const data = JSON.parse(r.stdout);
    assert.match(data.error, /--title required/);
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

test("CLI: pre-claim on a missing task exits non-zero with JSON error", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "pre-claim", "NOPE"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.match(data.error, /not found/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: unknown command exits non-zero with JSON error", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "nosuchcmd"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.match(data.error, /unknown command/);
  } finally {
    await rmTempProject(dir);
  }
});
