import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, runCli, runCliSpawn, writeCanonicalState } from "./helpers.ts";

type State = Record<string, unknown> & { version: number; fence_generation: number; revision: number; nodes: Record<string, unknown>; edges: unknown[]; initiatives: Record<string, unknown>; log: unknown[] };
const emptyState = (): State => ({ version: 1, fence_generation: 1, revision: 0, nodes: {}, edges: [], initiatives: {}, log: [] });

async function withBackend<T>(backend: string, operation: () => Promise<T>): Promise<T> {
  const previous = process.env.CLIMIER_STATE_BACKEND;
  process.env.CLIMIER_STATE_BACKEND = backend;
  try { return await operation(); }
  finally {
    if (previous === undefined) { delete process.env.CLIMIER_STATE_BACKEND; }
    else { process.env.CLIMIER_STATE_BACKEND = previous; }
  }
}

function withoutTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map(withoutTimestamps); }
  if (!value || typeof value !== "object") { return value; }
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "ts").map(([key, child]) => [key, withoutTimestamps(child)]));
}

async function exportedState(projectDir: string, backend: string) {
  const result = await runCli(["--project", projectDir, "state", "export"], { env: { CLIMIER_STATE_BACKEND: backend } });
  assert.equal(result.code, 0, result.stdout);
  return JSON.parse(result.stdout);
}

test("SQLite and JSON mutations produce equivalent final canonical state", async () => {
  const jsonDir = await createTempProject();
  const sqliteDir = await createTempProject();
  try {
    const seeded = await writeCanonicalState(jsonDir, {
      ...emptyState(),
      initiatives: { core: { desc: "parity", created_at: "2026-10-20T00:00:00.000Z" } },
      nodes: { "T-parity": { id: "T-parity", kind: "resolvable", subkind: "task", title: "Before", status: "open", initiative: "core", revision: 1 } },
    });
    const { writeState } = await import("../src/storage/state.ts");
    await withBackend("sqlite", () => writeState(sqliteDir, seeded));

    for (const dir of [jsonDir, sqliteDir]) {
      const update = await runCli(["--project", dir, "update", "T-parity", "--title", "After", "--as", "worker"], {
        env: { CLIMIER_STATE_BACKEND: dir === sqliteDir ? "sqlite" : "json" },
      });
      assert.equal(update.code, 0, update.stdout);
      const note = await runCli(["--project", dir, "add-note", "T-parity", "consistent note", "--as", "worker"], {
        env: { CLIMIER_STATE_BACKEND: dir === sqliteDir ? "sqlite" : "json" },
      });
      assert.equal(note.code, 0, note.stdout);
    }

    assert.deepEqual(withoutTimestamps(await exportedState(sqliteDir, "sqlite")), withoutTimestamps(await exportedState(jsonDir, "json")));
  } finally {
    await rmTempProject(sqliteDir);
    await rmTempProject(jsonDir);
  }
});

test("SQLite log append uses the database transaction without creating JSON sidecars", async () => {
  const projectDir = await createTempProject();
  try {
    const { readState, sqliteStateFile, stateFile } = await import("../src/storage/state.ts");
    const { writeSqliteState } = await import("../src/storage/sqlite/store.ts");
    const { append } = await import("../src/storage/log.ts");
    await withBackend("sqlite", async () => {
      await writeSqliteState(sqliteStateFile(projectDir), { ...emptyState(), revision: 1 });
      await append(projectDir, { action: "manual", agent: "worker" });
      const state = await readState(projectDir);
      assert.equal(state.revision, 2);
      assert.equal(state.log.length, 1);
      assert.equal(state.log[0].action, "manual");
    });
    const jsonFile = stateFile(projectDir);
    await assert.rejects(fs.access(jsonFile), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(path.dirname(jsonFile), "revision-ledger.json")), { code: "ENOENT" });
  } finally {
    await rmTempProject(projectDir);
  }
});

