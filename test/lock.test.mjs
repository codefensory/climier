// lock.mjs: file lock for multi-agent atomic operations.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, lockFilePath } from "./helpers.mjs";

test("withLock acquires and releases on success", async () => {
  const { withLock } = await importFresh("./storage/lock.mjs");
  const dir = await createTempProject();
  try {
    let ran = false;
    await withLock(dir, async () => {
      ran = true;
    });
    assert.equal(ran, true);
    // Lock file should not exist after release
    await assert.rejects(fs.access(lockFilePath(dir)));
  } finally {
    await rmTempProject(dir);
  }
});

test("withLock reuses only the live same-project capability in nested async scope", async () => {
  const { withLock, assertActiveLockContext } = await importFresh("./storage/lock.mjs");
  const dir = await createTempProject();
  const other = await createTempProject();
  try {
    let activeContext;
    let delayedAcquire;
    await withLock(dir, async (context) => {
      activeContext = context;
      const nested = await withLock(dir, async (nestedContext) => nestedContext);
      assert.equal(nested, context);
      assertActiveLockContext(nested, dir);
      await withLock(other, async (foreignContext) => {
        assert.notEqual(foreignContext, context);
        assertActiveLockContext(foreignContext, other);
        assert.throws(() => assertActiveLockContext(foreignContext, dir), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
      });
      delayedAcquire = new Promise((resolve, reject) => {
        setTimeout(() => withLock(dir, async () => "fresh-lock-acquired", { timeoutMs: 500 }).then(resolve, reject), 20);
      });
    });
    assert.throws(() => assertActiveLockContext(activeContext, dir), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
    assert.equal(await delayedAcquire, "fresh-lock-acquired");
  } finally {
    await rmTempProject(dir);
    await rmTempProject(other);
  }
});

test("withLock preserves active project capabilities across nested A-to-B-to-A scopes", async () => {
  const { withLock, assertActiveLockContext } = await importFresh("./storage/lock.mjs");
  const projectA = await createTempProject();
  const projectB = await createTempProject();
  try {
    await withLock(projectA, async (contextA) => {
      await withLock(projectB, async (contextB) => {
        assert.notEqual(contextA, contextB);
        const returnedContextA = await withLock(projectA, async (nestedContextA) => nestedContextA, {
          timeoutMs: 100,
          retryEveryMs: 10,
        });
        assert.equal(returnedContextA, contextA);
        assertActiveLockContext(returnedContextA, projectA);
      });
    });
  } finally {
    await rmTempProject(projectA);
    await rmTempProject(projectB);
  }
});

test("withLock blocks concurrent acquires; second waits then succeeds", async () => {
  const { withLock } = await importFresh("./storage/lock.mjs");
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
  const { withLock } = await importFresh("./storage/lock.mjs");
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

test("withLock does not auto-clear an old lock file", async () => {
  const { withLock } = await importFresh("./storage/lock.mjs");
  const dir = await createTempProject();
  try {
    const lockPath = lockFilePath(dir);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({ heldBy: "ghost", at: 0 }));
    await assert.rejects(
      withLock(dir, async () => {}, { timeoutMs: 200, retryEveryMs: 50 }),
      /lock/
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("withLock times out if holder never releases", async () => {
  const { withLock } = await importFresh("./storage/lock.mjs");
  const dir = await createTempProject();
  try {
    const lockPath = lockFilePath(dir);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({ heldBy: "ghost", at: Date.now() }));
    await assert.rejects(
      withLock(dir, async () => {}, { timeoutMs: 200, retryEveryMs: 50 }),
      /lock/
    );
  } finally {
    await rmTempProject(dir);
  }
});
