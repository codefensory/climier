import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import login from "../src/cli/commands/login.mjs";
import { createCredentialStore } from "../src/storage/credential-profile.mjs";

test("login requires an interactive TTY before making a request", async () => {
  let requested = false;
  await assert.rejects(login({
    flags: { server: "https://remote.example" },
    projectConfig: {},
    readPassword: async () => { const error = new Error("login: interactive TTY required"); error.code = "INTERACTIVE_LOGIN_REQUIRED"; throw error; },
    requestLogin: async () => { requested = true; },
  }), (error) => error.code === "INTERACTIVE_LOGIN_REQUIRED");
  assert.equal(requested, false);
});

test("login stores the bearer by origin and never returns it", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-login-"));
  try {
    const store = createCredentialStore({ home });
    const requests = [];
    const result = await login({
      flags: { server: "https://remote.example/path" },
      projectConfig: {},
      readPassword: async () => "super-secret",
      requestLogin: async (options) => { requests.push(options); return { token: "bearer-secret", expires_in_days: 30 }; },
      credentialStore: store,
    });
    assert.deepEqual(requests, [{ origin: "https://remote.example", password: "super-secret" }]);
    assert.deepEqual(result, { session: { origin: "https://remote.example", expires_in_days: 30 } });
    assert.equal(JSON.stringify(result).includes("bearer-secret"), false);
    assert.equal(await store.get("https://remote.example"), "bearer-secret");
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(home)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
    }
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("login does not report success when profile persistence fails", async () => {
  await assert.rejects(login({
    flags: { server: "https://remote.example" },
    projectConfig: {},
    readPassword: async () => "secret",
    requestLogin: async () => ({ token: "token" }),
    credentialStore: { async set() { throw new Error("disk full"); } },
  }), /disk full/);
});

test("login resolves the linked checkout origin when --server is omitted", async () => {
  let requested;
  await login({
    projectConfig: { project_id: "p", backend: { type: "remote", url: "https://remote.example/base", protocol: "v2" } },
    readPassword: async () => "secret",
    requestLogin: async (value) => { requested = value; return { token: "token" }; },
    credentialStore: { async set() {} },
  });
  assert.equal(requested.origin, "https://remote.example");
});

test("login rejects plaintext non-loopback origins before reading or requesting", async () => {
  let read = false;
  let requested = false;
  const previous = process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
  delete process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
  try {
    await assert.rejects(login({
      flags: { server: "http://remote.example" },
      readPassword: async () => { read = true; return "secret"; },
      requestLogin: async () => { requested = true; },
    }), (error) => error.code === "CLI_USAGE_ERROR");
    assert.equal(read, false);
    assert.equal(requested, false);
  } finally {
    if (previous === undefined) {delete process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;}
    else {process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = previous;}
  }
});
