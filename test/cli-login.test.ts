import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import loginCommand from "../src/cli/commands/login.ts";
import { createCredentialStore } from "../src/storage/credential-profile.ts";

const login = (context: unknown) => loginCommand(context as Parameters<typeof loginCommand>[0]);

test("login requires an interactive TTY before making a request", async () => {
  let requested = false;
  await assert.rejects(login({
    flags: { server: "https://remote.example" },
    projectConfig: {},
    readPassword: async () => { const error = new Error("login: interactive TTY required"); error.code = "INTERACTIVE_LOGIN_REQUIRED"; throw error; },
    requestLogin: async () => { requested = true; },
  }), (error) => (error as { code?: string }).code === "INTERACTIVE_LOGIN_REQUIRED");
  assert.equal(requested, false);
});

test("login stores the bearer by origin and never returns it", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-login-"));
  try {
    const store = createCredentialStore({ home });
    const requests: Array<{ origin: string; password: string }> = [];
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
  let requested: { origin: string; password: string } | undefined;
  await login({
    projectConfig: { project_id: "p", backend: { type: "remote", url: "https://remote.example/base" } },
    readPassword: async () => "secret",
    requestLogin: async (value) => { requested = value; return { token: "token" }; },
    credentialStore: { async set() {} },
  });
  assert.ok(requested);
  assert.equal(requested.origin, "https://remote.example");
});

test("login warns for plaintext non-loopback origins without an opt-in", async () => {
  let requested: { origin: string; password: string } | undefined;
  const result = await login({
    flags: { server: "http://remote.example/path" },
    readPassword: async () => "secret",
    requestLogin: async (options) => { requested = options; return { token: "token" }; },
    credentialStore: { async set() {} },
  });
  assert.deepEqual(requested, { origin: "http://remote.example", password: "secret" });
  assert.deepEqual(result, {
    session: { origin: "http://remote.example" },
    warnings: [{
      kind: "insecure-remote-http",
      severity: "warning",
      message: "login: http://remote.example is not HTTPS; the login password and bearer travel without transport encryption.",
    }],
  });
});

test("login omits warnings for HTTPS and loopback HTTP, and supports --no-warnings", async () => {
  for (const server of ["https://remote.example/path", "http://localhost:43127/path", "http://127.0.0.1:43127/path"]) {
    const result = await login({
      flags: { server },
      readPassword: async () => "secret",
      requestLogin: async () => ({ token: "token" }),
      credentialStore: { async set() {} },
    });
    assert.equal(Object.hasOwn(result, "warnings"), false, server);
  }
  const suppressed = await login({
    flags: { server: "http://remote.example/path", "no-warnings": true },
    readPassword: async () => "secret",
    requestLogin: async () => ({ token: "token" }),
    credentialStore: { async set() {} },
  });
  assert.equal(Object.hasOwn(suppressed, "warnings"), false);
});
