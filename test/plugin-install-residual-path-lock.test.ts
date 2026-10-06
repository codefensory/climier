// Focused plugin install/uninstall tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { importFresh } from "./helpers.mjs";
import { PLUGIN_MODULE, LOCK_MODULE, freshEnv } from "./plugin-install-test-helpers.mjs";

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
    const order: string[] = [];
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
