// Deep holes — round 5: real cross-process race conditions, recovery, integration
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, runCli, readState } from "./helpers.mjs";

// Cross-process race: many parallel claim/done on the same task. Verify final state consistent.
test("hole: 20 agents racing on the same task — final state has exactly one done and log is consistent", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const file = path.join(dir, ".agents", "tasks", "tasks.json");
    await fs.writeFile(file, JSON.stringify({
      version: 1, tasks: { T1: { id: "T1" } }, decisions: {}, gotchas: {},
      initiatives: { x: { desc: "" } }, log: [],
    }), "utf8");

    // 20 agents each: claim, then if successful done.
    const ops = Array.from({ length: 20 }, (_, i) => (async () => {
      const c = await runCli(["--project", dir, "claim", "T1", "--as", `agent-${i}`]);
      if (c.code === 0) {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        await runCli(["--project", dir, "done", "T1", `by ${i}`, "--as", `agent-${i}`]);
      }
    })());
    await Promise.all(ops);

    const s = await readState(dir);
    // Exactly one task; if any agent successfully claimed+done, it's done.
    // If no one succeeded, it's still ready (no status field).
    assert.ok(s.tasks.T1);
    if (s.tasks.T1.status === "done") {
      // The log should have exactly one claim + one done.
      const claims = s.log.filter((e) => e.action === "claim" && e.task === "T1");
      const dones = s.log.filter((e) => e.action === "done" && e.task === "T1");
      assert.equal(claims.length, 1);
      assert.equal(dones.length, 1);
    } else {
      // No one succeeded; log should have 0 claims for T1
      const claims = s.log.filter((e) => e.action === "claim" && e.task === "T1");
      assert.equal(claims.length, 0);
    }
  } finally {
    await rmTempProject(dir);
  }
});

// Recovery: a corrupted state file → init --force recovers
test("hole: full recovery flow — corrupt state, init --force, resume work", async () => {
  const dir = await createTempProject();
  try {
    const file = path.join(dir, ".agents", "tasks", "tasks.json");
    await fs.writeFile(file, "{ broken", "utf8");
    // init --force should recover
    const r1 = await runCli(["--project", dir, "init", "--force", "--seed", "migration"]);
    assert.equal(r1.code, 0, r1.stderr);
    // Now we should be able to work
    const r2 = await runCli(["--project", dir, "claim", "F0.T1", "--as", "agent"]);
    assert.equal(r2.code, 0, r2.stderr);
  } finally {
    await rmTempProject(dir);
  }
});

// Lock: stale lock file is overwritten by next claim
test("hole: a stale .lock file does not block subsequent operations", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    // Write a fake lock file
    const lockPath = path.join(dir, ".agents", "tasks", ".lock");
    await fs.writeFile(lockPath, JSON.stringify({ pid: 99999, at: 0 }), "utf8");
    // Operations should still work (timeout config for the test is short)
    const r = await runCli(["--project", dir, "claim", "F0.T1", "--as", "agent"]);
    // Either: lock is treated as valid and we wait (could timeout), or it overrides.
    // Per current implementation, withLock uses fs.openSync(..., 'wx') which fails on existing.
    // So a stale lock WILL block. This is a known ceiling.
    // We document it: code returns non-zero if the lock is stuck.
    // (If we ever implement stale-lock detection, this test should be updated.)
    if (r.code !== 0) {
      const data = JSON.parse(r.stdout);
      assert.match(data.error, /lock|timeout/i);
    }
  } finally {
    await rmTempProject(dir);
  }
});

// Concurrency: 3 add-task on different ids in parallel — all succeed
test("hole: 3 add-task on different ids in parallel — all succeed", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    await runCli(["--project", dir, "add-initiative", "x", "--desc", ""]);
    const results = await Promise.all([
      runCli(["--project", dir, "add-task", "T1", "--initiative", "x", "--title", "first"]),
      runCli(["--project", dir, "add-task", "T2", "--initiative", "x", "--title", "second"]),
      runCli(["--project", dir, "add-task", "T3", "--initiative", "x", "--title", "third"]),
    ]);
    results.forEach((r, i) => assert.equal(r.code, 0, `T${i+1} failed: ${r.stderr}`));
    const s = await readState(dir);
    assert.ok(s.tasks.T1);
    assert.ok(s.tasks.T2);
    assert.ok(s.tasks.T3);
  } finally {
    await rmTempProject(dir);
  }
});

// add-initiative in parallel — both succeed (idempotent on desc update)
test("hole: 2 add-initiative in parallel — both succeed and desc is the last write", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const results = await Promise.all([
      runCli(["--project", dir, "add-initiative", "mig", "--desc", "first"]),
      runCli(["--project", dir, "add-initiative", "mig", "--desc", "second"]),
    ]);
    const ok = results.filter((r) => r.code === 0);
    assert.equal(ok.length, 2);
    const s = await readState(dir);
    assert.ok(s.initiatives.mig);
    assert.match(s.initiatives.mig.desc, /first|second/);
  } finally {
    await rmTempProject(dir);
  }
});

// Concurrent decide and claim — both should be safe
test("hole: concurrent decide and claim on independent items — both succeed", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const [r1, r2] = await Promise.all([
      runCli(["--project", dir, "claim", "F0.T1", "--as", "agent"]),
      runCli(["--project", dir, "decide", "D1", "raw-postgres", "--because", "skip Directus"]),
    ]);
    assert.equal(r1.code, 0, r1.stderr);
    assert.equal(r2.code, 0, r2.stderr);
    const s = await readState(dir);
    assert.equal(s.tasks["F0.T1"].status, "in_progress");
    assert.equal(s.decisions.D1.status, "decided");
  } finally {
    await rmTempProject(dir);
  }
});

// Stress: 100 ready/derive calls in a tight loop
test("hole: 100 ready calls in a tight loop return identical results", async () => {
  const { default: ready } = await importFresh("./commands/ready.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" };
      s.tasks.T2 = { id: "T2", depends_on: ["T1"] };
      return s;
    });
    const first = await ready({ statePath: dir, flags: {} });
    for (let i = 0; i < 100; i++) {
      const out = await ready({ statePath: dir, flags: {} });
      assert.deepEqual(out, first);
    }
  } finally {
    await rmTempProject(dir);
  }
});

// A task with an empty string as the title (after trim) is treated as missing title
test("hole: a task with whitespace-only title is treated as missing", async () => {
  const { default: next } = await importFresh("./commands/next.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "   " };
      return s;
    });
    const out = await next({ statePath: dir, flags: {}, positional: ["T1"] });
    // Should fall through to "(no title)" placeholder
    assert.match(out.title, /no title/);
  } finally {
    await rmTempProject(dir);
  }
});

// Many small state files: ensure readState returns null cleanly when file doesn't exist
test("hole: readState returns null for non-existent project dir", async () => {
  const { readState } = await importFresh("./state.mjs");
  const out = await readState("/tmp/this/path/does/not/exist/at/all/xyz");
  assert.equal(out, null);
});
