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

import { pluginsHome } from "./paths.mjs";
import {
  PluginInvalidDescriptor,
  PluginLoadFailed,
  readDescriptor,
  importEntry,
} from "./descriptor.mjs";

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

// ---- ADR-007 §"Discovery global" ------------------------------------
//
// Policy plugins use the same global layout as command plugins
// (`<CLIMIER_HOME>/plugins/installed/<descriptor.id>/`), but
// discovery for them is a SEPARATE scan: the host loads every
// installed plugin's entry, validates its `default.policy` shape via
// `importEntry`, and returns the subset that publishes one. Skipped
// plugins (no policy, or invalid policy shape) are surfaced as
// warnings to the loader caller but never abort the discovery — only
// the `loadApplicablePolicy` selector (in `src/policy.mjs`) decides
// whether a missing or conflicting policy is fatal.
//
// The scan is NOT cached between commands (ADR-007 §"Discovery global"
// item 5): callers always re-read the installed/ directory so
// install/uninstall operations are observed immediately.

// findInstalledPolicyDirs — list every installed dir, regardless of
// whether its descriptor matches a command namespace. Returns an
// array of absolute paths in stable order (sorted by basename).
// Skips hidden entries and unreadable directories silently; the
// loader raises structured errors for the entries it tries to load.
// T-plugin-policy-foundation: this is the global scan that powers
// `loadInstalledPolicyPlugins`; it intentionally does NOT depend on
// `findInstalledDirByCommand` because policy plugins may live under
// their descriptor.id without claiming any CLI namespace.
export async function findInstalledPolicyDirs() {
  const installedRoot = path.join(pluginsHome(), "installed");
  let entries = [];
  try {
    entries = await fs.readdir(installedRoot);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const dirs = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const full = path.join(installedRoot, entry);
    // Defensive: only descend into directories. The bin already keeps
    // installed/ tidy, but a stray file should not break the scan.
    try {
      const stat = await fs.stat(full);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    dirs.push(full);
  }
  dirs.sort();
  return dirs;
}

// loadInstalledPolicyPlugins — return every installed plugin whose
// entry exports a valid `default.policy`. The contract:
//   - the function does NOT mutate state;
//   - it does NOT throw on broken plugins; entries with a missing or
//     invalid `default.policy` are silently skipped so a single
//     broken plugin does not hide the rest of the install set
//     (callers that need to fail loudly go through `loadApplicablePolicy`,
//     which raises POLICY_CONFLICT for selection failures);
//   - it returns an array of `{ pluginId, descriptor, policy,
//     namespace, entryPath, installedDir }` so the selector can
//     decide who applies without re-importing.
export async function loadInstalledPolicyPlugins() {
  const dirs = await findInstalledPolicyDirs();
  const out = [];
  for (const installedDir of dirs) {
    const pkgPath = path.join(installedDir, "package.json");
    let descriptor;
    try {
      descriptor = await readDescriptor(pkgPath);
    } catch {
      // A descriptor that doesn't validate cannot have a policy;
      // skip silently and continue. This matches the V1/V2 contract
      // where command discovery scans without failing the entire
      // scan on a single bad entry.
      continue;
    }
    const entryPath = path.resolve(installedDir, descriptor.entry);
    let policy;
    try {
      ({ policy } = await importEntry(entryPath));
    } catch {
      // importEntry may fail because default.commands is missing
      // (policy-only plugins still need `commands: {}` because
      // importEntry enforces it), or because default.policy shape is
      // invalid. Either way, skip silently — the selector would
      // also skip a plugin without a valid `policy` object.
      continue;
    }
    if (!policy || typeof policy.authorize !== "function") continue;
    out.push({
      pluginId: descriptor.id,
      descriptor,
      policy,
      namespace: descriptor.command,
      entryPath,
      installedDir,
    });
  }
  return out;
}

// readProjectConfig — read `<projectDir>/.climier.json` raw and
// return `{}` when the file is missing. The returned object is
// recursively frozen with `Object.freeze` so policy plugins can't
// mutate the host's view of the project config (ADR-007 §"Discovery
// global" item 4). The host reads the file ONCE per call; there is
// no caching between commands.
//
// `.climier.json` is the repo-committed file that pins the
// `project_id` and the `plugins` map. The plugin only reads its own
// `plugins[descriptor.id]` slot; the host reserves the container but
// does not interpret the payload.
export async function readProjectConfig(projectDir) {
  if (typeof projectDir !== "string" || !projectDir.trim()) {
    // Defensive: the helper is invoked from selector code that may
    // not have validated projectDir. The shape contract is "always
    // return a frozen {}"; we still raise here because a missing
    // projectDir is a programmer error in this milestone (every
    // handler resolves it before reaching the policy seam).
    throw new Error(
      `plugin-loader: readProjectConfig requires a non-empty projectDir`,
    );
  }
  const metaPath = path.join(projectDir, ".climier.json");
  let raw;
  try {
    raw = await fs.readFile(metaPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return deepFreeze({});
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A malformed .climier.json is the host's problem, not the
    // policy's. Match the rest of the host by returning {}; the
    // operator will see the parse error when they next run a
    // mutating command that actually reads the file.
    return deepFreeze({});
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return deepFreeze({});
  }
  return deepFreeze(parsed);
}

// deepFreeze — recursively freeze an object graph so policy plugins
// can't mutate the host's view of the project config. Mirrors the
// pattern in `src/plugin-data.mjs`; duplicated here to avoid pulling
// the data module into a pure-loader concern.
function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze(value[key], seen);
  }
  return value;
}
