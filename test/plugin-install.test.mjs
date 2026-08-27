// T-plugin-install — install / uninstall with isolated staging under
// CLIMIER_HOME/plugins/.
//
// Validates the ADR-005 install contract:
//   - descriptor (climier.id, command, entry) shape + regex
//   - npm --prefix in staging
//   - import entry ESM + default.commands object
//   - uniqueness of id and command against installed/ + reserved namespaces
//   - promotion via rename from .staging/<nonce> to installed/<id>
//   - structured errors (PLUGIN_INVALID_DESCRIPTOR, PLUGIN_LOAD_FAILED,
//     PLUGIN_ID_CONFLICT, PLUGIN_NPM_UNAVAILABLE) with staging cleanup
//   - uninstall removes only installed/<id> and never project data
//   - reserved-namespaces list is unique
//
// No project state is touched by install/uninstall. They mutate the
// global CLIMIER_HOME/plugins/ tree under a global plugin lock.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import {
  createTempProject,
  rmTempProject,
  importFresh,
  stateFilePath,
  writeState,
} from "./helpers.mjs";

const PLUGIN_MODULE = "../src/plugin-paths.mjs";
const LOCK_MODULE = "../src/plugin-lock.mjs";
const DESCRIPTOR_MODULE = "../src/plugin-descriptor.mjs";
const RESERVED_MODULE = "../src/commands/reserved-namespaces.mjs";
const INSTALL_MODULE = "../src/commands/install.mjs";
const UNINSTALL_MODULE = "../src/commands/uninstall.mjs";

// ---- Test helpers ----------------------------------------------------

async function freshEnv(prefix = "climier-plugin-test") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix + "-"));
  const prev = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = home;
  return {
    home,
    restore() {
      if (prev === undefined) delete process.env.CLIMIER_HOME;
      else process.env.CLIMIER_HOME = prev;
    },
    async cleanup() {
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}

async function mkdirp(p) {
  await fs.mkdir(p, { recursive: true });
}

async function createFixturePackage(dir, overrides = {}) {
  const pkgDir = path.join(dir, overrides.dirName || "test-plugin");
  await mkdirp(pkgDir);
  // Use explicit `undefined` checks so empty-string overrides (used to
  // exercise descriptor validation) are honored instead of falling
  // through to defaults via the `||` operator.
  const descriptor = {
    id: overrides.id !== undefined ? overrides.id : "test.plugin",
    command: overrides.command !== undefined ? overrides.command : "test-cmd",
    entry: overrides.entry !== undefined ? overrides.entry : "./climier.mjs",
  };
  await fs.writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: overrides.npmName || "test-plugin",
        version: overrides.version || "1.0.0",
        type: "module",
        ...(overrides.skipDescriptor ? {} : { climier: descriptor }),
        ...(overrides.extraPkg || {}),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const entryCode =
    overrides.entryCode ||
    `export default {\n  commands: {\n    "hello": (args, ctx) => ({ ok: true, message: "hello" }),\n  },\n};\n`;
  await fs.writeFile(path.join(pkgDir, "climier.mjs"), entryCode, "utf8");
  return { pkgDir, descriptor };
}

async function pluginsHome(env) {
  return path.join(env.home, "plugins");
}

async function installedDir(env, id) {
  return path.join(await pluginsHome(env), "installed", id);
}

async function stagingRoot(env) {
  return path.join(await pluginsHome(env), ".staging");
}

async function listStagingDirs(env) {
  try {
    return await fs.readdir(await stagingRoot(env));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

// ---- plugin-paths ----------------------------------------------------

test("plugin-paths: exposes pluginsHome, pluginInstalledDir, pluginStagingDir, globalPluginLockPath under CLIMIER_HOME/plugins", async () => {
  const env = await freshEnv();
  const { pluginsHome, pluginInstalledDir, pluginStagingDir, globalPluginLockPath } =
    await importFresh(PLUGIN_MODULE);
  try {
    assert.equal(pluginsHome(), path.join(env.home, "plugins"));
    assert.equal(pluginInstalledDir("foo.bar"), path.join(env.home, "plugins", "installed", "foo.bar"));
    assert.equal(
      pluginStagingDir("nonce"),
      path.join(env.home, "plugins", ".staging", "nonce"),
    );
    assert.equal(globalPluginLockPath(), path.join(env.home, "plugins", ".lock"));
  } finally {
    env.restore();
    await env.cleanup();
  }
});

// ---- plugin-lock -----------------------------------------------------

test("plugin-lock: withGlobalPluginLock acquires and releases; lock file is gone after", async () => {
  const env = await freshEnv();
  const { globalPluginLockPath } = await importFresh(PLUGIN_MODULE);
  const { withGlobalPluginLock } = await importFresh(LOCK_MODULE);
  try {
    let ran = false;
    await withGlobalPluginLock(async () => {
      ran = true;
      // Lock file must exist during the critical section.
      const st = await fs.stat(globalPluginLockPath());
      assert.ok(st.isFile());
    });
    assert.equal(ran, true);
    await assert.rejects(fs.access(globalPluginLockPath()));
  } finally {
    env.restore();
    await env.cleanup();
  }
});

test("plugin-lock: blocks concurrent acquires; second waits then succeeds", async () => {
  const env = await freshEnv();
  const { withGlobalPluginLock } = await importFresh(LOCK_MODULE);
  try {
    const order = [];
    const a = withGlobalPluginLock(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 150));
      order.push("a-end");
    });
    await new Promise((r) => setTimeout(r, 30));
    const b = withGlobalPluginLock(async () => {
      order.push("b-start");
    });
    await Promise.all([a, b]);
    assert.deepEqual(order, ["a-start", "a-end", "b-start"]);
  } finally {
    env.restore();
    await env.cleanup();
  }
});

