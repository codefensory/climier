// Global plugin lock.
//
// Mirrors the spinlock pattern in lock.mjs but is scoped to the global
// <CLIMIER_HOME>/plugins/ tree, so install/uninstall operations started
// by Climier are serialized against each other without touching the
// per-project lock at <state-dir>/.lock.
//
// Stale lock files are NOT auto-cleared; the timeout (default 10s) is
// the documented ceiling of this strategy.

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

export async function withGlobalPluginLock(fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryEveryMs = opts.retryEveryMs ?? RETRY_BASE_MS;
  const lp = globalPluginLockPath();
  const start = Date.now();

  // The target dir must exist before fs.openSync("wx") can create the
  // lock file. Mirrors lock.mjs's ensureTasksDir pattern.
  await ensurePluginsHome();
  let attempt = 0;

  while (true) {
    try {
      const fh = await fs.open(lp, "wx");
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await fh.close();
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`withGlobalPluginLock: timeout acquiring ${lp} after ${timeoutMs}ms`);
      }
      const wait = Math.min(retryEveryMs * Math.max(1, attempt), 200);
      await sleep(wait);
      attempt++;
    }
  }

  try {
    return await fn();
  } finally {
    try {
      await fs.unlink(lp);
    } catch {
      // ignore
    }
  }
}
