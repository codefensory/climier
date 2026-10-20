import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { createTempProject, rmTempProject, runCli, stateFilePath, writeCanonicalState } from "./helpers.ts";

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
  return `${stateFilePath(projectDir)}.sqlite-backup`;
}

async function cli(projectDir: string, args: string[], backend?: string) {
  return runCli(["--project", projectDir, ...args], {
    env: { CLIMIER_STATE_BACKEND: backend },
  });
}

async function assertReproducibleExport(projectDir: string, original: Buffer) {
  const first = await cli(projectDir, ["state", "export"], "sqlite");
  assert.equal(first.code, 0, `${first.stderr}\n${first.stdout}`);
  const second = await cli(projectDir, ["state", "export"], "sqlite");
  assert.equal(second.code, 0, `${second.stderr}\n${second.stdout}`);
  assert.equal(first.stdout, second.stdout, "exports must be reproducible");
  assert.deepEqual(JSON.parse(first.stdout), JSON.parse(original.toString("utf8")));
  return first.stdout;
}

async function assertBackendReadParity(projectDir: string) {
  for (const args of [["status"], ["context", "T-large", "--as", "reader"], ["history", "T-large"]]) {
    const json = await cli(projectDir, args, "json");
    const sqlite = await cli(projectDir, args, "sqlite");
    assert.equal(json.code, 0, `${json.stderr}\n${json.stdout}`);
    assert.equal(sqlite.code, 0, `${sqlite.stderr}\n${sqlite.stdout}`);
    assert.equal(sqlite.stdout, json.stdout, `${args.join(" ")} differs between JSON and SQLite storage`);
  }
}

async function assertVerifiedBackup(projectDir: string, stateFile: string, original: Buffer, expectedHash: string) {
  const backup = await fsp.readFile(backupPath(projectDir));
  assert.equal(crypto.createHash("sha256").update(backup).digest("hex"), expectedHash);
  assert.deepEqual(await fsp.readFile(stateFile), original, "migration must preserve the JSON source byte-for-byte");
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

test("state migrate requires explicit confirmation and does not write before it", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, fixture());
    const original = await fsp.readFile(stateFilePath(dir));

    const jsonRead = await cli(dir, ["state", "export"]);
    assert.equal(jsonRead.code, 0, `${jsonRead.stderr}\n${jsonRead.stdout}`);
    assert.deepEqual(JSON.parse(jsonRead.stdout), JSON.parse(original.toString("utf8")));

    const result = await cli(dir, ["state", "migrate", "--as", "worker"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /--yes/);
    assert.deepEqual(await fsp.readFile(stateFilePath(dir)), original);
    await assert.rejects(fsp.access(backupPath(dir)), { code: "ENOENT" });
    await assert.rejects(fsp.access(path.join(path.dirname(stateFilePath(dir)), "state.sqlite")), { code: "ENOENT" });
  } finally {
    await rmTempProject(dir);
  }
});

test("state migrate backs up, verifies and imports large schema-1 JSON idempotently", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, fixture());
    const stateFile = stateFilePath(dir);
    const original = await fsp.readFile(stateFile);
    const expectedHash = crypto.createHash("sha256").update(original).digest("hex");

    let result = await cli(dir, ["state", "migrate", "--as", "worker", "--yes"]);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).migrated, true);
    await assertVerifiedBackup(dir, stateFile, original, expectedHash);

    const firstExport = await assertReproducibleExport(dir, original);

    result = await cli(dir, ["state", "migrate", "--as", "worker", "--yes"]);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).migrated, false, "re-running migration must not rewrite the existing store");
    assert.deepEqual(await fsp.readFile(stateFile), original);

    const jsonExport = await cli(dir, ["state", "export"], undefined);
    assert.equal(jsonExport.code, 0, `${jsonExport.stderr}\n${jsonExport.stdout}`);
    assert.deepEqual(JSON.parse(jsonExport.stdout), JSON.parse(firstExport));
    await assertBackendReadParity(dir);
  } finally {
    await rmTempProject(dir);
  }
});

test("state migrate refuses a changed or unverifiable backup instead of overwriting it", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, fixture());
    const stateFile = stateFilePath(dir);
    const original = await fsp.readFile(stateFile);
    const migrated = await cli(dir, ["state", "migrate", "--as", "worker", "--yes"]);
    assert.equal(migrated.code, 0, `${migrated.stderr}\n${migrated.stdout}`);

    await fsp.writeFile(backupPath(dir), "tampered backup");
    const result = await cli(dir, ["state", "migrate", "--as", "worker", "--yes"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /backup/i);
    assert.deepEqual(await fsp.readFile(stateFile), original);
  } finally {
    await rmTempProject(dir);
  }
});
