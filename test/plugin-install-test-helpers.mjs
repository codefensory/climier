import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { stateFilePath } from "./helpers.mjs";

export const PLUGIN_MODULE = "../src/plugins/paths.mjs";
export const LOCK_MODULE = "../src/plugins/lock.mjs";
export const DESCRIPTOR_MODULE = "../src/plugins/descriptor.mjs";
export const RESERVED_MODULE = "../src/cli/commands/reserved-namespaces.mjs";
export const INSTALL_MODULE = "../src/cli/commands/install.mjs";
export const UNINSTALL_MODULE = "../src/cli/commands/uninstall.mjs";

export async function freshEnv(prefix = "climier-plugin-test") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix + "-"));
  const prev = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = home;
  return {
    home,
    restore() {
      if (prev === undefined) {
        delete process.env.CLIMIER_HOME;
      } else {
        process.env.CLIMIER_HOME = prev;
      }
    },
    async cleanup() {
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}

export async function mkdirp(directory) {
  await fs.mkdir(directory, { recursive: true });
}

function fixtureDescriptor(overrides) {
  const defaults = { id: "test.plugin", command: "test-cmd", entry: "./climier.mjs", api: 3 };
  return Object.fromEntries(Object.keys(defaults).map((key) => [
    key,
    overrides[key] === undefined ? defaults[key] : overrides[key],
  ]));
}

function fixturePackageJson(overrides, descriptor) {
  const pkg = {
    name: overrides.npmName || "test-plugin",
    version: overrides.version || "1.0.0",
    type: "module",
  };
  if (!overrides.skipDescriptor) {
    pkg.climier = descriptor;
  }
  return { ...pkg, ...overrides.extraPkg };
}

function fixtureEntryCode(overrides) {
  return overrides.entryCode ||
    `export default {\n  commands: {\n    "hello": (args, ctx) => ({ ok: true, message: "hello" }),\n  },\n};\n`;
}

export async function createFixturePackage(dir, overrides = {}) {
  const pkgDir = path.join(dir, overrides.dirName || "test-plugin");
  await mkdirp(pkgDir);
  const descriptor = fixtureDescriptor(overrides);
  await fs.writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify(fixturePackageJson(overrides, descriptor), null, 2) + "\n",
    "utf8",
  );
  await fs.writeFile(path.join(pkgDir, "climier.mjs"), fixtureEntryCode(overrides), "utf8");
  return { pkgDir, descriptor };
}

export async function installedDir(env, id) {
  return path.join(env.home, "plugins", "installed", id);
}

async function stagingRoot(env) {
  return path.join(env.home, "plugins", ".staging");
}

export async function listStagingDirs(env) {
  try {
    return await fs.readdir(await stagingRoot(env));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function pathEqual(first, second) {
  return path.resolve(first) === path.resolve(second);
}

export function requireTestModule(modulePath) {
  return createRequire(import.meta.url)(modulePath);
}

export function captureError(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

export async function assertHappyInstallLayout(env, pluginInstalledDir) {
  assert.deepEqual(await listStagingDirs(env), []);
  const installedAt = await installedDir(env, "happy.plugin");
  assert.equal(await pathEqual(pluginInstalledDir("happy.plugin"), installedAt), true);
  assert.ok((await fs.stat(installedAt)).isDirectory());
  const pkg = JSON.parse(await fs.readFile(path.join(installedAt, "node_modules", "happy-plugin", "package.json"), "utf8"));
  assert.equal(pkg.climier.id, "happy.plugin");
  assert.equal(pkg.climier.command, "happy");
}

export async function installCommandCollisionPair(install, fixtureDir) {
  await createFixturePackage(fixtureDir, {
    id: "shared.first", command: "shared", npmName: "first-pkg", dirName: "first-pkg",
  });
  await install({ positional: [path.join(fixtureDir, "first-pkg")], flags: {}, projectDir: fixtureDir, statePath: fixtureDir });
  const secondDir = path.join(fixtureDir, "second-pkg");
  await mkdirp(secondDir);
  await createFixturePackage(secondDir, {
    id: "shared.second", command: "shared", npmName: "second-pkg", dirName: "second-pkg",
  });
  return secondDir;
}

export async function installAndCheckProjectUntouched({ install, fixtureDir, projectDir, beforeMtime, beforeRaw }) {
  await createFixturePackage(fixtureDir, {
    id: "no.touch", command: "no-touch", npmName: "no-touch-pkg", dirName: "no-touch-pkg",
  });
  await install({ positional: [path.join(fixtureDir, "no-touch-pkg")], flags: {}, projectDir, statePath: projectDir });
  const afterMtime = (await fs.stat(stateFilePath(projectDir))).mtimeMs;
  const afterRaw = await fs.readFile(stateFilePath(projectDir), "utf8");
  assert.equal(afterMtime, beforeMtime, "install must not write the project state file");
  assert.equal(afterRaw, beforeRaw, "install must not change the project state bytes");
}

export async function uninstallOnlyNamedPlugin({ env, projectDir, install, uninstall, fixtureDir, statePath, beforeRaw }) {
  for (const [id, command] of [["plugin.a", "a"], ["plugin.b", "b"]]) {
    await createFixturePackage(fixtureDir, { id, command, npmName: `${command}-pkg`, dirName: `${command}-pkg` });
    await install({ positional: [path.join(fixtureDir, `${command}-pkg`)], flags: {}, projectDir, statePath: projectDir });
  }
  const aPath = await installedDir(env, "plugin.a");
  const bPath = await installedDir(env, "plugin.b");
  assert.ok((await fs.stat(aPath)).isDirectory());
  assert.ok((await fs.stat(bPath)).isDirectory());
  const result = await uninstall({ positional: ["plugin.a"], flags: {}, projectDir, statePath: projectDir });
  assert.equal(result.plugin.id, "plugin.a");
  assert.equal(result.plugin.uninstalled, true);
  await assert.rejects(fs.access(aPath));
  assert.ok((await fs.stat(bPath)).isDirectory());
  const afterRaw = await fs.readFile(statePath, "utf8");
  assert.equal(afterRaw, beforeRaw, "uninstall must not change project state");
}
