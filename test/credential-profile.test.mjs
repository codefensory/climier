import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCredentialStore } from "../src/storage/credential-profile.mjs";

async function withHome(run) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-credentials-"));
  try { await run(home); }
  finally { await fs.rm(home, { recursive: true, force: true }); }
}

test("credential profile accepts remote HTTP origins only with the exact insecure opt-in", async () => {
  const previous = process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
  process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = "true";
  try {
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
  } finally {
    if (previous === undefined) {delete process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;} else {process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = previous;}
  }
});

test("credential profile with an HTTP session remains readable for HTTPS when opt-in is absent", async () => {
  const previous = process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
  process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = "true";
  try {
    await withHome(async (home) => {
      const store = createCredentialStore({ home });
      await store.set("http://remote-one.example.test:43128", "http-token");
      delete process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
      assert.equal(await store.get("https://climier.example.test"), null);
      await assert.rejects(store.get("http://remote-one.example.test:43128"), /HTTPS outside localhost/);
    });
  } finally {
    if (previous === undefined) {delete process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;} else {process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = previous;}
  }
});

test("credential profile rejects remote HTTP origins without the opt-in", async () => {
  const previous = process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
  delete process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
  try {
    await withHome(async (home) => {
      const store = createCredentialStore({ home });
      await assert.rejects(store.set("http://remote-one.example.test:43128", "profile-token"), /HTTPS outside localhost/);
    });
  } finally {
    if (previous === undefined) {delete process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;} else {process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = previous;}
  }
});
