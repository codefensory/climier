import fs from "node:fs/promises";
import { asCaughtError } from "../contracts/errors.ts";
import { pluginsHome, globalPluginLockPath } from "./paths.ts";

type LockOptions = { timeoutMs?: number; retryEveryMs?: number };

async function acquirePluginLock(pathname: string, timeoutMs: number, retryEveryMs: number): Promise<void> {
  const startedAt = Date.now();
  let attempt = 0;
  while (true) {
    try {
      const file = await fs.open(pathname, "wx");
      await file.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await file.close();
      return;
    } catch (rawCaughtValue: unknown) {
      const error = asCaughtError(rawCaughtValue);
      if (error.code !== "EEXIST") { throw error; }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`withGlobalPluginLock: timeout acquiring ${pathname} after ${timeoutMs}ms`, { cause: rawCaughtValue });
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryEveryMs * Math.max(1, attempt), 200)));
      attempt++;
    }
  }
}

export async function withGlobalPluginLock<T>(fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const pathname = globalPluginLockPath();
  await fs.mkdir(pluginsHome(), { recursive: true });
  await acquirePluginLock(pathname, opts.timeoutMs ?? 10_000, opts.retryEveryMs ?? 25);
  try {
    return await fn();
  } finally {
    try { await fs.unlink(pathname); } catch {}
  }
}
