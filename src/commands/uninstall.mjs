// T-plugin-install — `climier uninstall <id>`: remove the installed
// plugin directory at <CLIMIER_HOME>/plugins/installed/<id>.
//
// ADR-005 §"Instalación e identidad":
//   - `uninstall <id>` elimina ese directorio y no purga datos de
//     proyectos.
//   - Errors of npm, descriptor, import, or shape remove the staging
//     with fs.rm — uninstall has no staging to clean.
//
// The global plugin lock is taken so concurrent install/uninstall cannot
// race on the same installed/<id>.

import fs from "node:fs/promises";
import { withGlobalPluginLock } from "../plugin-lock.mjs";
import { pluginInstalledDir } from "../plugin-paths.mjs";

export const knownFlags = ["as"];

export default async function uninstall({ positional = [], flags = {} } = {}) {
  const id = positional[0];
  if (!id || typeof id !== "string" || !id.trim()) {
    // Match the "command name: " prefix convention from errors.mjs so
    // log searches are greppable.
    throw new Error("uninstall: plugin id required");
  }

  return withGlobalPluginLock(async () => {
    const targetDir = pluginInstalledDir(id);
    try {
      await fs.rm(targetDir, { recursive: true, force: true });
    } catch (err) {
      // Removing a non-existent dir is a successful no-op; everything
      // else propagates.
      if (err.code !== "ENOENT") throw err;
    }
    return {
      plugin: {
        id,
        uninstalled: true,
      },
    };
  });
}
