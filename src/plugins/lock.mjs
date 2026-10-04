
import fs from "node:fs/promises";
import { pluginsHome, globalPluginLockPath } from "./paths.mjs";

const RETRY_BASE_MS = 25;
const DEFAULT_TIMEOUT_MS = 10_000;

async function ensurePluginsHome() {
  await fs.mkdir(pluginsHome(), { recursive: true });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function acquirePluginLock(lockPath, timeoutMs, retryEveryMs) {
  const start = Date.now();
  let attempt = 0;
  while (true) {
    try {
      const fh = await fs.open(lockPath, "wx");
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await fh.close();
      return;
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `withGlobalPluginLock: timeout acquiring ${lockPath} after ${timeoutMs}ms`,
          { cause: err },
        );
      }
      const wait = Math.min(retryEveryMs * Math.max(1, attempt), 200);
      await sleep(wait);
      attempt++;
    }
  }
}

async function releasePluginLock(lockPath) {
  try {
    await fs.unlink(lockPath);
  } catch {

  }
}

export async function withGlobalPluginLock(fn, opts = {}) {
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
