
import fs from "node:fs/promises";
import { withGlobalPluginLock } from "../../plugins/lock.ts";
import { pluginInstalledDir } from "../../plugins/paths.ts";

export const knownFlags = [];

export default async function uninstall({ positional = [] } = {}) {
  const id = positional[0];
  if (!id || typeof id !== "string" || !id.trim()) {

    throw new Error("uninstall: plugin id required");
  }

  return withGlobalPluginLock(async () => {
    const targetDir = pluginInstalledDir(id);
    try {
      await fs.rm(targetDir, { recursive: true, force: true });
    } catch (err) {

      if (err.code !== "ENOENT") {
        throw err;
      }
    }
    return {
      plugin: {
        id,
        uninstalled: true,
      },
    };
  });
}
