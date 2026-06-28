// lock.mjs: file lock for multi-agent atomic operations.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("withLock acquires and releases on success", async () => {
  const { withLock } = await importFresh("./lock.mjs");
  const dir = await createTempProject();
  try {
    let ran = false;
    await withLock(dir, async () => {
      ran = true;
    });
    assert.equal(ran, true);
    // Lock file should not exist after release
    await assert.rejects(fs.access(path.join(dir, ".agents", "tasks", ".lock")));
  } finally {
    await rmTempProject(dir);
  }
});

test("withLock blocks concurrent acquires; second waits then succeeds", async () => {
  const { withLock } = await importFresh("./lock.mjs");
  const dir = await createTempProject();
  try {
    const order = [];
    const a = withLock(dir, async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 150));
      order.push("a-end");
    });
    // give a moment for a to acquire
    await new Promise((r) => setTimeout(r, 30));
    const b = withLock(dir, async () => {
      order.push("b-start");
    });
    await Promise.all([a, b]);
    assert.deepEqual(order, ["a-start", "a-end", "b-start"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("withLock releases on mutator error (no deadlock)", async () => {
  const { withLock } = await importFresh("./lock.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      withLock(dir, async () => {
        throw new Error("boom");
      })
    );
    let ran = false;
    await withLock(dir, async () => {
      ran = true;
    });
    assert.equal(ran, true);
  } finally {
    await rmTempProject(dir);
  }
});

test("withLock times out if holder never releases", async () => {
  const { withLock } = await importFresh("./lock.mjs");
  const dir = await createTempProject();
  try {
    // Hold the lock for 5s by simulating a stale lock file written manually.
    const lockPath = path.join(dir, ".agents", "tasks", ".lock");
    await fs.writeFile(lockPath, JSON.stringify({ heldBy: "ghost", at: Date.now() }));
    await assert.rejects(
      withLock(dir, async () => {}, { timeoutMs: 200, retryEveryMs: 50 }),
      /lock/
    );
  } finally {
    await rmTempProject(dir);
  }
});
