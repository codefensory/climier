import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRemoteTransferBaselineStore } from "../src/storage/remote-transfer-baseline.ts";

function baseline(origin, project_id, remote_revision, local_revision) {
  return { version: 1, origin, project_id, remote_revision, local_revision };
}

async function makeHome(t, name = "climier-transfer-baseline-") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), name));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

async function baselineFiles(home) {
  return fs.readdir(path.join(home, "remote-transfer-baselines"));
}

test("remote transfer baselines are isolated by origin and project id", async (t) => {
  const home = await makeHome(t);
  const store = createRemoteTransferBaselineStore({ home });
  const values = [
    baseline("https://one.example", "project-a", 1, 2),
    baseline("https://two.example", "project-a", 3, 4),
    baseline("https://one.example", "project-b", 5, 6),
    baseline("https://two.example", "project-b", 7, 8),
  ];

  for (const value of values) {await store.set(value);}
  for (const value of values) {
    assert.deepEqual(await store.get(value.origin, value.project_id), value);
  }
  assert.equal((await baselineFiles(home)).length, values.length);
  assert.ok((await baselineFiles(home)).every((file) => /^[a-f0-9]{64}\.json$/.test(file)));
});

test("remote transfer baseline store defaults to CLIMIER_HOME and isolates homes", async (t) => {
  const firstHome = await makeHome(t, "climier-transfer-home-one-");
  const secondHome = await makeHome(t, "climier-transfer-home-two-");
  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = firstHome;
  try {
    const first = createRemoteTransferBaselineStore();
    await first.set(baseline("https://example.test", "same-project", 11, 12));

    process.env.CLIMIER_HOME = secondHome;
    const second = createRemoteTransferBaselineStore();
    assert.equal(await second.get("https://example.test", "same-project"), null);
    await second.set(baseline("https://example.test", "same-project", 21, 22));

    assert.deepEqual(await first.get("https://example.test", "same-project"), baseline("https://example.test", "same-project", 11, 12));
    assert.deepEqual(await second.get("https://example.test", "same-project"), baseline("https://example.test", "same-project", 21, 22));
  } finally {
    if (previousHome === undefined) {delete process.env.CLIMIER_HOME;}
    else {process.env.CLIMIER_HOME = previousHome;}
  }
});

test("baseline identifiers never become path components", async (t) => {
  const home = await makeHome(t);
  const store = createRemoteTransferBaselineStore({ home });
  const value = baseline("../../outside-origin", "../../outside-project", 0, 0);

  await store.set(value);

  assert.deepEqual(await store.get(value.origin, value.project_id), value);
  assert.deepEqual(await fs.readdir(home), ["remote-transfer-baselines"]);
});

test("remote transfer baselines require the exact schema and non-negative integer revisions", async (t) => {
  const home = await makeHome(t);
  const store = createRemoteTransferBaselineStore({ home });
  const valid = baseline("https://example.test", "project", 0, 0);
  const invalid = [
    { ...valid, version: 2 },
    { ...valid, extra: "not allowed" },
    { ...valid, origin: "" },
    { ...valid, project_id: "" },
    { ...valid, remote_revision: -1 },
    { ...valid, remote_revision: 1.5 },
    { ...valid, local_revision: "4" },
    { ...valid, local_revision: -1 },
  ];

  for (const value of invalid) {await assert.rejects(store.set(value));}
  assert.equal(await store.get(valid.origin, valid.project_id), null);
});

test("corrupt or unknown-version baselines fail loud and are never silently overwritten", async (t) => {
  const home = await makeHome(t);
  const store = createRemoteTransferBaselineStore({ home });
  const value = baseline("https://example.test", "project", 1, 2);
  await store.set(value);
  const directory = path.join(home, "remote-transfer-baselines");
  const file = path.join(directory, (await fs.readdir(directory))[0]);

  for (const invalidContent of ["{", JSON.stringify({ ...value, version: 2 })]) {
    await fs.writeFile(file, invalidContent);
    await assert.rejects(store.get(value.origin, value.project_id));
    await assert.rejects(store.set({ ...value, remote_revision: 9 }));
    assert.equal(await fs.readFile(file, "utf8"), invalidContent);
  }
});

test("baseline writes are private, atomic, and contain no credentials", async (t) => {
  const home = await makeHome(t);
  const store = createRemoteTransferBaselineStore({ home });
  const value = baseline("https://example.test", "project", 7, 8);

  await store.set(value);

  const directory = path.join(home, "remote-transfer-baselines");
  const files = await fs.readdir(directory);
  assert.equal(files.length, 1);
  const file = path.join(directory, files[0]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), value);
  assert.equal(JSON.stringify(JSON.parse(await fs.readFile(file, "utf8"))).includes("bearer"), false);
  assert.equal(JSON.stringify(JSON.parse(await fs.readFile(file, "utf8"))).includes("password"), false);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }
});
