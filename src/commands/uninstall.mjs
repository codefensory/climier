// T-plugin-install — `climier uninstall <id>`: remove the installed
// plugin directory at <CLIMIER_HOME>/plugins/installed/<command>.
//
// T-plugin-command-namespace: ADR-005 §"Instalación e identidad" —
// `uninstall <id>` accepts the descriptor.id (not the CLI namespace),
// and the host resolves the matching installed directory by scanning
// descriptors (the spec forbids introducing a persistent manifest).
// The data layer keeps its data across uninstall.
//
// The global plugin lock is taken so concurrent install/uninstall cannot
// race on the same installed/<command>.

import fs from "node:fs/promises";
import path from "node:path";
import { withGlobalPluginLock } from "../plugin-lock.mjs";
import { pluginsHome } from "../plugin-paths.mjs";

export const knownFlags = ["as"];

// findInstalledDirById — scans installed/ for a directory whose
// package.json#climier.id matches the requested id. Returns the
// absolute dir path or null when no match is found. Skips entries
// whose package.json is unreadable (defense-in-depth: a tampered dir
// cannot silently swallow an uninstall of a different plugin).
async function findInstalledDirById(id) {
  const installedRoot = path.join(pluginsHome(), "installed");
  let entries = [];
  try {
    entries = await fs.readdir(installedRoot);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const pkgPath = path.join(installedRoot, entry, "package.json");
    let raw;
    try {
      raw = await fs.readFile(pkgPath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    let pkg;
    try {
      pkg = JSON.parse(raw);
    } catch {
      continue;
    }
    if (pkg && pkg.climier && typeof pkg.climier === "object" && pkg.climier.id === id) {
      return path.join(installedRoot, entry);
    }
  }
  return null;
}

export default async function uninstall({ positional = [], flags = {} } = {}) {
  const id = positional[0];
  if (!id || typeof id !== "string" || !id.trim()) {
    // Match the "command name: " prefix convention from errors.mjs so
    // log searches are greppable.
    throw new Error("uninstall: plugin id required");
  }

  return withGlobalPluginLock(async () => {
    // T-plugin-command-namespace: locate the dir by descriptor.id, not
    // by the id literal. The directory name is descriptor.command.
    const targetDir = await findInstalledDirById(id);
    if (targetDir) {
      try {
        await fs.rm(targetDir, { recursive: true, force: true });
      } catch (err) {
        // Removing a non-existent dir is a successful no-op; everything
        // else propagates.
        if (err.code !== "ENOENT") throw err;
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
