import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { createTempProject, jsonStateFilePath, readState, rmTempProject, runCli, stateFilePath, writeLegacyJsonState } from "./helpers.ts";

function fixture() {
  return {
    version: 1,
    revision: 12,
    initiatives: { migration: { desc: "Fixture", created_at: "2026-10-20T00:00:00.000Z" } },
    nodes: {
      "T-large": {
        id: "T-large", kind: "resolvable", subkind: "task", title: "Large body", initiative: "migration",
        status: "open", body: "x".repeat(3 * 1024 * 1024),
      },
    },
    edges: [],
    log: [{ action: "take", node: "T-large", agent: "worker", at: "2026-10-20T00:00:00.000Z" }],
  };
}

function backupPath(projectDir: string) {
  return `${jsonStateFilePath(projectDir)}.sqlite-backup`;
}

async function cli(projectDir: string, args: string[]) {
  return runCli(["--project", projectDir, ...args]);
}

async function assertReproducibleExport(projectDir: string, original: Buffer) {
  const first = await cli(projectDir, ["state", "export"]);
  assert.equal(first.code, 0, `${first.stderr}\n${first.stdout}`);
  const second = await cli(projectDir, ["state", "export"]);
  assert.equal(second.code, 0, `${second.stderr}\n${second.stdout}`);
  assert.equal(first.stdout, second.stdout, "exports must be reproducible");
  assert.deepEqual(JSON.parse(first.stdout), JSON.parse(original.toString("utf8")));
  return first.stdout;
}

test("explicit migration is advertised under state, not as a top-level importer", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /state migrate --as <agent> --yes/);
  assert.doesNotMatch(help.stdout, /\n  migrate(?:\s|\n)/i);

  const result = await runCli(["migrate"]);
  assert.equal(result.code, 2, result.stdout);
  assert.match(JSON.parse(result.stdout).error.message, /unknown command 'migrate'/);
});

test("state migrate flags cannot be silently ignored by read subcommands", async () => {
  const dir = await createTempProject();
  try {
    const result = await cli(dir, ["state", "--yes"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /only valid with state migrate/);
  } finally {
    await rmTempProject(dir);
  }
});

test("a tasks.json-only project requires explicit migration and is never imported on read", async () => {
  const dir = await createTempProject();
  try {
    await writeLegacyJsonState(dir, fixture());
    const result = await cli(dir, ["state", "export"]);
    assert.notEqual(result.code, 0);
    assert.match(JSON.parse(result.stdout).error.message, /climier state migrate/);
    await assert.rejects(fsp.access(stateFilePath(dir)), { code: "ENOENT" });
  } finally {
    await rmTempProject(dir);
  }
});

test("state migrate requires explicit confirmation and does not write before it", async () => {
  const dir = await createTempProject();
  try {
    await writeLegacyJsonState(dir, fixture());
    const jsonFile = jsonStateFilePath(dir);
    const original = await fsp.readFile(jsonFile);

    const result = await cli(dir, ["state", "migrate", "--as", "worker"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /--yes/);
    assert.deepEqual(await fsp.readFile(jsonFile), original);
    await assert.rejects(fsp.access(backupPath(dir)), { code: "ENOENT" });
    await assert.rejects(fsp.access(stateFilePath(dir)), { code: "ENOENT" });
  } finally {
    await rmTempProject(dir);
  }
});

test("state migrate backs up and imports schema-1 JSON with a reproducible export", async () => {
  const dir = await createTempProject();
  try {
    await writeLegacyJsonState(dir, fixture());
    const jsonFile = jsonStateFilePath(dir);
    const original = await fsp.readFile(jsonFile);
    const expectedHash = crypto.createHash("sha256").update(original).digest("hex");

    let result = await cli(dir, ["state", "migrate", "--as", "worker", "--yes"]);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).migrated, true);
    const backup = await fsp.readFile(backupPath(dir));
    assert.equal(crypto.createHash("sha256").update(backup).digest("hex"), expectedHash);
    assert.deepEqual(backup, original);
    await fsp.access(stateFilePath(dir));

    const firstExport = await assertReproducibleExport(dir, original);
    result = await cli(dir, ["state", "migrate", "--as", "worker", "--yes"]);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).migrated, false);
    const exported = await cli(dir, ["state", "export"]);
    assert.equal(exported.code, 0, exported.stdout);
    assert.deepEqual(JSON.parse(exported.stdout), JSON.parse(firstExport));
    const status = await cli(dir, ["status"]);
    assert.equal(status.code, 0, status.stdout);
  } finally {
    await rmTempProject(dir);
  }
});

test("state migrate strips retired fence_generation from SQLite state and export", async () => {
  const dir = await createTempProject();
  try {
    await writeLegacyJsonState(dir, { ...fixture(), fence_generation: 7 });
    const migrated = await cli(dir, ["state", "migrate", "--as", "worker", "--yes"]);
    assert.equal(migrated.code, 0, `${migrated.stderr}\n${migrated.stdout}`);

    const state = await readState(dir);
    assert.equal(Object.hasOwn(state, "fence_generation"), false);

    const exported = await cli(dir, ["state", "export"]);
    assert.equal(exported.code, 0, exported.stdout);
    assert.equal(Object.hasOwn(JSON.parse(exported.stdout), "fence_generation"), false);
  } finally {
    await rmTempProject(dir);
  }
});

test("state migrate refuses a changed or unverifiable backup instead of overwriting it", async () => {
  const dir = await createTempProject();
  try {
    await writeLegacyJsonState(dir, fixture());
    const migrated = await cli(dir, ["state", "migrate", "--as", "worker", "--yes"]);
    assert.equal(migrated.code, 0, `${migrated.stderr}\n${migrated.stdout}`);
    const before = await cli(dir, ["state", "export"]);
    assert.equal(before.code, 0, before.stdout);

    await fsp.writeFile(backupPath(dir), "tampered backup");
    const result = await cli(dir, ["state", "migrate", "--as", "worker", "--yes"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /backup/i);
    const after = await cli(dir, ["state", "export"]);
    assert.equal(after.code, 0, after.stdout);
    assert.equal(after.stdout, before.stdout);
  } finally {
    await rmTempProject(dir);
  }
});
