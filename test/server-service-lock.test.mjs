import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireServerServiceLock } from "../src/server/service-lock.mjs";

async function tempStateHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "climier-server-lock-"));
}

test("service lock rejects two concurrent holders and preserves the first lock", async () => {
  const stateHome = await tempStateHome();
  const first = await acquireServerServiceLock(stateHome, { pid: 111, now: () => new Date("2026-01-01T00:00:00.000Z") });

  await assert.rejects(
    () => acquireServerServiceLock(stateHome, { pid: 222 }),
    (error) => error.code === "SERVER_ALREADY_RUNNING" && error.details.lock.pid === 111,
  );

  const raw = JSON.parse(await fs.readFile(path.join(stateHome, ".server.lock"), "utf8"));
  assert.equal(raw.pid, 111);
  await first.release();
  await fs.rm(stateHome, { recursive: true, force: true });
});

test("service lock release removes the lock and allows a new holder", async () => {
  const stateHome = await tempStateHome();
  const first = await acquireServerServiceLock(stateHome, { pid: 111 });
  await first.release();

  const second = await acquireServerServiceLock(stateHome, { pid: 222 });
  const raw = JSON.parse(await fs.readFile(path.join(stateHome, ".server.lock"), "utf8"));
  assert.equal(raw.pid, 222);
  await second.release();
  await fs.rm(stateHome, { recursive: true, force: true });
});

test("stale service lock fails closed and is not auto-removed", async () => {
  const stateHome = await tempStateHome();
  await fs.mkdir(stateHome, { recursive: true });
  const stale = { pid: 999999, started_at: "2020-01-01T00:00:00.000Z" };
  await fs.writeFile(path.join(stateHome, ".server.lock"), JSON.stringify(stale), "utf8");

  await assert.rejects(
    () => acquireServerServiceLock(stateHome, { pid: 222 }),
    (error) => error.code === "SERVER_ALREADY_RUNNING" && error.details.lock.pid === stale.pid,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateHome, ".server.lock"), "utf8")), stale);
  await fs.rm(stateHome, { recursive: true, force: true });
});
