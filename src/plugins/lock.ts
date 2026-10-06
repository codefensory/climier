import fs from "node:fs/promises";
import { pluginsHome, globalPluginLockPath } from "./paths.ts";
import { asCaughtError } from "../contracts/errors.ts";

const RETRY_BASE_MS = 25;
const DEFAULT_TIMEOUT_MS = 10_000;

type LockOptions = { timeoutMs?: number; retryEveryMs?: number };

async function ensurePluginsHome(): Promise<void> {
  await fs.mkdir(pluginsHome(), { recursive: true });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquirePluginLock(lockPath: string, timeoutMs: number, retryEveryMs: number): Promise<void> {
  const start = Date.now();
  let attempt = 0;
  while (true) {
    try {
      const fh = await fs.open(lockPath, "wx");
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await fh.close();
      return;
    } catch (err: unknown) {
      const caught = asCaughtError(err);
      if (caught.code !== "EEXIST") {
        throw err;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `withGlobalPluginLock: timeout acquiring ${lockPath} after ${timeoutMs}ms`,
          { cause: caught },
        );
      }
      const wait = Math.min(retryEveryMs * Math.max(1, attempt), 200);
      await sleep(wait);
      attempt++;
    }
  }
}

async function releasePluginLock(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath);
  } catch {
    // Lock cleanup is best effort after the protected operation completes.
  }
}

export async function withGlobalPluginLock<T>(fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryEveryMs = opts.retryEveryMs ?? RETRY_BASE_MS;
  const lockPath = globalPluginLockPath();
  await ensurePluginsHome();
  await acquirePluginLock(lockPath, timeoutMs, retryEveryMs);
  try {
    return await fn();
  } finally {
    await releasePluginLock(lockPath);
  }
}