test("SQLite manual transfer replaces an existing database without JSON ledger sidecars", async () => {
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
    const destination = { ...emptyState(), revision: 4 };
    await withBackend("sqlite", async () => {
      await writeSqliteState(sqliteStateFile(sourceDir), source);
      await writeSqliteState(sqliteStateFile(destinationDir), destination);
      const { payload, revision } = await captureTransferSource(sourceDir);
      assert.equal(revision, 3);
      await installTransferDestination(destinationDir, payload, { actor: "worker", direction: "pull", expectedRevision: 4 });
      const installed = await readSqliteState(sqliteStateFile(destinationDir));
      assert.equal(installed.revision, 5);
      assert.equal(installed.nodes["T-transfer"].revision, 5);
      assert.equal(installed.log.at(-1).action, "transfer.pull");
    });
    for (const dir of [sourceDir, destinationDir]) {
      const jsonFile = (await import("../src/storage/state.ts")).stateFile(dir);
      await assert.rejects(fs.access(jsonFile), { code: "ENOENT" });
      await assert.rejects(fs.access(path.join(path.dirname(jsonFile), "revision-ledger.json")), { code: "ENOENT" });
    }
  } finally {
    await rmTempProject(sourceDir);
    await rmTempProject(destinationDir);
  }
});

test("concurrent SQLite CLI mutations serialize on the database revision and retain every note", async () => {
  const projectDir = await createTempProject();
  try {
    const { readState, sqliteStateFile } = await import("../src/storage/state.ts");
    const { writeSqliteState } = await import("../src/storage/sqlite/store.ts");
    await withBackend("sqlite", () => writeSqliteState(sqliteStateFile(projectDir), {
      ...emptyState(),
      revision: 1,
      nodes: { "T-concurrent": { id: "T-concurrent", kind: "resolvable", subkind: "task", title: "concurrent", status: "open", initiative: "core", revision: 1 } },
      initiatives: { core: { desc: "concurrency", created_at: "2026-10-20T00:00:00.000Z" } },
    }));

    const results = await withBackend("sqlite", () => Promise.all(Array.from({ length: 8 }, (_, index) => runCliSpawn([
      "--project", projectDir, "add-note", "T-concurrent", `note-${index}`, "--as", "worker",
    ]))));
    assert.ok(results.every((result) => result.code === 0), results.map((result) => result.stdout).join("\\n"));
    const state = await withBackend("sqlite", () => readState(projectDir));
    assert.deepEqual(state.nodes["T-concurrent"].notes.map(({ text }) => text).sort(), Array.from({ length: 8 }, (_, index) => `note-${index}`).sort());
    assert.equal(state.log.length, 8);
    assert.equal(state.revision, 9);
  } finally {
    await rmTempProject(projectDir);
  }
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
      env: { ...process.env, CLIMIER_STATE_BACKEND: "sqlite", CLIMIER_CRASH_PROJECT: projectDir },
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
    const { readState, sqliteStateFile, stateFile } = await import("../src/storage/state.ts");
    const { writeSqliteState } = await import("../src/storage/sqlite/store.ts");
    const file = sqliteStateFile(projectDir);
    const initial = {
      ...emptyState(),
      revision: 1,
      nodes: { "T-crash": { id: "T-crash", kind: "resolvable", subkind: "task", title: "crash test", status: "open", initiative: "core", revision: 1 } },
      initiatives: { core: { desc: "crash test", created_at: "2026-10-20T00:00:00.000Z" } },
    };
    await withBackend("sqlite", () => writeSqliteState(file, initial));

    for (let iteration = 0; iteration < 20; iteration += 1) {
      const confirmed = await runCli(["--project", projectDir, "add-note", "T-crash", `confirmed-${iteration}`, "--as", "worker"], {
        env: { CLIMIER_STATE_BACKEND: "sqlite" },
      });
      assert.equal(confirmed.code, 0, confirmed.stdout);
      const committed = await withBackend("sqlite", () => readState(projectDir));
      await killDuringSqliteMutation(projectDir);
      const actual = await withBackend("sqlite", () => readState(projectDir));
      assert.deepEqual(actual, committed, `state changed partially or lost a confirmed commit after SIGKILL ${iteration + 1}`);
    }
    await fs.access(file);
    const jsonFile = stateFile(projectDir);
    await assert.rejects(fs.access(jsonFile), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(path.dirname(jsonFile), "revision-ledger.json")), { code: "ENOENT" });
  } finally {
    await rmTempProject(projectDir);
  }
});
