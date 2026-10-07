// lock.mjs: file lock for multi-agent atomic operations.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, lockFilePath, writeCanonicalState } from "./helpers.ts";
import { commitFencedStateUnderLock, readFencedStateUnderLock } from "../src/storage/ledger.ts";

type FencedState = { version: number; revision: number; log: Array<{ action: string }> };

test("withLock acquires and releases on success", async () => {
  const { withLock } = await importFresh("./storage/lock.ts");
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


async function assertSameProjectLockIsReused(withLock, assertActiveLockContext, dir, context) {
  const nested = await withLock(dir, async (nestedContext) => nestedContext);
  assert.equal(nested, context);
  assertActiveLockContext(nested, dir);
}

async function assertForeignProjectLockIsDistinct({ withLock, assertActiveLockContext, dir, other, context }) {
  await withLock(other, async (foreignContext) => {
    assert.notEqual(foreignContext, context);
    assertActiveLockContext(foreignContext, other);
    assert.throws(() => assertActiveLockContext(foreignContext, dir), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
  });
}

function acquireLockAfterRelease(withLock, dir) {
  return new Promise((resolve, reject) => {
    setTimeout(() => withLock(dir, async () => "fresh-lock-acquired", { timeoutMs: 500 }).then(resolve, reject), 20);
  });
}

async function assertNestedProjectLockIsDistinct(withLock, projectA, projectB, contextA) {
  await withLock(projectB, async (contextB) => {
    assert.notEqual(contextA, contextB);
    const returnedContextA = await withLock(projectA, async (nestedContextA) => nestedContextA, {
      timeoutMs: 100,
      retryEveryMs: 10,
    });
    assert.equal(returnedContextA, contextA);
  });
}

test("withLock reuses only the live same-project capability in nested async scope", async () => {
  const { withLock, assertActiveLockContext } = await importFresh("./storage/lock.ts");
  const dir = await createTempProject();
  const other = await createTempProject();
  try {
    let activeContext;
    let delayedAcquire;
    await withLock(dir, async (context) => {
      activeContext = context;
      await assertSameProjectLockIsReused(withLock, assertActiveLockContext, dir, context);
      await assertForeignProjectLockIsDistinct({ withLock, assertActiveLockContext, dir, other, context });
      delayedAcquire = acquireLockAfterRelease(withLock, dir);
    });
    assert.throws(() => assertActiveLockContext(activeContext, dir), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
    assert.equal(await delayedAcquire, "fresh-lock-acquired");
  } finally {
    await rmTempProject(dir);
    await rmTempProject(other);
  }
});

test("withLock preserves active project capabilities across nested A-to-B-to-A scopes", async () => {
  const { withLock } = await importFresh("./storage/lock.ts");
  const projectA = await createTempProject();
  const projectB = await createTempProject();
  try {
    await withLock(projectA, async (contextA) => {
      await assertNestedProjectLockIsDistinct(withLock, projectA, projectB, contextA);
    });
  } finally {
    await rmTempProject(projectA);
    await rmTempProject(projectB);
  }
});

test("withLock blocks concurrent acquires; second waits then succeeds", async () => {
  const { withLock } = await importFresh("./storage/lock.ts");
  const dir = await createTempProject();
  try {
    const order: string[] = [];
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
  const { withLock } = await importFresh("./storage/lock.ts");
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
  const { withLock } = await importFresh("./storage/lock.ts");
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

test("stale lock recovery requires verified manual removal before schema-1 operation resumes", async () => {
  const { withLock } = await import("../src/storage/lock.ts");
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, { version: 1, nodes: {}, edges: [], initiatives: {}, log: [] });
    const lockPath = lockFilePath(dir);
    await fs.writeFile(lockPath, JSON.stringify({ heldBy: "dead-process", at: 0 }));

    await assert.rejects(
      withLock(dir, async () => {}, { timeoutMs: 200, retryEveryMs: 50 }),
      /lock/
    );
    await fs.access(lockPath);

    await fs.rm(lockPath);
    await withLock(dir, async (lockContext) => {
      const current = await readFencedStateUnderLock(lockContext, { projectDir: dir }) as FencedState;
      assert.equal(current.version, 1);
      const next = {
        ...current,
        revision: current.revision + 1,
        log: [...current.log, { action: "stale-lock-recovery-test" }],
      };
      await commitFencedStateUnderLock(lockContext, next, { projectDir: dir });
    });

    const recovered = await withLock(dir, async (lockContext) => (
      readFencedStateUnderLock(lockContext, { projectDir: dir }) as Promise<FencedState>
    ));
    assert.equal(recovered.version, 1);
    const last = recovered.log.at(-1);
    assert.ok(last);
    assert.equal(last.action, "stale-lock-recovery-test");
  } finally {
    await rmTempProject(dir);
  }
});

test("withLock times out if holder never releases", async () => {
  const { withLock } = await importFresh("./storage/lock.ts");
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
