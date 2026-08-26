// T-plugin-install — `climier install <source>`: install a plugin into
// <CLIMIER_HOME>/plugins/installed/<climier.id>/ using an isolated
// staging prefix and a global plugin lock.
//
// Lifecycle:
//   1. Take the global plugin lock (withGlobalPluginLock).
//   2. Resolve the npm command; reject with PLUGIN_NPM_UNAVAILABLE if it
//      cannot be spawned or returns non-zero on `--version`.
//   3. Generate a staging nonce and run `npm install --prefix
//      <staging> --no-audit --no-fund <source>`. The source may be a
//      local path or a registry package name (ADR-005 §"Instalación e
//      identidad": "El nombre npm solo es el origen de instalación").
//   4. Read the descriptor from the installed package.json (under
//      node_modules/<basename>/package.json for local sources; under
//      node_modules/<source>/package.json for registry sources).
//   5. Validate descriptor shape (PLUGIN_INVALID_DESCRIPTOR) and
//      reserved-namespace uniqueness (PLUGIN_INVALID_DESCRIPTOR).
//   6. Validate id uniqueness against installed/ (PLUGIN_ID_CONFLICT)
//      and command uniqueness against installed commands
//      (PLUGIN_ID_CONFLICT).
//   7. Import the entrypoint ESM and assert default.commands is an
//      object (PLUGIN_LOAD_FAILED).
//   8. Promote via fs.rename from .staging/<nonce> to installed/<id>.
//      This rename is atomic on the same filesystem, matching ADR-005
//      §"Instalación e identidad".
//
// On any failure inside the lock, the staging directory is removed with
// fs.rm(recursive, force). The host does NOT roll back npm's internal
// state inside the staging prefix — that is npm's responsibility per
// the ADR.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  pluginsHome,
  pluginInstalledDir,
  pluginStagingDir,
} from "../plugin-paths.mjs";
import { withGlobalPluginLock } from "../plugin-lock.mjs";
import {
  PluginInvalidDescriptor,
  importEntry,
  readDescriptor,
} from "../plugin-descriptor.mjs";
import { assertNoReservedCollision } from "./reserved-namespaces.mjs";

// We accept --as as identity (not enforced); it is harmless to allow it
// even though install does not write to project state.
export const knownFlags = ["as"];

class PluginIdConflict extends Error {
  constructor(id, extra = {}) {
    super(`install: plugin id '${id}' is already installed`);
    this.code = "PLUGIN_ID_CONFLICT";
    this.details = { id, ...extra };
    this.toJSON = () => ({ ok: false, error: { code: this.code, message: this.message, details: this.details } });
  }
}

class PluginNpmFailed extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.code = "PLUGIN_NPM_FAILED";
    this.details = extra;
    this.toJSON = () => ({ ok: false, error: { code: this.code, message: this.message, details: this.details } });
  }
}

class PluginNpmUnavailable extends Error {
  constructor(extra = {}) {
    super("install: npm is not available on this system");
    this.code = "PLUGIN_NPM_UNAVAILABLE";
    this.details = extra;
    this.toJSON = () => ({ ok: false, error: { code: this.code, message: this.message, details: this.details } });
  }
}

// resolveNpmCommand: tests can pin a non-existent command via
// CLIMIER_NPM_CMD to exercise PLUGIN_NPM_UNAVAILABLE without monkey-
// patching PATH.
function resolveNpmCommand() {
  return process.env.CLIMIER_NPM_CMD || "npm";
}

// npmVersionCheck: confirm the npm binary exists and works. We do this
// up-front so PLUGIN_NPM_UNAVAILABLE surfaces before any staging dir is
// created.
async function npmVersionCheck() {
  const cmd = resolveNpmCommand();
  return new Promise((resolve) => {
    let stderr = "";
    let proc;
    try {
      proc = spawn(cmd, ["--version"], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      resolve({ ok: false, code: "SPAWN_ERROR", reason: err.message, command: cmd });
      return;
    }
    if (proc.stderr) proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => {
      resolve({ ok: false, code: err.code || "SPAWN_ERROR", reason: err.message, command: cmd });
    });
    proc.on("close", (exitCode) => {
      if (exitCode === 0) resolve({ ok: true, command: cmd });
      else resolve({ ok: false, code: "NON_ZERO_EXIT", reason: stderr.trim() || `exit ${exitCode}`, exitCode, command: cmd });
    });
  });
}

