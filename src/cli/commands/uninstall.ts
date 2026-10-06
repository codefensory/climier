
import fs from "node:fs/promises";
import { withGlobalPluginLock } from "../../plugins/lock.ts";
import { pluginInstalledDir } from "../../plugins/paths.ts";
import { asCaughtError } from "../../contracts/errors.ts";
import type { CommandContext } from "./contracts.ts";

export const knownFlags = [];

export default async function uninstall({ positional }: CommandContext) {
  const id = positional[0];
  if (!id || typeof id !== "string" || !id.trim()) {

    throw new Error("uninstall: plugin id required");
  }

  return withGlobalPluginLock(async () => {
    const targetDir = pluginInstalledDir(id);
    try {
      await fs.rm(targetDir, { recursive: true, force: true });
    } catch (caught) {
      const err = asCaughtError(caught);

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
