import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, jsonStateFilePath, rmTempProject, runCli, runCliSpawn } from "./helpers.ts";

type State = { version: number; revision: number; nodes: Record<string, any>; edges: unknown[]; initiatives: Record<string, unknown>; log: any[] };
const SQLITE_MODULE = "bun:sqlite";
const emptyState = (): State => ({ version: 1, revision: 0, nodes: {}, edges: [], initiatives: {}, log: [] });

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? sourceFiles(path.join(directory, entry.name))
    : [path.join(directory, entry.name)]));
  return nested.flat();
}

test("runtime source has no file-lock, lock capability, or generation-fence path", async () => {
  const sourceDir = new URL("../src/", import.meta.url);
  const files = await sourceFiles(sourceDir.pathname);
  for (const file of files.filter((filename) => filename.endsWith(".ts"))) {
    const source = await fs.readFile(file, "utf8");
    const mutationSource = file.endsWith(`${path.sep}storage${path.sep}state.ts`)
      ? source.replace(/export async function readJsonStateForMigration[\s\S]*?(?=\nasync function assertExplicitMigrationRequiredForFile)/, "")
      : source;
    assert.doesNotMatch(source, /\blockContext\b|withMutationBoundary/, file);
    assert.doesNotMatch(mutationSource, /fence_generation/, file);
  }
  await assert.rejects(fs.access(new URL("../src/storage/lock.ts", import.meta.url)), { code: "ENOENT" });
});

test("SQLite log append uses a database transaction without JSON sidecars", async () => {
  const projectDir = await createTempProject();
  try {
    const { readState, sqliteStateFile } = await import("../src/storage/state.ts");
    const { writeSqliteState } = await import("../src/storage/sqlite/store.ts");
    const node = { id: "T1", kind: "resolvable", subkind: "task", title: "one", status: "open", revision: 1 };
    await writeSqliteState(sqliteStateFile(projectDir), { ...emptyState(), revision: 1, nodes: { T1: node } });
    const result = await runCli(["add-note", "T1", "hello", "--as", "worker"], { cwd: projectDir });
    assert.equal(result.code, 0, result.stdout);
    const state = await readState(projectDir);
    assert.equal(state.revision, 2);
    assert.equal(state.log.length, 1);
    assert.equal(state.log[0].action, "add-note");
    assert.equal(state.log[0].agent, "worker");
    const jsonFile = jsonStateFilePath(projectDir);
    await assert.rejects(fs.access(jsonFile), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(path.dirname(jsonFile), "revision-ledger.json")), { code: "ENOENT" });
  } finally { await rmTempProject(projectDir); }
});

test("SQLite manual transfer replaces an existing database without JSON sidecars", async () => {
  const sourceDir = await createTempProject();
  const destinationDir = await createTempProject();
  try {
    const { sqliteStateFile } = await import("../src/storage/state.ts");
    const { readSqliteState, writeSqliteState } = await import("../src/storage/sqlite/store.ts");
    const { captureTransferSource, installTransferDestination } = await import("../src/storage/transfer.ts");
    const source = {
      ...emptyState(),
      revision: 3,
      initiatives: { core: { desc: "transfer", created_at: "2026-10-20T00:00:00.000Z" } },
      nodes: { "T-transfer": { id: "T-transfer", kind: "resolvable", subkind: "task", title: "Transferred", status: "open", initiative: "core", revision: 2 } },
    };
    await writeSqliteState(sqliteStateFile(sourceDir), source);
    await writeSqliteState(sqliteStateFile(destinationDir), { ...emptyState(), revision: 4 });
    const { payload, revision } = await captureTransferSource(sourceDir);
    assert.equal(revision, 3);
    await installTransferDestination(destinationDir, payload, { actor: "worker", direction: "pull", expectedRevision: 4 });
    const installed = await readSqliteState(sqliteStateFile(destinationDir));
    assert.equal(installed.revision, 5);
    assert.equal(installed.nodes["T-transfer"].revision, 5);
    assert.equal(installed.log.at(-1).action, "transfer.pull");
    for (const dir of [sourceDir, destinationDir]) {
      const jsonFile = jsonStateFilePath(dir);
      await assert.rejects(fs.access(jsonFile), { code: "ENOENT" });
      await assert.rejects(fs.access(path.join(path.dirname(jsonFile), "revision-ledger.json")), { code: "ENOENT" });
    }
  } finally {
    await rmTempProject(sourceDir);
    await rmTempProject(destinationDir);
  }
});

