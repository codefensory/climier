import fs from "node:fs/promises";
import path from "node:path";

function serverAlreadyRunning(lockPath, lock) {
  const error = new Error(`server: another instance already holds ${lockPath}`);
  error.code = "SERVER_ALREADY_RUNNING";
  error.details = { lockPath, lock };
  return error;
}

async function readExistingLock(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      return { corrupt: true };
    }
    throw error;
  }
}

export async function acquireServerServiceLock(stateHome, opts = {}) {
  if (typeof stateHome !== "string" || !stateHome.trim()) {
    throw new TypeError("server lock: stateHome is required");
  }
  const lockPath = path.join(stateHome, ".server.lock");
  await fs.mkdir(stateHome, { recursive: true, mode: 0o700 });
  const lock = {
    pid: opts.pid ?? process.pid,
    started_at: (opts.now?.() ?? new Date()).toISOString(),
  };
  let handle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(lock, null, 2) + "\n", "utf8");
    await handle.sync();
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    if (error.code === "EEXIST") {
      throw serverAlreadyRunning(lockPath, await readExistingLock(lockPath));
    }
    throw error;
  }

  let released = false;
  return {
    path: lockPath,
    lock,
    async release() {
      if (released) {
        return;
      }
      released = true;
      await handle.close();
      await fs.unlink(lockPath).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    },
  };
}
