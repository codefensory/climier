import path from "node:path";
import fs from "node:fs/promises";

import { pluginsHome } from "./paths.ts";
import {
  PluginInvalidDescriptor,
  PluginLoadFailed,
  readDescriptor,
  importEntry,
} from "./descriptor.ts";
import type { PluginDescriptor, PluginPolicy } from "./descriptor.ts";
import type { PluginCommands } from "./types.ts";
import { isRecord } from "../application/types.ts";
import { asCaughtError } from "../contracts/errors.ts";

class PluginNotInstalled extends PluginLoadFailed {
  constructor(namespace: string) {
    super(
      `plugin-loader: namespace '${namespace}' has no installed plugin`,
      { namespace, installed_root: path.join(pluginsHome(), "installed") },
    );
  }
}

async function installedEntries(installedRoot: string): Promise<string[]> {
  try {
    return await fs.readdir(installedRoot);
  } catch (err: unknown) {
    if (asCaughtError(err).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function readPackage(packagePath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(packagePath, "utf8");
  } catch (err: unknown) {
    if (asCaughtError(err).code === "ENOENT") {
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

function packageClaimsCommand(pkg: unknown, command: string): boolean {
  return Boolean(
    isRecord(pkg) && isRecord(pkg.climier) && pkg.climier.command === command,
  );
}

async function findInstalledDirByCommand(command: string): Promise<string | null> {
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

function validateNamespace(namespace: unknown): asserts namespace is string {
  if (typeof namespace !== "string" || !namespace.trim()) {
    throw new PluginInvalidDescriptor(
      "plugin-loader: namespace must be a non-empty string",
      { namespace: namespace ?? null },
    );
  }
}

async function readInstalledDescriptor(installedDir: string, namespace: string): Promise<PluginDescriptor> {
  const pkgPath = path.join(installedDir, "package.json");
  try {
    return await readDescriptor(pkgPath);
  } catch (err: unknown) {
    const caught = asCaughtError(err);
    if (typeof caught.code === "string") {
      caught.details = { ...caught.details, namespace, installed_dir: installedDir };
      throw caught;
    }
    throw new PluginLoadFailed(
      `plugin-loader: failed to read descriptor at ${pkgPath}: ${caught.message}`,
      { namespace, path: pkgPath, cause: caught.message },
    );
  }
}

function validateInstalledIdentity(descriptor: PluginDescriptor, installedDir: string, namespace: string): void {
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

async function importInstalledCommands(entryPath: string, installedDir: string, namespace: string): Promise<PluginCommands> {
  try {
    return (await importEntry(entryPath)).commands as PluginCommands;
  } catch (err: unknown) {
    const caught = asCaughtError(err);
    if (typeof caught.code === "string") {
      caught.details = { ...caught.details, namespace, installed_dir: installedDir };
      throw caught;
    }
    throw new PluginLoadFailed(
      `plugin-loader: failed to import entrypoint at ${entryPath}: ${caught.message}`,
      { namespace, path: entryPath, cause: caught.message },
    );
  }
}

export async function loadInstalledPlugin(namespace: string): Promise<{
  pluginId: string;
  descriptor: PluginDescriptor;
  commands: PluginCommands;
  entryPath: string;
  installedDir: string;
}> {
  validateNamespace(namespace);
  const installedDir = await findInstalledDirByCommand(namespace);
  if (!installedDir) {
    throw new PluginNotInstalled(namespace);
  }
  const descriptor = await readInstalledDescriptor(installedDir, namespace);
  validateInstalledIdentity(descriptor, installedDir, namespace);
  // Resolve against the installed package, not the executable directory. The
  // descriptor loader deliberately passes this filesystem path to the runtime
  // dynamic import so compiled binaries can load plugins installed later.
  const entryPath = path.resolve(installedDir, descriptor.entry);
  const commands = await importInstalledCommands(entryPath, installedDir, namespace);
  return { pluginId: descriptor.id, descriptor, commands, entryPath, installedDir };
}

export async function hasInstalledPlugin(namespace: string): Promise<boolean> {
  const dir = await findInstalledDirByCommand(namespace);
  return dir !== null;
}

export type InstalledPolicyPlugin = {
  pluginId: string;
  descriptor: PluginDescriptor;
  policy: PluginPolicy;
  namespace: string;
  entryPath: string;
  installedDir: string;
};

export async function findInstalledPolicyDirs(): Promise<string[]> {
  const installedRoot = path.join(pluginsHome(), "installed");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(installedRoot);
  } catch (err: unknown) {
    if (asCaughtError(err).code === "ENOENT") {return [];}
    throw err;
  }
  const dirs: string[] = [];
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

export async function loadInstalledPolicyPlugins(): Promise<InstalledPolicyPlugin[]> {
  const dirs = await findInstalledPolicyDirs();
  const out: InstalledPolicyPlugin[] = [];
  for (const installedDir of dirs) {
    const pkgPath = path.join(installedDir, "package.json");
    let descriptor: PluginDescriptor;
    try {
      descriptor = await readDescriptor(pkgPath);
    } catch {
      continue;
    }
    const entryPath = path.resolve(installedDir, descriptor.entry);
    let policy: PluginPolicy | undefined;
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

function isProjectConfig(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function parseProjectConfig(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isProjectConfig(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function readProjectConfig(projectDir: string): Promise<Record<string, unknown>> {
  if (typeof projectDir !== "string" || !projectDir.trim()) {
    throw new Error("plugin-loader: readProjectConfig requires a non-empty projectDir");
  }
  const metaPath = path.join(projectDir, ".climier.json");
  let raw: string;
  try {
    raw = await fs.readFile(metaPath, "utf8");
  } catch (err: unknown) {
    if (asCaughtError(err).code === "ENOENT") {
      return deepFreeze({}) as Record<string, unknown>;
    }
    throw err;
  }
  return deepFreeze(parseProjectConfig(raw)) as Record<string, unknown>;
}

function deepFreeze(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== "object") {return value;}
  if (seen.has(value)) {return value;}
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return value;
}
