import { asCaughtError } from "../contracts/errors.ts";
// lock.mjs: file lock for atomic mutating operations.
import fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { codedError } from "../contracts/errors.ts";
import { stateFile } from "./state.ts";

const RETRY_BASE_MS = 25;
const DEFAULT_TIMEOUT_MS = 10_000;
type LockDetails = { projectDir: string; statePath: string; active: boolean };
type LockStore = { lockContexts: Map<string, object> };
export type LockOptions = { timeoutMs?: number; retryEveryMs?: number };
type LockCallback<T> = (lockContext: object) => T | PromiseLike<T>;
const activeLockContexts = new WeakMap<object, LockDetails>();
const activeProjectLock = new AsyncLocalStorage<LockStore>();

function invalidLockContext(): Error {
  return codedError("CLIMIER_INVALID_LOCK_CONTEXT", "lock: active project lock capability is required");
}

/** Assert that a capability is active for exactly the requested project. */
export function assertActiveLockContext(lockContext: unknown, projectDir?: string): boolean {
  if (!lockContext || (typeof lockContext !== "object" && typeof lockContext !== "function")) {
    throw invalidLockContext();
  }
  const details = activeLockContexts.get(lockContext as object);
  if (!details?.active || (projectDir !== undefined && details.projectDir !== path.resolve(projectDir))) {
    throw invalidLockContext();
  }
  return true;
}

/** Resolve a live capability to its canonical storage paths for storage APIs. */
export function getActiveLockContext(lockContext: unknown): Readonly<{ projectDir: string; statePath: string }> {
  assertActiveLockContext(lockContext);
  const details = activeLockContexts.get(lockContext as object);
  if (!details) { throw invalidLockContext(); }
  return Object.freeze({ projectDir: details.projectDir, statePath: details.statePath });
}


export function getCurrentLockContext(projectDir: string): object | null {
  const active = activeProjectLock.getStore();
  const lockContext = active?.lockContexts.get(path.resolve(projectDir));
  if (!lockContext) {
    return null;
  }
  try {
    assertActiveLockContext(lockContext, projectDir);
    return lockContext;
  } catch (rawCaughtValue: unknown) {
  {
    const error = asCaughtError(rawCaughtValue);
    if (error instanceof Error && "code" in error && error.code === "CLIMIER_INVALID_LOCK_CONTEXT") {
      return null;
    }
    throw error;

  }}
}


export async function withCurrentProjectLock<T>(projectDir: string, fn: LockCallback<T>, opts: LockOptions = {}): Promise<T> {
  const lockContext = getCurrentLockContext(projectDir);
  if (lockContext) {
    return fn(lockContext);
  }
  return withLock(projectDir, fn, opts);
}

function makeLockContext(projectDir: string, statePath = stateFile(projectDir)): object {
  const context = Object.freeze(Object.create(null)) as object;
  activeLockContexts.set(context, {
    projectDir: path.resolve(projectDir),
    statePath,
    active: true,
  });
  return context;
}

function expireLockContext(lockContext: object): void {
  const details = activeLockContexts.get(lockContext);
  if (details) {
    details.active = false;
  }
}

function lockPath(projectDir: string): string {
  return path.join(path.dirname(stateFile(projectDir)), ".lock");
}

async function ensureTasksDir(projectDir: string): Promise<void> {
  await fs.mkdir(path.dirname(stateFile(projectDir)), { recursive: true });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createLockFile(lockPathname: string): Promise<void> {
  const file = await fs.open(lockPathname, "wx");
  await file.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
  await file.close();
}

async function acquireLockFile(lockPathname: string, { timeoutMs, retryEveryMs }: Required<LockOptions>): Promise<void> {
  const start = Date.now();
  let attempt = 0;
  while (true) {
    try {
      await createLockFile(lockPathname);
      return;
    } catch (rawCaughtValue: unknown) {
  {
    const error = asCaughtError(rawCaughtValue);
      if (error.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`lock: timeout acquiring ${lockPathname} after ${timeoutMs}ms`, { cause: error });
      }
      await sleep(Math.min(retryEveryMs * Math.max(1, attempt), 200));
      attempt++;

  }}
  }
}

async function runWithLockContext<T>(projectDir: string, lockPathname: string, fn: LockCallback<T>, statePath = stateFile(projectDir)): Promise<T> {
  const lockContext = makeLockContext(projectDir, statePath);
  const inheritedContexts = activeProjectLock.getStore()?.lockContexts;
  const lockContexts = new Map(inheritedContexts ?? []);
  lockContexts.set(projectDir, lockContext);
  try {
    return await activeProjectLock.run({ lockContexts }, () => fn(lockContext));
  } finally {
    expireLockContext(lockContext);
    try {
      await fs.unlink(lockPathname);
    } catch {
      // Ignore a missing lock file while preserving the operation result.
    }
  }
}

export async function withProjectIdLock<T>(projectId: string, fn: LockCallback<T>, opts: LockOptions = {}): Promise<T> {
  if (typeof projectId !== "string" || !projectId.trim() || projectId === "." || projectId === ".."
      || path.basename(projectId) !== projectId || projectId.includes(path.sep) || projectId.includes("\\")) {
    throw new TypeError("lock: project_id must be a non-empty path component");
  }
  const home = path.resolve(process.env.CLIMIER_HOME || path.join(process.env.HOME || ".", ".climier"));
  const storageProjectDir = path.join(home, "projects", projectId);
  const pathname = path.join(storageProjectDir, ".lock");
  const options: Required<LockOptions> = {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retryEveryMs: opts.retryEveryMs ?? RETRY_BASE_MS,
  };
  await fs.mkdir(storageProjectDir, { recursive: true });
  await acquireLockFile(pathname, options);
  return runWithLockContext(storageProjectDir, pathname, fn, path.join(storageProjectDir, "tasks.json"));
}

export async function withLock<T>(projectDir: string, fn: LockCallback<T>, opts: LockOptions = {}): Promise<T> {
  const resolvedProjectDir = path.resolve(projectDir);
  const inherited = getCurrentLockContext(resolvedProjectDir);
  if (inherited) {
    return fn(inherited);
  }
  const options: Required<LockOptions> = {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retryEveryMs: opts.retryEveryMs ?? RETRY_BASE_MS,
  };
  const pathname = lockPath(projectDir);
  await ensureTasksDir(projectDir);
  await acquireLockFile(pathname, options);
  return runWithLockContext(resolvedProjectDir, pathname, fn);
}
