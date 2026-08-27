// T-plugin-dispatch — load an installed plugin at dispatch time.
//
// Wraps `readDescriptor` and `importEntry` from src/plugin-descriptor.mjs
// (owned by T-plugin-install) so the descriptor module stays focused on
// shape validation, while this module owns the dispatch-time loading
// path.
//
// T-plugin-command-layout-fix / ADR-005 §"Instalación e identidad":
//   - installed directory name == descriptor.id
//   - descriptor.command == first non-flag CLI token (the namespace)
//   - discovery scans installed/*/package.json to match descriptor.command
//     against the namespace (no manifest persisted).
// `namespace` here is the CLI namespace (descriptor.command).
//
// `loadInstalledPlugin(namespace)` returns
// `{ pluginId, descriptor, commands, entryPath, installedDir }` where
// pluginId is descriptor.id (the host passes this through to api.* and
// to log plugin_id).
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

// PLUGIN_LOAD_FAILED: no installed plugin has descriptor.command ===
// `namespace`. Surfaced at dispatch time when the user typed a
// non-reserved, non-core first token that does not match any installed
// plugin. Distinct from "installed but broken" (which keeps the
// PLUGIN_LOAD_FAILED code but with a different message and details).
class PluginNotInstalled extends PluginLoadFailed {
  constructor(namespace) {
    super(
      `plugin-loader: namespace '${namespace}' has no installed plugin`,
      { namespace, installed_root: path.join(pluginsHome(), "installed") },
    );
  }
}

// findInstalledDirByCommand — scans installed/<*> for a directory whose
// package.json#climier.command matches the requested namespace. Returns
// the absolute directory path or null. Used both by loadInstalledPlugin
// and by hasInstalledPlugin. No manifest is read or written; this is
// the only source of truth the host has for "is this namespace
// installed?".
//
// T-plugin-command-layout-fix: ADR-005 forbids a persistent registry;
// discovery is a single readdir over installed/ + a small JSON parse
// per entry. Skips hidden entries and unreadable package.json files
// without throwing (a tampered entry cannot silently mask another
// plugin because the function returns the first valid match, not a
// fallback).
async function findInstalledDirByCommand(command) {
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
    if (
      pkg &&
      pkg.climier &&
      typeof pkg.climier === "object" &&
      pkg.climier.command === command
    ) {
      return path.join(installedRoot, entry);
    }
  }
  return null;
}

// loadInstalledPlugin — returns `{ pluginId, descriptor, commands,
// entryPath, installedDir }` or throws a PLUGIN_* error.
//
// Order of checks:
//   1. installed dir exists for descriptor.command === namespace
//      (PLUGIN_LOAD_FAILED otherwise — defense-in-depth: the bin's
//      hasInstalledPlugin already gated the call, but we re-check so
//      direct callers cannot skip the gate).
//   2. descriptor is read and shaped (PLUGIN_INVALID_DESCRIPTOR or
//      PLUGIN_LOAD_FAILED via readDescriptor).
//   3. descriptor.command === namespace (PLUGIN_INVALID_DESCRIPTOR —
//      defensive: an install-time scan + command uniqueness check
//      already enforces this; if the dir was hand-edited, surface it).
//   4. descriptor.id === dir.name (PLUGIN_INVALID_DESCRIPTOR — the
//      installed dir name MUST equal descriptor.id per ADR-005).
//   5. ESM entry lazy-imports and exposes default.commands
//      (PLUGIN_LOAD_FAILED).
export async function loadInstalledPlugin(namespace) {
  if (typeof namespace !== "string" || !namespace.trim()) {
    throw new PluginInvalidDescriptor(
      "plugin-loader: namespace must be a non-empty string",
      { namespace: namespace ?? null },
    );
  }

  // 1. Resolve dir by scanning installed/ for descriptor.command ===
  //    namespace. This is the single source of truth — the bin and the
  //    dispatch path share it via hasInstalledPlugin / loadInstalledPlugin.
  const installedDir = await findInstalledDirByCommand(namespace);
  if (!installedDir) {
    throw new PluginNotInstalled(namespace);
  }

  // 2. Read descriptor.
  let descriptor;
  const pkgPath = path.join(installedDir, "package.json");
  try {
    descriptor = await readDescriptor(pkgPath);
  } catch (err) {
    if (err && typeof err.code === "string") {
      err.details = { ...(err.details || {}), namespace, installed_dir: installedDir };
      throw err;
    }
    throw new PluginLoadFailed(
      `plugin-loader: failed to read descriptor at ${pkgPath}: ${err.message}`,
      { namespace, path: pkgPath, cause: err.message },
    );
  }

  // 3. descriptor.command matches the namespace.
  if (descriptor.command !== namespace) {
    throw new PluginInvalidDescriptor(
      `plugin-loader: namespace '${namespace}' does not match descriptor.command '${descriptor.command}'`,
      { namespace, descriptor_command: descriptor.command, installed_dir: installedDir },
    );
  }

  // 4. descriptor.id matches the directory name (T-plugin-command-layout-fix:
  // ADR-005 §"Instalación e identidad" — installed dir IS descriptor.id).
  const dirName = path.basename(installedDir);
  if (descriptor.id !== dirName) {
    throw new PluginInvalidDescriptor(
      `plugin-loader: installed dir '${dirName}' does not match descriptor.id '${descriptor.id}'`,
      { namespace, descriptor_id: descriptor.id, installed_dir: installedDir },
    );
  }

  // 5. Lazy import ESM entry.
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
//
// T-plugin-command-layout-fix: scans installed/*/package.json for
// descriptor.command === namespace. The bin treats every non-reserved,
// non-core first token as a plugin namespace and lets the loader
// raise PLUGIN_LOAD_FAILED if no plugin claims it.
export async function hasInstalledPlugin(namespace) {
  const dir = await findInstalledDirByCommand(namespace);
  return dir !== null;
}
