// Focused plugin install/uninstall tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createTempProject, rmTempProject, importFresh, stateFilePath, writeCanonicalState } from "./helpers.mjs";
import { INSTALL_MODULE, UNINSTALL_MODULE, freshEnv, createFixturePackage, installedDir, uninstallOnlyNamedPlugin } from "./plugin-install-test-helpers.mjs";

test("uninstall: removes installed/<id> and nothing else; project state is untouched", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  const { default: uninstall } = await importFresh(UNINSTALL_MODULE);
  const projectDir = await createTempProject();
  await writeCanonicalState(projectDir, {
    version: 1,
    nodes: {},
    edges: [],
    initiatives: {},
    log: [{ ts: new Date().toISOString(), agent: "seed", action: "seed", note: "seeded" }],
  });
  const statePath = stateFilePath(projectDir);
  const beforeRaw = await fs.readFile(statePath, "utf8");
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  try {
    await uninstallOnlyNamedPlugin({ env, projectDir, install, uninstall, fixtureDir, statePath, beforeRaw });
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
    // T-plugin-command-layout-fix: installed dir IS descriptor.id;
    // uninstall <id> removes it by path directly.
    const aPath = await installedDir(env, "lone.plugin");
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
test("uninstall: removes installed/<id> by path directly even when id != command", async () => {
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
    // T-plugin-command-layout-fix: installed dir IS descriptor.id
    // (NOT descriptor.command). The bin dispatches `climier audit ...`
    // via descriptor scan; uninstall `example.audit` removes the dir
    // named after that id.
    const dirById = await installedDir(env, "example.audit");
    const dirByCommand = await installedDir(env, "audit");
    assert.ok((await fs.stat(dirById)).isDirectory(), "installed/example.audit exists");
    await assert.rejects(fs.access(dirByCommand), "installed/audit must NOT exist");
    const result = await uninstall({
      positional: ["example.audit"],
      flags: {},
      projectDir: "/tmp/x",
      statePath: "/tmp/x",
    });
    assert.equal(result.plugin.id, "example.audit");
    assert.equal(result.plugin.uninstalled, true);
    await assert.rejects(fs.access(dirById));
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});