// npmInstall: run `npm install --prefix <staging> --no-audit --no-fund <source>`
// and resolve with { code, stderr }.
async function npmInstall(stagingDir, source) {
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
    if (proc.stderr) proc.stderr.on("data", (d) => (stderr += d.toString()));
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

// resolveInstalledPackageDir: predict where npm dropped the plugin.
//   - Local path:  basename(source)
//   - Registry:    source (e.g. "example-plugin" or "@scope/example")
//
// We read its package.json directly; if npm has not put a package there
// (or the descriptor is missing) we surface PLUGIN_INVALID_DESCRIPTOR.
function predictInstalledPackageDir(stagingDir, source) {
  const basename = path.basename(source);
  return path.join(stagingDir, "node_modules", basename);
}

async function isLocalPath(source) {
  // Treat absolute paths, dot-relative paths, and tilde expansions as
  // local. Anything else is a registry package name.
  return (
    source.startsWith("/") ||
    source.startsWith("./") ||
    source.startsWith("../") ||
    source.startsWith("~")
  );
}

// listInstalled: enumerate existing installed plugins (excluding hidden
// entries) and read their descriptors. Used to enforce uniqueness
// before promotion.
async function listInstalledDescriptors() {
  const installedRoot = path.join(pluginsHome(), "installed");
  let entries = [];
  try {
    entries = await fs.readdir(installedRoot);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const pkgPath = path.join(installedRoot, entry, "package.json");
    try {
      const raw = await fs.readFile(pkgPath, "utf8");
      const pkg = JSON.parse(raw);
      if (pkg && pkg.climier && typeof pkg.climier === "object") {
        out.push({ dirName: entry, descriptor: pkg.climier });
      }
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
  }
  return out;
}

async function checkUniqueness(descriptor) {
  // Id collision against an already-installed plugin.
  const targetDir = pluginInstalledDir(descriptor.id);
  try {
    await fs.access(targetDir);
  } catch (err) {
    if (err.code === "ENOENT") {
      // fall through to command uniqueness check below.
    } else {
      throw err;
    }
  }
  if (await pathExists(targetDir)) {
    throw new PluginIdConflict(descriptor.id, { reason: "id-already-installed" });
  }
  // Command collision against any other installed plugin's climier.command.
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
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

export default async function install({ positional = [], flags = {} } = {}) {
  const source = positional[0];
  if (!source || typeof source !== "string" || !source.trim()) {
    throw new PluginInvalidDescriptor(
      "install: source path or package name required",
      { field: "source" },
    );
  }

  // Pre-flight: confirm npm is available BEFORE taking the lock or
  // creating the staging dir. PLUGIN_NPM_UNAVAILABLE is a structured
  // error per ADR-005; the spec calls for staging cleanup, so any
  // partially-created staging must also be removed.
  const npmOk = await npmVersionCheck();
  if (npmOk.ok !== true) {
    throw new PluginNpmUnavailable(npmOk);
  }

  return withGlobalPluginLock(async () => {
    await fs.mkdir(pluginsHome(), { recursive: true });
    await fs.mkdir(path.join(pluginsHome(), "installed"), { recursive: true });
    await fs.mkdir(path.join(pluginsHome(), ".staging"), { recursive: true });

    const nonce = crypto.randomBytes(8).toString("hex");
    const stagingDir = pluginStagingDir(nonce);
    await fs.mkdir(stagingDir, { recursive: true });

    try {
      // Step 3: npm install --prefix staging <source>.
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

      // Step 4: read descriptor from the installed package.
      const installedPkgDir = predictInstalledPackageDir(stagingDir, source);
      const descriptor = await readDescriptor(path.join(installedPkgDir, "package.json"));

      // Step 5: reserved namespace collision.
      assertNoReservedCollision(descriptor.command);

      // Step 6: id + command uniqueness.
      await checkUniqueness(descriptor);

      // Step 7: import entrypoint and validate default.commands shape.
      const entryAbsPath = path.resolve(installedPkgDir, descriptor.entry);
      await importEntry(entryAbsPath);

      // T-plugin-fixture regression fix: npm install --prefix staging
      // <local-path> drops the package under <staging>/node_modules/<basename>/
      // and writes its own (climier-less) package.json at <staging>/package.json.
      // T-plugin-dispatch's loader reads <installed>/<id>/package.json to
      // find the descriptor and resolves the entry as
      // path.resolve(<installed>/<id>, descriptor.entry) — neither lookup
      // lands on the npm layout. Mirror the package's files into the
      // staging root so the loader can find both the descriptor and the
      // entry at their expected locations after the promotion rename.
      // We only mirror the descriptor and the entry (plus any non-node_modules
      // sibling files the entry may transitively import); the npm
      // node_modules/<basename>/ tree stays in place so transitive deps
      // (if any) remain reachable. plugin-install.test.mjs continues to
      // read the descriptor from node_modules/<basename>/package.json.
      await mirrorPluginFilesToStagingRoot(installedPkgDir, stagingDir, descriptor.entry);

      // Step 8: atomic promotion by rename to installed/<id>.
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
    } catch (err) {
      // On any failure inside the lock, drop the staging dir. ADR-005
      // does not require rolling back npm; it only requires removing
      // the staging prefix.
      await cleanupStaging(stagingDir);
      throw err;
    }
  });
}

// mirrorPluginFilesToStagingRoot: copy the descriptor and the entry (and
// any sibling files the entry may transitively import via relative
// paths) from <staging>/node_modules/<basename>/ to <staging>/ itself.
// Skips the package's own node_modules/ subtree so we do not collide
// with npm's structure. Used by install() to make the dispatcher's
// <installed>/<id>/{package.json, entry} layout work after the npm-
// driven install path (T-plugin-fixture regression fix).
async function mirrorPluginFilesToStagingRoot(pkgDir, stagingDir, entryRel) {
  // Normalize the entry relative path so it is rooted at pkgDir.
  const entryPath = path.resolve(pkgDir, entryRel);
  if (!entryPath.startsWith(pkgDir + path.sep) && entryPath !== pkgDir) {
    throw new Error(`install: entry '${entryRel}' escapes the package root`);
  }
  // Copy the descriptor (package.json) and the entry file. The entry's
  // own relative imports resolve against pkgDir, but their destination
  // under stagingDir mirrors that directory layout — we copy the whole
  // package contents (minus node_modules) so relative imports keep
  // working after the loader imports the entry from <installed>/<id>/.
  await copyPackageContents(pkgDir, stagingDir);
}

async function copyPackageContents(srcDir, destDir) {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
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

// Local-only re-export for tests; the function is intentionally not part
// of the CLI surface (no flag for it).
export { isLocalPath, mirrorPluginFilesToStagingRoot };
