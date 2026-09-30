import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import logout from "../src/cli/commands/logout.mjs";
import { createCredentialStore } from "../src/storage/credential-profile.mjs";

test("logout removes only the selected origin session", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-logout-"));
  try {
    const store = createCredentialStore({ home });
    await store.set("https://one.example", "one-token");
    await store.set("https://two.example", "two-token");
    const result = await logout({ flags: { server: "https://one.example/path" }, projectConfig: {}, credentialStore: store });
    assert.deepEqual(result, { session: { origin: "https://one.example", removed: true } });
    assert.equal(await store.get("https://one.example"), null);
    assert.equal(await store.get("https://two.example"), "two-token");
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("logout resolves the linked origin and is idempotent", async () => {
  const calls = [];
  const result = await logout({
    projectConfig: { project_id: "p", backend: { type: "remote", url: "https://remote.example/base", protocol: "v2" } },
    credentialStore: { async delete(origin) { calls.push(origin); return false; } },
  });
  assert.deepEqual(calls, ["https://remote.example"]);
  assert.deepEqual(result, { session: { origin: "https://remote.example", removed: false } });
});
