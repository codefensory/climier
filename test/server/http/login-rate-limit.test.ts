import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProjectCatalog } from "../../../src/server/catalog/index.ts";
import { createRemoteApiServer, PROTOCOL_VERSION } from "../../../src/server/http.ts";
import { createLoginRateLimiter, loginClientAddress } from "../../../src/server/auth/login-rate-limiter.ts";

async function errorCode(response: Response): Promise<string> {
  return (await response.json() as { error: { code: string } }).error.code;
}

function authStore() {
  return Object.freeze({
    async login(password) {
      if (password !== "password") {
        const error = new Error("invalid password");
        error.code = "AUTH_INVALID_PASSWORD";
        throw error;
      }
      return "login-token";
    },
    async verifyBearer(token) { return token === "login-token"; },
  });
}

async function withLoginServer(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-login-limit-"));
  let now = 0;
  const server = createRemoteApiServer({
    catalog: createProjectCatalog({ dataRoot: path.join(root, "catalog") }),
    authStore: authStore(),
    loginRateLimiter: createLoginRateLimiter({ now: () => now }),
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({ baseUrl, advance: (ms) => { now += ms; } });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function login(baseUrl, password, headers = {}) {
  return fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: {
      "x-climier-protocol-version": PROTOCOL_VERSION,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ password }),
  });
}

async function failLogin(baseUrl, address = "203.0.113.10") {
  const response = await login(baseUrl, "wrong", { "x-forwarded-for": address });
  assert.equal(response.status, 401, JSON.stringify(await response.clone().json()));
  assert.equal(await errorCode(response), "AUTH_INVALID");
}

test("login rate limit locks an address after five failures and expires after fifteen minutes", async () => {
  await withLoginServer(async ({ baseUrl, advance }) => {
    for (let i = 0; i < 5; i += 1) {
      await failLogin(baseUrl);
    }

    const locked = await login(baseUrl, "password", { "x-forwarded-for": "203.0.113.10" });
    assert.equal(locked.status, 429);
    assert.equal(await errorCode(locked), "AUTH_RATE_LIMITED");

    advance(15 * 60 * 1000);
    const allowed = await login(baseUrl, "password", { "x-forwarded-for": "203.0.113.10" });
    assert.equal(allowed.status, 200, JSON.stringify(await allowed.clone().json()));
    assert.equal((await allowed.json() as { token: string }).token, "login-token");
  });
});

test("login failures are isolated per forwarded client and success resets the counter", async () => {
  await withLoginServer(async ({ baseUrl }) => {
    for (let i = 0; i < 5; i += 1) {
      await failLogin(baseUrl, "203.0.113.20");
    }
    const otherAddress = await login(baseUrl, "password", { "x-forwarded-for": "203.0.113.21" });
    assert.equal(otherAddress.status, 200, JSON.stringify(await otherAddress.clone().json()));

    for (let i = 0; i < 4; i += 1) {
      await failLogin(baseUrl, "203.0.113.22");
    }
    const reset = await login(baseUrl, "password", { "x-forwarded-for": "203.0.113.22" });
    assert.equal(reset.status, 200, JSON.stringify(await reset.clone().json()));
    for (let i = 0; i < 4; i += 1) {
      await failLogin(baseUrl, "203.0.113.22");
    }
    const stillAllowed = await login(baseUrl, "password", { "x-forwarded-for": "203.0.113.22" });
    assert.equal(stillAllowed.status, 200, JSON.stringify(await stillAllowed.clone().json()));
  });
});

test("malformed forwarded input falls back to the loopback peer and cannot evade a lock", async () => {
  await withLoginServer(async ({ baseUrl }) => {
    for (let i = 0; i < 5; i += 1) {
      const response = await login(baseUrl, "wrong");
      assert.equal(response.status, 401);
    }

    for (const malformed of ["not an ip", "203.0.113.30, 203.0.113.31"]) {
      const locked = await login(baseUrl, "password", { "x-forwarded-for": malformed });
      assert.equal(locked.status, 429);
      assert.equal(await errorCode(locked), "AUTH_RATE_LIMITED");
    }
  });
});

test("forwarded identity is trusted only from loopback peers", () => {
  assert.equal(loginClientAddress({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "203.0.113.40" } }), "203.0.113.40");
  assert.equal(loginClientAddress({ socket: { remoteAddress: "198.51.100.5" }, headers: { "x-forwarded-for": "203.0.113.41" } }), "198.51.100.5");
  assert.equal(loginClientAddress({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "bad" } }), "127.0.0.1");
});
