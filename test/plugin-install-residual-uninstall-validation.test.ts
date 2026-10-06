// Focused plugin install/uninstall tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { importFresh } from "./helpers.mjs";
import { UNINSTALL_MODULE, freshEnv } from "./plugin-install-test-helpers.mjs";

test("uninstall: rejects missing positional", async () => {
  const env = await freshEnv();
  const { default: uninstall } = await importFresh(UNINSTALL_MODULE);
  try {
    await assert.rejects(
      uninstall({ positional: [], flags: {}, projectDir: "/tmp/x", statePath: "/tmp/x" }),
      (err) => /uninstall:/.test(String((err as { message?: unknown }).message)),
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
