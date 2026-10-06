
import path from "node:path";
import fs from "node:fs/promises";

import { pluginsHome } from "./paths.ts";
import {
  PluginInvalidDescriptor,
  PluginLoadFailed,
  readDescriptor,
  importEntry,
} from "./descriptor.ts";

class PluginNotInstalled extends PluginLoadFailed {
  constructor(namespace) {
    super(
      `plugin-loader: namespace '${namespace}' has no installed plugin`,
      { namespace, installed_root: path.join(pluginsHome(), "installed") },
    );
  }
}

async function installedEntries(installedRoot) {
  try {
    return await fs.readdir(installedRoot);
  } catch (err) {
    if (err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function readPackage(packagePath) {
  let raw;
  try {
    raw = await fs.readFile(packagePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function packageClaimsCommand(pkg, command) {
  return Boolean(
    pkg && pkg.climier && typeof pkg.climier === "object" && pkg.climier.command === command,
  );
}

async function findInstalledDirByCommand(command) {
  const installedRoot = path.join(pluginsHome(), "installed");
  const entries = await installedEntries(installedRoot);
  for (const entry of entries) {
    if (entry.startsWith(".")) {
      continue;
    }
    const packagePath = path.join(installedRoot, entry, "package.json");
    const pkg = await readPackage(packagePath);
    if (packageClaimsCommand(pkg, command)) {
      return path.join(installedRoot, entry);
    }
  }
  return null;
}

function validateNamespace(namespace) {
  if (typeof namespace !== "string" || !namespace.trim()) {
    throw new PluginInvalidDescriptor(
      "plugin-loader: namespace must be a non-empty string",
      { namespace: namespace ?? null },
    );
  }
}

async function readInstalledDescriptor(installedDir, namespace) {
  const pkgPath = path.join(installedDir, "package.json");
  try {
    return await readDescriptor(pkgPath);
  } catch (err) {
    if (err && typeof err.code === "string") {
      err.details = { ...err.details, namespace, installed_dir: installedDir };
      throw err;
    }
    throw new PluginLoadFailed(
      `plugin-loader: failed to read descriptor at ${pkgPath}: ${err.message}`,
      { namespace, path: pkgPath, cause: err.message },
    );
  }
}

function validateInstalledIdentity(descriptor, installedDir, namespace) {
  if (descriptor.command !== namespace) {
    throw new PluginInvalidDescriptor(
      `plugin-loader: namespace '${namespace}' does not match descriptor.command '${descriptor.command}'`,
      { namespace, descriptor_command: descriptor.command, installed_dir: installedDir },
    );
  }
  const dirName = path.basename(installedDir);
  if (descriptor.id !== dirName) {
    throw new PluginInvalidDescriptor(
      `plugin-loader: installed dir '${dirName}' does not match descriptor.id '${descriptor.id}'`,
      { namespace, descriptor_id: descriptor.id, installed_dir: installedDir },
    );
  }
}

async function importInstalledCommands(entryPath, installedDir, namespace) {
  try {
    return (await importEntry(entryPath)).commands;
  } catch (err) {
    if (err && typeof err.code === "string") {
      err.details = { ...err.details, namespace, installed_dir: installedDir };
      throw err;
    }
    throw new PluginLoadFailed(
      `plugin-loader: failed to import entrypoint at ${entryPath}: ${err.message}`,
      { namespace, path: entryPath, cause: err.message },
    );
  }
}

export async function loadInstalledPlugin(namespace) {
  validateNamespace(namespace);
  const installedDir = await findInstalledDirByCommand(namespace);
  if (!installedDir) {
    throw new PluginNotInstalled(namespace);
  }
  const descriptor = await readInstalledDescriptor(installedDir, namespace);
  validateInstalledIdentity(descriptor, installedDir, namespace);
  const entryPath = path.resolve(installedDir, descriptor.entry);
  const commands = await importInstalledCommands(entryPath, installedDir, namespace);
  return { pluginId: descriptor.id, descriptor, commands, entryPath, installedDir };
}

export async function hasInstalledPlugin(namespace) {
  const dir = await findInstalledDirByCommand(namespace);
  return dir !== null;
}

export async function findInstalledPolicyDirs() {
  const installedRoot = path.join(pluginsHome(), "installed");
  let entries = [];
  try {
    entries = await fs.readdir(installedRoot);
  } catch (err) {
    if (err.code === "ENOENT") {return [];}
    throw err;
  }
  const dirs = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) {continue;}
    const full = path.join(installedRoot, entry);

    try {
      const stat = await fs.stat(full);
      if (!stat.isDirectory()) {continue;}
    } catch {
      continue;
    }
    dirs.push(full);
  }
  dirs.sort();
  return dirs;
}

export async function loadInstalledPolicyPlugins() {
  const dirs = await findInstalledPolicyDirs();
  const out = [];
  for (const installedDir of dirs) {
    const pkgPath = path.join(installedDir, "package.json");
    let descriptor;
    try {
      descriptor = await readDescriptor(pkgPath);
    } catch {

      continue;
    }
    const entryPath = path.resolve(installedDir, descriptor.entry);
    let policy;
    try {
      ({ policy } = await importEntry(entryPath));
    } catch {

      continue;
    }
    if (!policy || typeof policy.authorize !== "function") {continue;}
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

function isProjectConfig(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseProjectConfig(raw) {
  try {
    const parsed = JSON.parse(raw);
    return isProjectConfig(parsed) ? parsed : {};
  } catch {

    return {};
  }
}

export async function readProjectConfig(projectDir) {
  if (typeof projectDir !== "string" || !projectDir.trim()) {

    throw new Error("plugin-loader: readProjectConfig requires a non-empty projectDir");
  }
  const metaPath = path.join(projectDir, ".climier.json");
  let raw;
  try {
    raw = await fs.readFile(metaPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return deepFreeze({});
    }
    throw err;
  }
  return deepFreeze(parseProjectConfig(raw));
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") {return value;}
  if (seen.has(value)) {return value;}
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze(value[key], seen);
  }
  return value;
}
