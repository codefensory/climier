// T-plugin-dispatch — load an installed plugin at dispatch time.
//
// Wraps `readDescriptor` and `importEntry` from src/plugin-descriptor.mjs
// (owned by T-plugin-install) so the descriptor module stays focused on
// shape validation, while this module owns the dispatch-time loading
// path: resolve installed dir by namespace, read descriptor, lazy-import
// the ESM entry, validate the descriptor.command matches the namespace
// (T-plugin-command-namespace: ADR-005 §"Instalación e identidad" — the
// installed directory name IS the CLI namespace / descriptor.command,
// not descriptor.id), and return
// `{ pluginId, descriptor, commands, entryPath, installedDir }`.
//
// pluginId is descriptor.id; this is the identity the host uses for
// data keys, log plugin_id, and uninstall arguments.
//
// Errors are wrapped in PLUGIN_LOAD_FAILED / PLUGIN_INVALID_DESCRIPTOR so
// the bin's existing catch can emit the structured envelope without
// changes.

import path from "node:path";
import fs from "node:fs/promises";

import { pluginsHome } from "./plugin-paths.mjs";
import {
  PluginInvalidDescriptor,
  PluginLoadFailed,
  readDescriptor,
  importEntry,
} from "./plugin-descriptor.mjs";

// PLUGIN_LOAD_FAILED: namespace has no installed dir under
// <CLIMIER_HOME>/plugins/installed/<namespace>. Surfaced at dispatch time
// when the user typed a non-reserved, non-core first token that does
// not match an installed plugin. Distinct from "installed but broken"
// (which keeps the PLUGIN_LOAD_FAILED code but with a different message
// and details).
class PluginNotInstalled extends PluginLoadFailed {
  constructor(namespace) {
    super(
      `plugin-loader: namespace '${namespace}' has no installed plugin`,
      { namespace, installed_dir: path.join(pluginsHome(), "installed", namespace) },
    );
  }
}

// resolveInstalledDir — pure path resolver. Exported so tests can
// assert the seam location without exposing the rest of the loader.
export function resolveInstalledDir(namespace) {
  return path.join(pluginsHome(), "installed", namespace);
}

// loadInstalledPlugin — returns `{ pluginId, descriptor, commands,
// entryPath, installedDir }` or throws a PLUGIN_* error.
//
// Order of checks:
//   1. installed dir exists and is a directory (PLUGIN_LOAD_FAILED if
//      missing — we treat "namespace not installed" as load failure
//      because the dispatcher never calls the loader for non-installed
//      namespaces; this is a defense-in-depth guard).
//   2. descriptor is read and shaped (PLUGIN_INVALID_DESCRIPTOR or
//      PLUGIN_LOAD_FAILED via readDescriptor).
//   3. descriptor.command === namespace (PLUGIN_INVALID_DESCRIPTOR —
//      the installed dir name MUST equal descriptor.command, otherwise
//      install was tampered with or the descriptor was edited to claim
//      a different namespace).
//   4. ESM entry lazy-imports and exposes default.commands (PLUGIN_LOAD_FAILED).
export async function loadInstalledPlugin(namespace) {
  if (typeof namespace !== "string" || !namespace.trim()) {
    throw new PluginInvalidDescriptor(
      "plugin-loader: namespace must be a non-empty string",
      { namespace: namespace ?? null },
    );
  }
  const installedDir = resolveInstalledDir(namespace);

  // 1. Existence check.
  let stat;
  try {
    stat = await fs.stat(installedDir);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new PluginNotInstalled(namespace);
    }
    throw new PluginLoadFailed(
      `plugin-loader: cannot stat ${installedDir}: ${err.message}`,
      { namespace, path: installedDir, cause: err.message },
    );
  }
  if (!stat.isDirectory()) {
    throw new PluginNotInstalled(namespace);
  }

  // 2. Read descriptor.
  let descriptor;
  const pkgPath = path.join(installedDir, "package.json");
  try {
    descriptor = await readDescriptor(pkgPath);
  } catch (err) {
    // readDescriptor already emits PLUGIN_INVALID_DESCRIPTOR /
    // PLUGIN_LOAD_FAILED with .details. Attach the namespace for the
    // dispatcher's envelope.
    if (err && typeof err.code === "string") {
      err.details = { ...(err.details || {}), namespace, installed_dir: installedDir };
      throw err;
    }
    throw new PluginLoadFailed(
      `plugin-loader: failed to read descriptor at ${pkgPath}: ${err.message}`,
      { namespace, path: pkgPath, cause: err.message },
    );
  }

  // 3. descriptor.command matches the namespace (dir name).
  // T-plugin-command-namespace: the installed dir is named after the
  // CLI namespace (descriptor.command), not the descriptor.id. The id
  // is the plugin identity for data/logs/uninstall; the command is the
  // dispatch key and the install dir name. ADR-005 §"Instalación e
  // identidad".
  if (descriptor.command !== namespace) {
    throw new PluginInvalidDescriptor(
      `plugin-loader: namespace '${namespace}' does not match descriptor.command '${descriptor.command}'`,
      { namespace, descriptor_command: descriptor.command, installed_dir: installedDir },
    );
  }

  // 4. Lazy import ESM entry.
  const entryPath = path.resolve(installedDir, descriptor.entry);
  let commands;
  try {
    ({ commands } = await importEntry(entryPath));
  } catch (err) {
    if (err && typeof err.code === "string") {
      err.details = { ...(err.details || {}), namespace, installed_dir: installedDir };
      throw err;
    }
    throw new PluginLoadFailed(
      `plugin-loader: failed to import entrypoint at ${entryPath}: ${err.message}`,
      { namespace, path: entryPath, cause: err.message },
    );
  }

  return {
    pluginId: descriptor.id,
    descriptor,
    commands,
    entryPath,
    installedDir,
  };
}

// hasInstalledPlugin — fast existence check (does not import the
// entrypoint). Used by bin/climier.mjs to decide between core and
// plugin dispatch without paying the import cost when the namespace
// is not installed. Returns boolean; never throws.
export async function hasInstalledPlugin(namespace) {
  try {
    const stat = await fs.stat(resolveInstalledDir(namespace));
    return stat.isDirectory();
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}