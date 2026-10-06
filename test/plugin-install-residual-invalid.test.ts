// Focused plugin install/uninstall tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { importFresh } from "./helpers.mjs";
import { INSTALL_MODULE, freshEnv, createFixturePackage, listStagingDirs } from "./plugin-install-test-helpers.mjs";

type PluginTestError = { code: string };

function asPluginError(error: unknown): PluginTestError {
  if (!error || typeof error !== "object") {
    throw new TypeError("expected plugin error");
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") {
    throw new TypeError("expected plugin error code");
  }
  return { code };
}

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
      (err) => asPluginError(err).code === "PLUGIN_INVALID_DESCRIPTOR",
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
      (err) => asPluginError(err).code === "PLUGIN_INVALID_DESCRIPTOR",
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
      (err) => asPluginError(err).code === "PLUGIN_INVALID_DESCRIPTOR",
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
      (err) => asPluginError(err).code === "PLUGIN_INVALID_DESCRIPTOR",
    );
    assert.deepEqual(await listStagingDirs(env), []);
  } finally {
    env.restore();
    await env.cleanup();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});
test("install: rejects missing positional with PLUGIN_INVALID_DESCRIPTOR", async () => {
  const env = await freshEnv();
  const { default: install } = await importFresh(INSTALL_MODULE);
  try {
    await assert.rejects(
      install({ positional: [], flags: {}, projectDir: "/tmp", statePath: "/tmp" }),
      (err) => asPluginError(err).code === "PLUGIN_INVALID_DESCRIPTOR"
    );
  } finally {
    env.restore();
    await env.cleanup();
  }
});
