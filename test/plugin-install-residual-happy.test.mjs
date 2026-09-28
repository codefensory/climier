// Focused plugin install/uninstall tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createTempProject, rmTempProject, importFresh, stateFilePath, writeCanonicalState } from "./helpers.mjs";
import { PLUGIN_MODULE, INSTALL_MODULE, freshEnv, createFixturePackage, installedDir, listStagingDirs, installAndCheckProjectUntouched, assertHappyInstallLayout } from "./plugin-install-test-helpers.mjs";

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
    await assertHappyInstallLayout(env, pluginInstalledDir);
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});
test("install: descriptor with id != command lands at installed/<id>", async () => {
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
    // Directory name is descriptor.id (the CLI namespace "audit" is
    // discovered by descriptor scan at dispatch time, not via dir name).
    const dirById = await installedDir(env, "example.audit");
    const dirByCommand = await installedDir(env, "audit");
    assert.ok((await fs.stat(dirById)).isDirectory(), "installed/example.audit exists");
    await assert.rejects(fs.access(dirByCommand), "installed/audit must NOT exist");
    // Staging is clean.
    assert.deepEqual(await listStagingDirs(env), []);
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});
test("install: never mutates the project state file", async () => {
  const env = await freshEnv();
  const projectDir = await createTempProject();
  // Seed a canonical state to make sure install does not touch it.
  await writeCanonicalState(projectDir, {
    version: 1,
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
    await installAndCheckProjectUntouched({ install, fixtureDir, projectDir, beforeMtime, beforeRaw });
  } finally {
    await rmTempProject(projectDir);
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});
