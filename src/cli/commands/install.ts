
//   8. Promote via fs.rename from .staging/<nonce> to
//      installed/<descriptor.id>. This rename is atomic on the same

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  pluginsHome,
  pluginInstalledDir,
  pluginStagingDir,
} from "../../plugins/paths.ts";
import { withGlobalPluginLock } from "../../plugins/lock.ts";
import {
  PluginInvalidDescriptor,
  importEntry,
  readDescriptor,
} from "../../plugins/descriptor.ts";
import { assertNoReservedCollision } from "./reserved-namespaces.ts";
import { asCaughtError } from "../../contracts/errors.ts";
import type { CommandContext } from "./contracts.ts";

type NpmVersionResult = { ok: true; command: string } | { ok: false; code: string; reason: string; command: string; exitCode?: number };
type NpmInstallResult = { code: number; stderr: string };
type InstalledDescriptor = { dirName: string; descriptor: { id: string; command: string; entry: string } };

export const knownFlags = [];

class PluginIdConflict extends Error {
  declare readonly toJSON: () => { ok: false; error: { code: string; message: string; details: Record<string, unknown> } };
  constructor(id, extra = {}) {
    super(`install: plugin id '${id}' is already installed`);
    this.code = "PLUGIN_ID_CONFLICT";
    this.details = { id, ...extra };
    this.toJSON = () => ({ ok: false, error: { code: this.code || "", message: this.message, details: this.details || {} } });
  }
}

class PluginNpmFailed extends Error {
  declare readonly toJSON: () => { ok: false; error: { code: string; message: string; details: Record<string, unknown> } };
  constructor(message, extra = {}) {
    super(message);
    this.code = "PLUGIN_NPM_FAILED";
    this.details = extra;
    this.toJSON = () => ({ ok: false, error: { code: this.code || "", message: this.message, details: this.details || {} } });
  }
}

class PluginNpmUnavailable extends Error {
  declare readonly toJSON: () => { ok: false; error: { code: string; message: string; details: Record<string, unknown> } };
  constructor(extra = {}) {
    super("install: npm is not available on this system");
    this.code = "PLUGIN_NPM_UNAVAILABLE";
    this.details = extra;
    this.toJSON = () => ({ ok: false, error: { code: this.code || "", message: this.message, details: this.details || {} } });
  }
}

function resolveNpmCommand() {
  return process.env.CLIMIER_NPM_CMD || "npm";
}