test("50 concurrent SQLite CLI mutations serialize on the database revision and retain every note", async () => {
  const projectDir = await createTempProject();
  try {
    const { readState, sqliteStateFile } = await import("../src/storage/state.ts");
    const { writeSqliteState } = await import("../src/storage/sqlite/store.ts");
    await writeSqliteState(sqliteStateFile(projectDir), {
      ...emptyState(),
      revision: 1,
      nodes: { "T-concurrent": { id: "T-concurrent", kind: "resolvable", subkind: "task", title: "concurrent", status: "open", initiative: "core", revision: 1 } },
      initiatives: { core: { desc: "concurrency", created_at: "2026-10-20T00:00:00.000Z" } },
    });
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => runCliSpawn([
      "--project", projectDir, "add-note", "T-concurrent", `note-${index}`, "--as", "worker",
    ])));
    assert.ok(results.every((result) => result.code === 0), results.map((result) => result.stdout).join("\n"));
    const state = await readState(projectDir);
    assert.deepEqual(state.nodes["T-concurrent"].notes.map(({ text }) => text).sort(), Array.from({ length: 50 }, (_, index) => `note-${index}`).sort());
    assert.equal(state.log.length, 50);
    assert.equal(state.revision, 51);
  } finally { await rmTempProject(projectDir); }
});

async function killDuringSqliteMutation(projectDir: string) {
  const dispatchUrl = new URL("../src/cli/dispatch.ts", import.meta.url).href;
  const script = `
    const { Database } = await import("bun:sqlite");
    const exec = Database.prototype.exec;
    Database.prototype.exec = function (sql, ...args) {
      if (String(sql).trim().toUpperCase() === "COMMIT") {
        process.stdout.write("STAGED\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      return exec.call(this, sql, ...args);
    };
    const { runCli } = await import(${JSON.stringify(dispatchUrl)});
    await runCli({
      argv: ["--project", process.env.CLIMIER_CRASH_PROJECT, "add-note", "T-crash", "uncommitted", "--as", "crash-agent"],
      write() {},
      exit(code) { process.exitCode = code; },
    });
  `;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      env: { ...process.env, CLIMIER_CRASH_PROJECT: projectDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`SQLite crash child did not reach the staged write: ${stdout} ${stderr}`));
    }, 10_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (!killed && stdout.includes("STAGED\n")) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (_code, signal) => {
      clearTimeout(timeout);
      if (!killed || signal !== "SIGKILL") { reject(new Error(`SQLite crash child exited unexpectedly: ${signal ?? "no signal"}; ${stdout} ${stderr}`)); }
      else { resolve(); }
    });
  });
}

test("20 SIGKILLs during SQLite mutations retain confirmed commits without partial state", async () => {
  const projectDir = await createTempProject();
  try {
    const { readState, sqliteStateFile } = await import("../src/storage/state.ts");
    const { writeSqliteState } = await import("../src/storage/sqlite/store.ts");
    const file = sqliteStateFile(projectDir);
    const initial = {
      ...emptyState(),
      revision: 1,
      nodes: { "T-crash": { id: "T-crash", kind: "resolvable", subkind: "task", title: "crash test", status: "open", initiative: "core", revision: 1 } },
      initiatives: { core: { desc: "crash test", created_at: "2026-10-20T00:00:00.000Z" } },
    };
    await writeSqliteState(file, initial);
    const { Database } = await import(SQLITE_MODULE);
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const confirmed = await runCli(["--project", projectDir, "add-note", "T-crash", `confirmed-${iteration}`, "--as", "worker"]);
      assert.equal(confirmed.code, 0, confirmed.stdout);
      const committed = await readState(projectDir);
      await killDuringSqliteMutation(projectDir);
      const actual = await readState(projectDir);
      assert.deepEqual(actual, committed, `partial state or lost confirmed commit after SIGKILL ${iteration + 1}`);
      const database = new Database(file);
      try { assert.equal(database.query("PRAGMA integrity_check").get().integrity_check, "ok"); }
      finally { database.close(); }
    }
    await fs.access(file);
    const jsonFile = jsonStateFilePath(projectDir);
    await assert.rejects(fs.access(jsonFile), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(path.dirname(jsonFile), "revision-ledger.json")), { code: "ENOENT" });
  } finally { await rmTempProject(projectDir); }
});
