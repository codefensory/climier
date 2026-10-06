import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServerAuthStore } from "../src/server/auth/server-auth-store.ts";

async function tempStateHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "climier-auth-store-"));
}

async function readAuthFile(stateHome) {
  return JSON.parse(await fs.readFile(path.join(stateHome, "remote-auth.json"), "utf8"));
}

test("auth store requires a configured password", async () => {
  const stateHome = await tempStateHome();
  await assert.rejects(
    () => createServerAuthStore({ stateHome, password: "" }),
    (error) => error.code === "SERVER_PASSWORD_REQUIRED",
  );
});

test("login rejects incorrect passwords and stores only token hashes", async () => {
  const stateHome = await tempStateHome();
  const auth = await createServerAuthStore({ stateHome, password: "correct horse battery staple" });

  await assert.rejects(
    () => auth.login("wrong"),
    (error) => error.code === "AUTH_INVALID_PASSWORD",
  );

  const token = await auth.login("correct horse battery staple");
  assert.equal(typeof token, "string");
  assert.equal(token.length > 30, true);
  const disk = await readAuthFile(stateHome);
  assert.equal(JSON.stringify(disk).includes(token), false);
  assert.equal(disk.sessions.length, 1);
  assert.match(disk.sessions[0].token_hash, /^[a-f0-9]{64}$/);
});

test("each login returns a different bearer and bearers survive restart", async () => {
  const stateHome = await tempStateHome();
  const auth = await createServerAuthStore({ stateHome, password: "pw" });
  const first = await auth.login("pw");
  const second = await auth.login("pw");
  assert.notEqual(first, second);
  assert.equal(await auth.verifyBearer(first), true);
  assert.equal(await auth.verifyBearer(second), true);

  const restarted = await createServerAuthStore({ stateHome, password: "pw" });
  assert.equal(await restarted.verifyBearer(first), true);
  assert.equal(await restarted.verifyBearer(second), true);
});

test("bearers expire after thirty days", async () => {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const now = () => new Date(nowMs);
  const stateHome = await tempStateHome();
  const auth = await createServerAuthStore({ stateHome, password: "pw", now });
  const token = await auth.login("pw");
  assert.equal(await auth.verifyBearer(token), true);

  nowMs += 30 * 24 * 60 * 60 * 1000 + 1;
  assert.equal(await auth.verifyBearer(token), false);
});

test("password rotation persists a new verifier and revokes all sessions", async () => {
  const stateHome = await tempStateHome();
  const auth = await createServerAuthStore({ stateHome, password: "old" });
  const token = await auth.login("old");
  assert.equal(await auth.verifyBearer(token), true);

  const rotated = await createServerAuthStore({ stateHome, password: "new" });
  assert.equal(await rotated.verifyBearer(token), false);
  await assert.rejects(() => rotated.login("old"), (error) => error.code === "AUTH_INVALID_PASSWORD");
  const replacement = await rotated.login("new");
  assert.equal(await rotated.verifyBearer(replacement), true);
  assert.equal((await readAuthFile(stateHome)).sessions.length, 1);
});

test("auth file writes are serialized under concurrent logins", async () => {
  const stateHome = await tempStateHome();
  const auth = await createServerAuthStore({ stateHome, password: "pw" });
  const tokens = await Promise.all(Array.from({ length: 8 }, () => auth.login("pw")));

  assert.equal(new Set(tokens).size, 8);
  const restarted = await createServerAuthStore({ stateHome, password: "pw" });
  for (const token of tokens) {
    assert.equal(await restarted.verifyBearer(token), true);
  }
  assert.equal((await readAuthFile(stateHome)).sessions.length, 8);
});

test("crash before rename leaves the previous auth file usable and new token invalid", async () => {
  const stateHome = await tempStateHome();
  const stable = await createServerAuthStore({ stateHome, password: "pw" });
  const oldToken = await stable.login("pw");

  const crashing = await createServerAuthStore({
    stateHome,
    password: "pw",
    testHooks: { beforeRename() { throw Object.assign(new Error("simulated crash"), { code: "SIMULATED_CRASH" }); } },
  });
  await assert.rejects(() => crashing.login("pw"), (error) => error.code === "SIMULATED_CRASH");

  const restarted = await createServerAuthStore({ stateHome, password: "pw" });
  assert.equal(await restarted.verifyBearer(oldToken), true);
  assert.equal((await readAuthFile(stateHome)).sessions.length, 1);
});

test("corrupt auth file fails closed", async () => {
  const stateHome = await tempStateHome();
  await fs.mkdir(stateHome, { recursive: true });
  await fs.writeFile(path.join(stateHome, "remote-auth.json"), "{not json", "utf8");

  await assert.rejects(
    () => createServerAuthStore({ stateHome, password: "pw" }),
    (error) => error.code === "AUTH_STORE_CORRUPT",
  );
});
