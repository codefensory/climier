import fs from "node:fs/promises";
import { pluginsHome, globalPluginLockPath } from "./paths.ts";
import { withFileLock, type LockOptions } from "../storage/lock.ts";

async function ensurePluginsHome(): Promise<void> {
  await fs.mkdir(pluginsHome(), { recursive: true });
}

// The plugin install lock guards CLIMIER_HOME/plugins, not project state, so it
// reuses the file-lock primitive without entering the project mutation frontier.
export async function withGlobalPluginLock<T>(fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  await ensurePluginsHome();
  return withFileLock(globalPluginLockPath(), "withGlobalPluginLock", fn, opts);
}