async function npmVersionCheck(): Promise<NpmVersionResult> {
  const cmd = resolveNpmCommand();
  return new Promise((resolve) => {
    let stderr = "";
    let proc;
    try {
      proc = spawn(cmd, ["--version"], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (caught) {
      const err = asCaughtError(caught);
      resolve({ ok: false, code: "SPAWN_ERROR", reason: err.message, command: cmd });
      return;
    }
    if (proc.stderr) {proc.stderr.on("data", (d) => (stderr += d.toString()));}
    proc.on("error", (caught) => {
      const err = asCaughtError(caught);
      resolve({ ok: false, code: err.code || "SPAWN_ERROR", reason: err.message, command: cmd });
    });
    proc.on("close", (exitCode) => {
      if (exitCode === 0) {resolve({ ok: true, command: cmd });}
      else {resolve({ ok: false, code: "NON_ZERO_EXIT", reason: stderr.trim() || `exit ${exitCode}`, exitCode, command: cmd });}
    });
  });
}

async function npmInstall(stagingDir: string, source: string): Promise<NpmInstallResult> {
  const cmd = resolveNpmCommand();
  return new Promise((resolve, reject) => {
    let stderr = "";
    let proc;
    try {
      proc = spawn(
        cmd,
        ["install", "--prefix", stagingDir, "--no-audit", "--no-fund", source],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (err) {
      reject(err);
      return;
    }
    if (proc.stderr) {proc.stderr.on("data", (d) => (stderr += d.toString()));}
    proc.on("error", (err) => reject(err));
    proc.on("close", (exitCode) => {
      resolve({ code: exitCode ?? -1, stderr });
    });
  });
}

// cleanupStaging: best-effort removal of the staging dir on failure.
async function cleanupStaging(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore — staging removal is best-effort and must not mask the
    // primary error that triggered cleanup.
  }
}

function predictInstalledPackageDir(stagingDir, source) {
  const basename = path.basename(source);
  return path.join(stagingDir, "node_modules", basename);
}

async function isLocalPath(source) {

  return (
    source.startsWith("/") ||
    source.startsWith("./") ||
    source.startsWith("../") ||
    source.startsWith("~")
  );
}

async function installedDescriptor(installedRoot: string, entry: string): Promise<InstalledDescriptor | null> {
  const pkgPath = path.join(installedRoot, entry, "package.json");
  try {
    const raw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    if (pkg && pkg.climier && typeof pkg.climier === "object") {
      return { dirName: entry, descriptor: pkg.climier };
    }
    return null;
  } catch (caught) {
    const err = asCaughtError(caught);
    if (err.code === "ENOENT") {return null;}
    throw err;
  }
}

async function listInstalledDescriptors() {
  const installedRoot = path.join(pluginsHome(), "installed");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(installedRoot);
  } catch (caught) {
    const err = asCaughtError(caught);
    if (err.code === "ENOENT") {return [];}
    throw err;
  }
  const out: InstalledDescriptor[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) {continue;}
    const descriptor = await installedDescriptor(installedRoot, entry);
    if (descriptor) {out.push(descriptor);}
  }
  return out;
}

async function checkUniqueness(descriptor: { id: string; command: string }) {

  const targetDir = pluginInstalledDir(descriptor.id);
  if (await pathExists(targetDir)) {
    throw new PluginIdConflict(descriptor.id, {
      reason: "id-already-installed",
      target_dir: targetDir,
    });
  }

  const installed = await listInstalledDescriptors();
  for (const { dirName, descriptor: other } of installed) {
    if (other && other.command === descriptor.command) {
      throw new PluginIdConflict(descriptor.id, {
        reason: "command-already-installed",
        existing_plugin: dirName,
        conflict_command: descriptor.command,
      });
    }
  }
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch (caught) {
    const err = asCaughtError(caught);
    if (err.code === "ENOENT") {return false;}
    throw err;
  }
}

function validateInstallSource(positional) {
  const source = positional[0];
  if (!source || typeof source !== "string" || !source.trim()) {
    throw new PluginInvalidDescriptor(
      "install: source path or package name required",
      { field: "source" },
    );
  }
  return source;
}

async function requireNpmAvailable() {

  const npmOk = await npmVersionCheck();
  if (npmOk.ok !== true) {throw new PluginNpmUnavailable(npmOk);}
}

async function installStagedPackage(stagingDir: string, source: string) {
  try {
    const npmResult = await npmInstall(stagingDir, source);
    if (npmResult.code !== 0) {
      throw new PluginNpmFailed(
        `install: npm install failed (exit ${npmResult.code})`,
        {
          exit_code: npmResult.code,
          source,
          staging_dir: stagingDir,
          stderr_tail: npmResult.stderr.slice(-2000),
        },
      );
    }
    return await promoteStagedPackage(stagingDir, source);
  } catch (caught) {
    await cleanupStaging(stagingDir);
    throw caught;
  }
}

async function promoteStagedPackage(stagingDir, source) {
  const installedPkgDir = predictInstalledPackageDir(stagingDir, source);
  const descriptor = await readDescriptor(path.join(installedPkgDir, "package.json"));
  assertNoReservedCollision(descriptor.command);
  await checkUniqueness(descriptor);
  await importEntry(path.resolve(installedPkgDir, descriptor.entry));

  await mirrorPluginFilesToStagingRoot(installedPkgDir, stagingDir, descriptor.entry);
  const targetDir = pluginInstalledDir(descriptor.id);
  await fs.rename(stagingDir, targetDir);
  return {
    plugin: {
      id: descriptor.id,
      command: descriptor.command,
      entry: descriptor.entry,
      installed_dir: targetDir,
    },
  };
}

async function installLocked(source) {
  return withGlobalPluginLock(async () => {
    await fs.mkdir(pluginsHome(), { recursive: true });
    await fs.mkdir(path.join(pluginsHome(), "installed"), { recursive: true });
    await fs.mkdir(path.join(pluginsHome(), ".staging"), { recursive: true });

    const nonce = crypto.randomBytes(8).toString("hex");
    const stagingDir = pluginStagingDir(nonce);
    await fs.mkdir(stagingDir, { recursive: true });

    return installStagedPackage(stagingDir, source);
  });
}

export default async function install({ positional }: CommandContext) {
  const source = validateInstallSource(positional);
  await requireNpmAvailable();
  return installLocked(source);
}

async function mirrorPluginFilesToStagingRoot(pkgDir, stagingDir, entryRel) {

  const entryPath = path.resolve(pkgDir, entryRel);
  if (!entryPath.startsWith(pkgDir + path.sep) && entryPath !== pkgDir) {
    throw new Error(`install: entry '${entryRel}' escapes the package root`);
  }

  await copyPackageContents(pkgDir, stagingDir);
}

async function copyPackageContents(srcDir, destDir) {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules") {continue;}
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(d, { recursive: true });
      await copyPackageContents(s, d);
    } else if (entry.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

export { isLocalPath, mirrorPluginFilesToStagingRoot };
