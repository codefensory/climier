// lock.mjs: file lock for atomic mutating operations.
import fs from "node:fs/promises";
import path from "node:path";
import { stateFile } from "./state.mjs";

const RETRY_BASE_MS = 25;
const DEFAULT_TIMEOUT_MS = 10_000;

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
