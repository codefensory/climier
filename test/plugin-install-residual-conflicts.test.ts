// Focused plugin install/uninstall tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { importFresh } from "./helpers.ts";
import { INSTALL_MODULE, freshEnv, mkdirp, createFixturePackage, installedDir, listStagingDirs, installCommandCollisionPair } from "./plugin-install-test-helpers.ts";

type PluginTestError = { code: string; details: Record<string, unknown> };

function hasPluginCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}

function asPluginError(error: unknown): PluginTestError {
  if (!error || typeof error !== "object") {
    throw new TypeError("expected plugin error");
  }
  const candidate = error as { code?: unknown; details?: unknown };
  if (
    typeof candidate.code !== "string" ||
    !candidate.details ||
    typeof candidate.details !== "object" ||
    Array.isArray(candidate.details)
  ) {
    throw new TypeError("expected structured plugin error");
  }
  return { code: candidate.code, details: candidate.details as Record<string, unknown> };
}

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
      (err) => {
        const error = asPluginError(err);
        return error.code === "PLUGIN_ID_CONFLICT" &&
          error.details.id === "double.id" &&
          error.details.reason === "id-already-installed";
      },
    );
    assert.deepEqual(await listStagingDirs(env), []);
    // First plugin still installed at installed/<id>.
    const installedAt = await installedDir(env, "double.id");
    assert.ok((await fs.stat(installedAt)).isDirectory());
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});
test("install: command collision across different ids is rejected and cleans staging", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-fixture-"));
  try {
    const secondDir = await installCommandCollisionPair(install, fixtureDir);
    // Second install has id="shared.second" but command="shared"; ids do
    // NOT collide (different dir names) but commands DO collide (two
    // plugins claiming the same CLI namespace). Install must reject with
    // PLUGIN_ID_CONFLICT and reason=command-already-installed.
    await assert.rejects(
      install({
        positional: [path.join(secondDir, "second-pkg")],
        flags: {},
        projectDir: fixtureDir,
        statePath: fixtureDir,
      }),
      (err) => {
        const error = asPluginError(err);
        return error.code === "PLUGIN_ID_CONFLICT" &&
          error.details.id === "shared.second" &&
          error.details.reason === "command-already-installed";
      },
    );
    assert.deepEqual(await listStagingDirs(env), []);
    // First plugin still installed; the rejected second never promoted.
    assert.ok((await fs.stat(await installedDir(env, "shared.first"))).isDirectory());
    await assert.rejects(fs.access(await installedDir(env, "shared.second")));
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});
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
      (err) => asPluginError(err).code === "PLUGIN_INVALID_DESCRIPTOR",
    );
    assert.deepEqual(await listStagingDirs(env), []);
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});
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
      (err) => asPluginError(err).code === "PLUGIN_LOAD_FAILED",
    );
    assert.deepEqual(await listStagingDirs(env), []);
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});
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
      (err) => asPluginError(err).code === "PLUGIN_NPM_UNAVAILABLE",
    );
    assert.deepEqual(await listStagingDirs(env), []);
  } finally {
    if (prevNpm === undefined) {
      delete process.env.CLIMIER_NPM_CMD;
    } else {
      process.env.CLIMIER_NPM_CMD = prevNpm;
    }
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});
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
    const callOrder: string[] = [];
    // Both installs run in parallel; the global plugin lock serializes
    // them so the second observes the first's installed/ promotion. We
    // capture both outcomes (success or PLUGIN_ID_CONFLICT) on either
    // side, so neither rejection bubbles up to Promise.all.
    const captureOutcome = (label) => (p) =>
      p.then(
        (r) => { callOrder.push(`${label}:success`); return r; },
        (err) => { const error = asPluginError(err); callOrder.push(`${label}:${error.code}`); return error; },
      );
    const [r1, r2] = await Promise.all([
      captureOutcome("first")(install({ positional: [source], flags: {}, projectDir: fixtureDir, statePath: fixtureDir })),
      captureOutcome("second")(install({ positional: [source], flags: {}, projectDir: fixtureDir, statePath: fixtureDir })),
    ]);
    // Exactly one succeeded; the other got PLUGIN_ID_CONFLICT.
    const success = [r1, r2].filter((r) => r && r.plugin);
    const conflict = [r1, r2].filter((r) => hasPluginCode(r, "PLUGIN_ID_CONFLICT"));
    assert.equal(success.length, 1);
    assert.equal(conflict.length, 1);
    assert.equal(callOrder.length, 2);
    // No staging leftover.
    assert.deepEqual(await listStagingDirs(env), []);
    // Installed exactly once (directory name is the id, not the command).
    const installedAt = await installedDir(env, "conc.id");
    assert.ok((await fs.stat(installedAt)).isDirectory());
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});
