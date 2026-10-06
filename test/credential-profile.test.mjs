import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCredentialStore } from "../src/storage/credential-profile.ts";

async function withHome(run) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-credentials-"));
  try { await run(home); }
  finally { await fs.rm(home, { recursive: true, force: true }); }
}

test("credential profile accepts remote HTTP origins without an opt-in", async () => {
  await withHome(async (home) => {
    const store = createCredentialStore({ home });
    const origins = ["http://remote-one.example.test:43128", "http://remote-two.example.test:43128"];
    await store.set(origins[0], "profile-token-1");
    await store.set(origins[1], "profile-token-2");
    assert.equal(await store.get(origins[0]), "profile-token-1");
    assert.equal(await store.get(origins[1]), "profile-token-2");
    const mode = (await fs.stat(store.file)).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test("credential profile keeps HTTP sessions readable without an opt-in", async () => {
  await withHome(async (home) => {
    const store = createCredentialStore({ home });
    await store.set("http://remote-one.example.test:43128", "http-token");
    assert.equal(await store.get("https://climier.example.test"), null);
    assert.equal(await store.get("http://remote-one.example.test:43128"), "http-token");
  });
});