test("plugin-lock: releases on fn error (no deadlock)", async () => {
  const env = await freshEnv();
  const { globalPluginLockPath } = await importFresh(PLUGIN_MODULE);
  const { withGlobalPluginLock } = await importFresh(LOCK_MODULE);
  try {
    await assert.rejects(
      withGlobalPluginLock(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    let ran = false;
    await withGlobalPluginLock(async () => {
      ran = true;
    });
    assert.equal(ran, true);
    await assert.rejects(fs.access(globalPluginLockPath()));
  } finally {
    env.restore();
    await env.cleanup();
  }
});

// ---- plugin-descriptor -----------------------------------------------

test("plugin-descriptor: PLUGIN_ID_RE matches the ADR regex", () => {
  const { PLUGIN_ID_RE } = require(DESCRIPTOR_MODULE);
  assert.ok(PLUGIN_ID_RE.test("a"));
  assert.ok(PLUGIN_ID_RE.test("A"));
  assert.ok(PLUGIN_ID_RE.test("1abc"));
  assert.ok(PLUGIN_ID_RE.test("foo.bar"));
  assert.ok(PLUGIN_ID_RE.test("foo_bar"));
  assert.ok(PLUGIN_ID_RE.test("foo-bar"));
  assert.ok(PLUGIN_ID_RE.test("a.b-c_d"));
  assert.ok(!PLUGIN_ID_RE.test(""));
  assert.ok(!PLUGIN_ID_RE.test(".foo"));
  assert.ok(!PLUGIN_ID_RE.test("-foo"));
  assert.ok(!PLUGIN_ID_RE.test("_foo"));
  assert.ok(!PLUGIN_ID_RE.test("foo bar"));
  assert.ok(!PLUGIN_ID_RE.test("foo/bar"));
  assert.ok(!PLUGIN_ID_RE.test("foo@bar"));
});

test("plugin-descriptor: validateDescriptor rejects missing climier fields with PLUGIN_INVALID_DESCRIPTOR", () => {
  const { validateDescriptor } = require(DESCRIPTOR_MODULE);
  const cases = [
    [undefined, "object required"],
    [null, "object required"],
    [{}, "id"],
    [{ id: "ok.id" }, "command"],
    [{ id: "ok.id", command: "cmd" }, "entry"],
    [{ id: "ok.id", command: "cmd", entry: "" }, "entry"],
    [{ id: "bad id", command: "cmd", entry: "./x.mjs" }, "id regex"],
  ];
  for (const [descriptor, expected] of cases) {
    const err = capture(() => validateDescriptor(descriptor));
    assert.ok(err, `expected throw for ${JSON.stringify(descriptor)} (looking for: ${expected})`);
    assert.equal(err.code, "PLUGIN_INVALID_DESCRIPTOR");
  }
});

test("plugin-descriptor: importEntry rejects missing default.commands with PLUGIN_LOAD_FAILED", async () => {
  const { importEntry } = await importFresh(DESCRIPTOR_MODULE);
  // Build a temp entry file that has no commands key on default export.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-entry-"));
  try {
    await fs.writeFile(
      path.join(dir, "entry.mjs"),
      "export default { notCommands: {} };\n",
      "utf8",
    );
    await assert.rejects(
      importEntry(path.join(dir, "entry.mjs")),
      (err) => err.code === "PLUGIN_LOAD_FAILED",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("plugin-descriptor: importEntry rejects entry that cannot be resolved with PLUGIN_LOAD_FAILED", async () => {
  const { importEntry } = await importFresh(DESCRIPTOR_MODULE);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-entry-"));
  try {
    await assert.rejects(
      importEntry(path.join(dir, "missing.mjs")),
      (err) => err.code === "PLUGIN_LOAD_FAILED",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function require(modulePath) {
  // Synchronous helper for the few non-async assertions above. We use a
  // relative path resolved against this test file so the source files
  // are reachable without async overhead.
  return createRequire(import.meta.url)(modulePath);
}

import { createRequire } from "node:module";

// ---- reserved-namespaces --------------------------------------------

test("reserved-namespaces: list contains every core CLI command and is unique", () => {
  const { RESERVED_NAMESPACES, assertNoReservedCollision } = require(RESERVED_MODULE);
  assert.ok(Array.isArray(RESERVED_NAMESPACES));
  // Every core command from bin/climier.mjs HELP_TEXT must be present so
  // T-plugin-dispatch can rely on this exact list as the seam.
  const required = [
    "status", "context", "take", "resolve", "release", "cancel", "reopen",
    "search", "history", "show", "update", "add-note", "add-initiative",
    "add-task", "add-gate", "add-knowledge", "deprecate-knowledge", "add-node",
    "add-edge", "initiatives", "log", "init", "snapshots", "restore", "ui",
    "help", "version", "install", "uninstall",
  ];
  for (const c of required) {
    assert.ok(RESERVED_NAMESPACES.includes(c), `missing core command '${c}'`);
  }
  // Uniqueness invariant.
  const seen = new Set();
  for (const c of RESERVED_NAMESPACES) {
    assert.ok(!seen.has(c), `duplicate reserved namespace: ${c}`);
    seen.add(c);
  }
  // assertNoReservedCollision rejects each reserved name.
  for (const c of RESERVED_NAMESPACES) {
    const err = capture(() => assertNoReservedCollision(c));
    assert.ok(err, `expected throw for reserved '${c}'`);
    assert.equal(err.code, "PLUGIN_INVALID_DESCRIPTOR");
    assert.ok(err.details && Array.isArray(err.details.reserved));
  }
  // accepts a non-reserved name and missing/empty inputs.
  assert.equal(assertNoReservedCollision("my-plugin"), true);
  for (const bad of ["", " ", null, undefined, true]) {
    const err = capture(() => assertNoReservedCollision(bad));
    assert.ok(err, `expected throw for bad input ${JSON.stringify(bad)}`);
    assert.equal(err.code, "PLUGIN_INVALID_DESCRIPTOR");
  }
});

// ---- install: happy path --------------------------------------------

test("install: valid descriptor installs with promotion by rename; staging is gone", async () => {
  const env = await freshEnv();
  const { pluginInstalledDir } = await importFresh(PLUGIN_MODULE);
  const { default: install } = await importFresh(INSTALL_MODULE);
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  try {
    const { descriptor } = await createFixturePackage(fixtureDir, {
      id: "happy.plugin",
      command: "happy",
      entry: "./climier.mjs",
      npmName: "happy-plugin",
      dirName: "happy-plugin",
    });
    const result = await install({ positional: [fixtureDir + "/happy-plugin"], flags: {}, projectDir: fixtureDir, statePath: fixtureDir });
    assert.equal(result.plugin.id, descriptor.id);
    assert.equal(result.plugin.command, descriptor.command);
    assert.equal(result.plugin.entry, descriptor.entry);
    // Staging is empty (no leftover dirs).
    const stagings = await listStagingDirs(env);
    assert.deepEqual(stagings, []);
    // Installed at the right location with the expected layout.
    // T-plugin-command-namespace: the directory name MUST be
    // descriptor.command (the CLI namespace), not descriptor.id.
    const installedAt = await installedDir(env, "happy");
    assert.equal(await pathEqual(pluginInstalledDir("happy"), installedAt), true);
    const st = await fs.stat(installedAt);
    assert.ok(st.isDirectory());
    // The promoted directory must contain node_modules/<basename>/package.json
    // with the original descriptor preserved.
    const pkg = JSON.parse(
      await fs.readFile(path.join(installedAt, "node_modules", "happy-plugin", "package.json"), "utf8"),
    );
    assert.equal(pkg.climier.id, "happy.plugin");
    assert.equal(pkg.climier.command, "happy");
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test("install: descriptor with id != command lands at installed/<command>", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  try {
    await createFixturePackage(fixtureDir, {
      id: "example.audit",
      command: "audit",
      entry: "./climier.mjs",
      npmName: "audit-plugin",
      dirName: "audit-plugin",
    });
    const result = await install({
      positional: [path.join(fixtureDir, "audit-plugin")],
      flags: {},
      projectDir: fixtureDir,
      statePath: fixtureDir,
    });
    assert.equal(result.plugin.id, "example.audit");
    assert.equal(result.plugin.command, "audit");
    // Directory name is the CLI namespace (descriptor.command), not the
    // descriptor.id. installed/<example.audit> must NOT exist.
    const dirByCommand = await installedDir(env, "audit");
    const dirById = await installedDir(env, "example.audit");
    assert.ok((await fs.stat(dirByCommand)).isDirectory(), "installed/audit exists");
    await assert.rejects(fs.access(dirById), "installed/example.audit must NOT exist");
    // Staging is clean.
    assert.deepEqual(await listStagingDirs(env), []);
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

async function pathEqual(a, b) {
  return path.resolve(a) === path.resolve(b);
}

// ---- install: invalid descriptor ------------------------------------

test("install: missing climier.id returns PLUGIN_INVALID_DESCRIPTOR and cleans staging", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  try {
    // skipDescriptor:true writes no climier field at all.
    await createFixturePackage(fixtureDir, {
      skipDescriptor: true,
      npmName: "no-id",
      dirName: "no-id",
    });
    await assert.rejects(
      install({ positional: [fixtureDir + "/no-id"], flags: {}, projectDir: fixtureDir, statePath: fixtureDir }),
      (err) => err.code === "PLUGIN_INVALID_DESCRIPTOR",
    );
    assert.deepEqual(await listStagingDirs(env), []);
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test("install: descriptor with invalid id regex returns PLUGIN_INVALID_DESCRIPTOR and cleans staging", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  try {
    await createFixturePackage(fixtureDir, {
      id: ".bad", // fails the ADR regex (must start with [A-Za-z0-9])
      command: "ok-cmd",
      npmName: "bad-id-pkg",
      dirName: "bad-id-pkg",
    });
    await assert.rejects(
      install({ positional: [fixtureDir + "/bad-id-pkg"], flags: {}, projectDir: fixtureDir, statePath: fixtureDir }),
      (err) => err.code === "PLUGIN_INVALID_DESCRIPTOR",
    );
    assert.deepEqual(await listStagingDirs(env), []);
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test("install: descriptor missing command returns PLUGIN_INVALID_DESCRIPTOR and cleans staging", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  try {
    await createFixturePackage(fixtureDir, {
      id: "ok.id",
      command: "", // empty
      npmName: "no-cmd",
      dirName: "no-cmd",
    });
    await assert.rejects(
      install({ positional: [fixtureDir + "/no-cmd"], flags: {}, projectDir: fixtureDir, statePath: fixtureDir }),
      (err) => err.code === "PLUGIN_INVALID_DESCRIPTOR",
    );
    assert.deepEqual(await listStagingDirs(env), []);
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test("install: descriptor missing entry returns PLUGIN_INVALID_DESCRIPTOR and cleans staging", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  try {
    await createFixturePackage(fixtureDir, {
      id: "ok.id",
      command: "ok-cmd",
      entry: "", // empty
      npmName: "no-entry",
      dirName: "no-entry",
    });
    await assert.rejects(
      install({ positional: [fixtureDir + "/no-entry"], flags: {}, projectDir: fixtureDir, statePath: fixtureDir }),
      (err) => err.code === "PLUGIN_INVALID_DESCRIPTOR",
    );
    assert.deepEqual(await listStagingDirs(env), []);
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

// ---- install: id collision ------------------------------------------

test("install: id already installed returns PLUGIN_ID_CONFLICT and cleans staging", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  try {
    // First install succeeds.
    await createFixturePackage(fixtureDir, {
      id: "double.id",
      command: "double",
      npmName: "double-pkg",
      dirName: "double-pkg",
    });
    await install({ positional: [fixtureDir + "/double-pkg"], flags: {}, projectDir: fixtureDir, statePath: fixtureDir });
    // Second install of a fresh fixture with the same climier.id fails.
    const secondDir = path.join(fixtureDir, "double-pkg-2");
    await mkdirp(secondDir);
    await createFixturePackage(secondDir, {
      id: "double.id",
      command: "double",
      npmName: "double-pkg",
      dirName: "double-pkg",
    });
    await assert.rejects(
      install({ positional: [secondDir + "/double-pkg"], flags: {}, projectDir: fixtureDir, statePath: fixtureDir }),
      (err) =>
        err.code === "PLUGIN_ID_CONFLICT" &&
        err.details.id === "double.id" &&
        err.details.reason === "command-already-installed",
    );
    assert.deepEqual(await listStagingDirs(env), []);
    // First plugin still installed at installed/<command>.
    const installedAt = await installedDir(env, "double");
    assert.ok((await fs.stat(installedAt)).isDirectory());
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test("install: id collision across different commands is rejected and cleans staging", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  try {
    // First install lands at installed/alpha; id="shared.id", command="alpha".
    await createFixturePackage(fixtureDir, {
      id: "shared.id",
      command: "alpha",
      npmName: "alpha-pkg",
      dirName: "alpha-pkg",
    });
    await install({
      positional: [path.join(fixtureDir, "alpha-pkg")],
      flags: {},
      projectDir: fixtureDir,
      statePath: fixtureDir,
    });
    // Second install has id="shared.id" but command="beta"; commands do
    // NOT collide (different dir names) but ids DO collide. Install must
    // reject with PLUGIN_ID_CONFLICT and reason=id-already-installed.
    const secondDir = path.join(fixtureDir, "beta-pkg");
    await mkdirp(secondDir);
    await createFixturePackage(secondDir, {
      id: "shared.id",
      command: "beta",
      npmName: "beta-pkg",
      dirName: "beta-pkg",
    });
    await assert.rejects(
      install({
        positional: [path.join(secondDir, "beta-pkg")],
        flags: {},
        projectDir: fixtureDir,
        statePath: fixtureDir,
      }),
      (err) =>
        err.code === "PLUGIN_ID_CONFLICT" &&
        err.details.id === "shared.id" &&
        err.details.reason === "id-already-installed",
    );
    assert.deepEqual(await listStagingDirs(env), []);
    // First plugin still installed; the rejected second never promoted.
    assert.ok((await fs.stat(await installedDir(env, "alpha"))).isDirectory());
    await assert.rejects(fs.access(await installedDir(env, "beta")));
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

// ---- install: reserved namespace collision --------------------------

test("install: command colliding with reserved core namespace fails and cleans staging", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  try {
    await createFixturePackage(fixtureDir, {
      id: "trojan.id",
      command: "status", // collides with reserved namespace
      npmName: "trojan-pkg",
      dirName: "trojan-pkg",
    });
    await assert.rejects(
      install({ positional: [fixtureDir + "/trojan-pkg"], flags: {}, projectDir: fixtureDir, statePath: fixtureDir }),
      (err) => err.code === "PLUGIN_INVALID_DESCRIPTOR",
    );
    assert.deepEqual(await listStagingDirs(env), []);
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

// ---- install: import / shape failure -------------------------------

test("install: entry without default.commands returns PLUGIN_LOAD_FAILED and cleans staging", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  try {
    await createFixturePackage(fixtureDir, {
      id: "broken.entry",
      command: "broken",
      entry: "./climier.mjs",
      npmName: "broken-pkg",
      dirName: "broken-pkg",
      entryCode: "export default { foo: 1 };\n", // no commands key
    });
    await assert.rejects(
      install({ positional: [fixtureDir + "/broken-pkg"], flags: {}, projectDir: fixtureDir, statePath: fixtureDir }),
      (err) => err.code === "PLUGIN_LOAD_FAILED",
    );
    assert.deepEqual(await listStagingDirs(env), []);
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

// ---- install: npm unavailable ---------------------------------------

test("install: when the npm command cannot be spawned, returns PLUGIN_NPM_UNAVAILABLE and cleans staging", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  const prevNpm = process.env.CLIMIER_NPM_CMD;
  process.env.CLIMIER_NPM_CMD = "/this/path/does/not/exist/npm-please";
  try {
    await createFixturePackage(fixtureDir, {
      id: "needs.npm",
      command: "needs",
      npmName: "needs-pkg",
      dirName: "needs-pkg",
    });
    await assert.rejects(
      install({ positional: [fixtureDir + "/needs-pkg"], flags: {}, projectDir: fixtureDir, statePath: fixtureDir }),
      (err) => err.code === "PLUGIN_NPM_UNAVAILABLE",
    );
    assert.deepEqual(await listStagingDirs(env), []);
  } finally {
    if (prevNpm === undefined) delete process.env.CLIMIER_NPM_CMD;
    else process.env.CLIMIER_NPM_CMD = prevNpm;
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

// ---- install: concurrent installs serialize -------------------------

test("install: two concurrent installs against the same source serialize via global plugin lock", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  try {
    await createFixturePackage(fixtureDir, {
      id: "conc.id",
      command: "conc",
      npmName: "conc-pkg",
      dirName: "conc-pkg",
    });
    const source = path.join(fixtureDir, "conc-pkg");
    const callOrder = [];
    // Both installs run in parallel; the global plugin lock serializes
    // them so the second observes the first's installed/ promotion. We
    // capture both outcomes (success or PLUGIN_ID_CONFLICT) on either
    // side, so neither rejection bubbles up to Promise.all.
    const capture = (label) => (p) =>
      p.then(
        (r) => { callOrder.push(`${label}:success`); return r; },
        (err) => { callOrder.push(`${label}:${err.code}`); return err; },
      );
    const [r1, r2] = await Promise.all([
      capture("first")(install({ positional: [source], flags: {}, projectDir: fixtureDir, statePath: fixtureDir })),
      capture("second")(install({ positional: [source], flags: {}, projectDir: fixtureDir, statePath: fixtureDir })),
    ]);
    // Exactly one succeeded; the other got PLUGIN_ID_CONFLICT.
    const success = [r1, r2].filter((r) => r && r.plugin);
    const conflict = [r1, r2].filter((r) => r && r.code === "PLUGIN_ID_CONFLICT");
    assert.equal(success.length, 1);
    assert.equal(conflict.length, 1);
    assert.equal(callOrder.length, 2);
    // No staging leftover.
    assert.deepEqual(await listStagingDirs(env), []);
    // Installed exactly once (directory name is the command, not the id).
    const installedAt = await installedDir(env, "conc");
    assert.ok((await fs.stat(installedAt)).isDirectory());
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

// ---- install: project state untouched -------------------------------

test("install: never mutates the project state file", async () => {
  const env = await freshEnv();
  const projectDir = await createTempProject();
  // Seed a v2 state to make sure install does not touch it.
  await writeState(projectDir, {
    version: 2,
    nodes: {
      "T-existing": {
        id: "T-existing",
        kind: "resolvable",
        subkind: "task",
        title: "Existing task",
        status: "open",
        revision: 1,
      },
    },
    edges: [],
    initiatives: { x: { desc: "x", created_at: new Date().toISOString() } },
    log: [{ ts: new Date().toISOString(), agent: "seed", action: "seed", note: "seeded" }],
  });
  const beforeMtime = (await fs.stat(stateFilePath(projectDir))).mtimeMs;
  const beforeRaw = await fs.readFile(stateFilePath(projectDir), "utf8");
  const { default: install } = await importFresh(INSTALL_MODULE);
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  try {
    await createFixturePackage(fixtureDir, {
      id: "no.touch",
      command: "no-touch",
      npmName: "no-touch-pkg",
      dirName: "no-touch-pkg",
    });
    await install({ positional: [path.join(fixtureDir, "no-touch-pkg")], flags: {}, projectDir, statePath: projectDir });
    const afterMtime = (await fs.stat(stateFilePath(projectDir))).mtimeMs;
    const afterRaw = await fs.readFile(stateFilePath(projectDir), "utf8");
    assert.equal(afterMtime, beforeMtime, "install must not write the project state file");
    assert.equal(afterRaw, beforeRaw, "install must not change the project state bytes");
  } finally {
    await rmTempProject(projectDir);
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

// ---- install: arg validation ----------------------------------------

test("install: rejects missing positional with PLUGIN_INVALID_DESCRIPTOR", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  try {
    await assert.rejects(
      install({ positional: [], flags: {}, projectDir: "/tmp", statePath: "/tmp" }),
      (err) => err.code === "PLUGIN_INVALID_DESCRIPTOR",
    );
  } finally {
    env.restore();
    await env.cleanup();
  }
});

// ---- uninstall ------------------------------------------------------

test("uninstall: removes installed/<id> and nothing else; project state is untouched", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  const { default: uninstall } = await importFresh(UNINSTALL_MODULE);
  const projectDir = await createTempProject();
  await writeState(projectDir, {
    version: 2,
    nodes: {},
    edges: [],
    initiatives: {},
    log: [{ ts: new Date().toISOString(), agent: "seed", action: "seed", note: "seeded" }],
  });
  const statePath = stateFilePath(projectDir);
  const beforeRaw = await fs.readFile(statePath, "utf8");
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  try {
    // Install plugin A.
    await createFixturePackage(fixtureDir, {
      id: "plugin.a",
      command: "a",
      npmName: "a-pkg",
      dirName: "a-pkg",
    });
    await install({ positional: [path.join(fixtureDir, "a-pkg")], flags: {}, projectDir, statePath: projectDir });
    // Install plugin B (so we can verify uninstall doesn't touch it).
    await createFixturePackage(fixtureDir, {
      id: "plugin.b",
      command: "b",
      npmName: "b-pkg",
      dirName: "b-pkg",
    });
    await install({ positional: [path.join(fixtureDir, "b-pkg")], flags: {}, projectDir, statePath: projectDir });

    const aPath = await installedDir(env, "a");
    const bPath = await installedDir(env, "b");
    assert.ok((await fs.stat(aPath)).isDirectory());
    assert.ok((await fs.stat(bPath)).isDirectory());

    const result = await uninstall({ positional: ["plugin.a"], flags: {}, projectDir, statePath: projectDir });
    assert.equal(result.plugin.id, "plugin.a");
    assert.equal(result.plugin.uninstalled, true);

    await assert.rejects(fs.access(aPath));
    assert.ok((await fs.stat(bPath)).isDirectory());

    const afterRaw = await fs.readFile(statePath, "utf8");
    assert.equal(afterRaw, beforeRaw, "uninstall must not change project state");
  } finally {
    await rmTempProject(projectDir);
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test("uninstall: removes installed/<id> even when no project state exists", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  const { default: uninstall } = await importFresh(UNINSTALL_MODULE);
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  try {
    await createFixturePackage(fixtureDir, {
      id: "lone.plugin",
      command: "lone",
      npmName: "lone-pkg",
      dirName: "lone-pkg",
    });
    await install({ positional: [path.join(fixtureDir, "lone-pkg")], flags: {}, projectDir: "/tmp/x", statePath: "/tmp/x" });
    // T-plugin-command-namespace: installed dir is named after command,
    // not id; uninstall by id still removes it via descriptor scan.
    const aPath = await installedDir(env, "lone");
    assert.ok((await fs.stat(aPath)).isDirectory());
    const result = await uninstall({ positional: ["lone.plugin"], flags: {}, projectDir: "/tmp/x", statePath: "/tmp/x" });
    assert.equal(result.plugin.id, "lone.plugin");
    await assert.rejects(fs.access(aPath));
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test("uninstall: rejects missing positional", async () => {
  const env = await freshEnv();
  const { default: uninstall } = await importFresh(UNINSTALL_MODULE);
  try {
    await assert.rejects(
      uninstall({ positional: [], flags: {}, projectDir: "/tmp/x", statePath: "/tmp/x" }),
      (err) => /uninstall:/.test(err.message),
    );
  } finally {
    env.restore();
    await env.cleanup();
  }
});

test("uninstall: id not installed is a no-op that still resolves", async () => {
  const env = await freshEnv();
  const { default: uninstall } = await importFresh(UNINSTALL_MODULE);
  try {
    const result = await uninstall({ positional: ["never.installed"], flags: {}, projectDir: "/tmp/x", statePath: "/tmp/x" });
    assert.equal(result.plugin.id, "never.installed");
    assert.equal(result.plugin.uninstalled, true);
  } finally {
    env.restore();
    await env.cleanup();
  }
});

test("uninstall: removes installed/<command> when uninstall <id> and id != command", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  const { default: uninstall } = await importFresh(UNINSTALL_MODULE);
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  try {
    await createFixturePackage(fixtureDir, {
      id: "example.audit",
      command: "audit",
      npmName: "audit-pkg",
      dirName: "audit-pkg",
    });
    await install({
      positional: [path.join(fixtureDir, "audit-pkg")],
      flags: {},
      projectDir: "/tmp/x",
      statePath: "/tmp/x",
    });
    const dirByCommand = await installedDir(env, "audit");
    const dirById = await installedDir(env, "example.audit");
    assert.ok((await fs.stat(dirByCommand)).isDirectory(), "installed/audit exists");
    await assert.rejects(fs.access(dirById), "installed/example.audit must NOT exist");
    // User types uninstall by id; host must find and remove installed/audit.
    const result = await uninstall({
      positional: ["example.audit"],
      flags: {},
      projectDir: "/tmp/x",
      statePath: "/tmp/x",
    });
    assert.equal(result.plugin.id, "example.audit");
    assert.equal(result.plugin.uninstalled, true);
    await assert.rejects(fs.access(dirByCommand));
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

// ---- utilities ------------------------------------------------------

function capture(fn) {
  try { fn(); return null; } catch (e) { return e; }
}
