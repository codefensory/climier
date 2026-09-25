// lock.mjs: file lock for atomic mutating operations.
import fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { stateFile } from "./state.mjs";

const RETRY_BASE_MS = 25;
const DEFAULT_TIMEOUT_MS = 10_000;
const activeLockContexts = new WeakMap();
const activeProjectLock = new AsyncLocalStorage();

function invalidLockContext() {
  const error = new Error("lock: active project lock capability is required");
  error.code = "CLIMIER_INVALID_LOCK_CONTEXT";
  return error;
}

/** Assert that a capability is active for exactly the requested project. */
export function assertActiveLockContext(lockContext, projectDir) {
  if (!lockContext || (typeof lockContext !== "object" && typeof lockContext !== "function")) {
    throw invalidLockContext();
  }
  const details = activeLockContexts.get(lockContext);
  if (!details?.active || (projectDir !== undefined && details.projectDir !== path.resolve(projectDir))) {
    throw invalidLockContext();
  }
  return true;
}

/** Resolve a live capability to its canonical storage paths for storage APIs. */
export function getActiveLockContext(lockContext) {
  assertActiveLockContext(lockContext);
  const details = activeLockContexts.get(lockContext);
  return Object.freeze({ projectDir: details.projectDir, statePath: details.statePath });
}

/** Return the current live lock capability only when its project matches. */
export function getCurrentLockContext(projectDir) {
  const active = activeProjectLock.getStore();
  const lockContext = active?.lockContexts?.get(path.resolve(projectDir));
  if (!lockContext) return null;
  try {
    assertActiveLockContext(lockContext, projectDir);
    return lockContext;
  } catch (error) {
    if (error.code === "CLIMIER_INVALID_LOCK_CONTEXT") return null;
    throw error;
  }
}

/** Run a storage operation under a live project lock, reusing same-project ALS. */
export async function withCurrentProjectLock(projectDir, fn, opts = {}) {
  const lockContext = getCurrentLockContext(projectDir);
  if (lockContext) return fn(lockContext);
  return withLock(projectDir, fn, opts);
}

function makeLockContext(projectDir) {
  const context = Object.freeze(Object.create(null));
  activeLockContexts.set(context, {
    projectDir: path.resolve(projectDir),
    statePath: stateFile(projectDir),
    active: true,
  });
  return context;
}

function expireLockContext(lockContext) {
  const details = activeLockContexts.get(lockContext);
  if (details) details.active = false;
}

function lockPath(projectDir) {
  return path.join(path.dirname(stateFile(projectDir)), ".lock");
}

async function ensureTasksDir(projectDir) {
  await fs.mkdir(path.dirname(stateFile(projectDir)), { recursive: true });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withLock(projectDir, fn, opts = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const inherited = getCurrentLockContext(resolvedProjectDir);
  if (inherited) return fn(inherited);
  // Detached async work can inherit expired capabilities in its ALS store.
  // getCurrentLockContext rejects those, so acquire a fresh canonical lock.

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryEveryMs = opts.retryEveryMs ?? RETRY_BASE_MS;
  const lp = lockPath(projectDir);
  const start = Date.now();

  // Make sure the target dir exists before we try to create a lock file there.
  await ensureTasksDir(projectDir);
  let attempt = 0;

  // Spinlock: try to create the lock file exclusively.
  while (true) {
    try {
      const fh = await fs.open(lp, "wx");
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await fh.close();
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`lock: timeout acquiring ${lp} after ${timeoutMs}ms`);
      }
      const wait = Math.min(retryEveryMs * Math.max(1, attempt), 200);
      await sleep(wait);
      attempt++;
    }
  }

  const lockContext = makeLockContext(resolvedProjectDir);
  const inheritedContexts = activeProjectLock.getStore()?.lockContexts;
  const lockContexts = new Map(inheritedContexts ?? []);
  lockContexts.set(resolvedProjectDir, lockContext);
  try {
    return await activeProjectLock.run(
      { lockContexts },
      () => fn(lockContext),
    );
  } finally {
    expireLockContext(lockContext);
    try {
      await fs.unlink(lp);
    } catch {
      // ignore
    }
  }
}
