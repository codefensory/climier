import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stateFile } from "../src/storage/state.ts";
import { ledgerFile } from "../src/storage/ledger.ts";
import { createTempProject, rmTempProject, runCli } from "./helpers.ts";

type LegacyState = { version: number; fence_generation?: number; revision: number; nodes: Record<string, Record<string, unknown>>; edges: unknown[]; initiatives: Record<string, unknown>; log: unknown[] };
type Ledger = { bootstrap_pending: unknown; high_water_revision: number; [key: string]: unknown };

function currentHome(): string {
  const home = process.env.CLIMIER_HOME;
  if (!home) throw new Error("migrate-old-forms: CLIMIER_HOME is required");
  return home;
}

const repoRoot = path.resolve(import.meta.dirname, "..");

const privateHomes = new WeakMap();

// `migrate --all` sweeps every project under CLIMIER_HOME. In-process shards
// share one home, so this file must never see another file's projects (or
// their stale locks, which would burn the 10s lock timeout per sweep). Give
// each test its own home and restore it when the test finishes.
async function ensurePrivateHome(t) {
  if (privateHomes.has(t)) {return privateHomes.get(t);}
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-olds-home-"));
  privateHomes.set(t, home);
  const previous = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = home;
  t.after(async () => {
    if (previous === undefined) {delete process.env.CLIMIER_HOME;}
    else {process.env.CLIMIER_HOME = previous;}
    await fs.rm(home, { recursive: true, force: true });
  });
  return home;
}

async function createLegacyProject(t, { version = 4, preRelease = false, id }: { version?: number; preRelease?: boolean; id?: string } = {}) {
  await ensurePrivateHome(t);
  const projectDir = await createTempProject();
  t.after(() => rmTempProject(projectDir));
  const projectId = id || `old-forms-${path.basename(projectDir)}`;
  await fs.writeFile(path.join(projectDir, ".climier.json"), JSON.stringify({ version: 1, project_id: projectId }));
  const statePath = stateFile(projectDir);
  const ledgerPath = ledgerFile(projectDir);
  const tempHome = path.resolve(currentHome());
  assert.ok(path.resolve(statePath).startsWith(`${tempHome}${path.sep}`), `state outside temp CLIMIER_HOME: ${statePath}`);
  assert.ok(path.resolve(ledgerPath).startsWith(`${tempHome}${path.sep}`), `ledger outside temp CLIMIER_HOME: ${ledgerPath}`);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const source = preRelease ? {
    version: 1,
    tasks: [],
    decisions: [],
    gotchas: [],
  } : {
    version,
    nodes: {
      T1: { id: "T1", kind: "resolvable", subkind: "task", title: "Legacy task", status: "open" },
      G1: { id: "G1", kind: "resolvable", subkind: "gate", title: "Legacy gate", status: "open" },
    },
    edges: [],
    initiatives: {},
    log: [{ action: "seed", agent: "test" }],
    revision: 6,
  };
  await fs.writeFile(statePath, `${JSON.stringify(source, null, 2)}\n`);
  return { projectDir, projectId, statePath, ledgerPath, source };
}

async function runMigrate(projectDir, args = []) {
  return runCli(["--project", projectDir, "migrate", ...args], { env: { CLIMIER_HOME: process.env.CLIMIER_HOME } });
}

test("legacy v2, v3, and v4 imports normalize gates and create the initial fence", async (t) => {
  for (const version of [2, 3, 4]) {
    const fixture = await createLegacyProject(t, { version });
    const result = await runMigrate(fixture.projectDir);
    assert.equal(result.code, 0, result.stdout);
    const state = JSON.parse(await fs.readFile(fixture.statePath, "utf8")) as LegacyState;
    const ledger = JSON.parse(await fs.readFile(fixture.ledgerPath, "utf8")) as Ledger;
    assert.equal(state.version, 1);
    assert.equal(state.fence_generation, 1);
    assert.ok(state.revision >= 7, `version ${version} imported revision ${state.revision}`);
    assert.equal(state.nodes.G1.resolution_mode, "choice");
    assert.equal(state.nodes.T1.resolution_mode, undefined);
    assert.equal(ledger.bootstrap_pending, null);
    assert.equal(ledger.high_water_revision, state.revision);
    assert.equal(Object.keys(state.nodes).length, 2);
  }
});

test("prehistoric import writes a canonical empty state readable by status", async (t) => {
  const fixture = await createLegacyProject(t, { preRelease: true });
  const result = await runMigrate(fixture.projectDir);
  assert.equal(result.code, 0, result.stdout);
  const state = JSON.parse(await fs.readFile(fixture.statePath, "utf8")) as LegacyState;
  assert.deepEqual(state.nodes, {});
  assert.deepEqual(state.edges, []);
  assert.deepEqual(state.initiatives, {});
  assert.deepEqual(state.log, []);
  assert.equal(state.version, 1);
  assert.ok(state.fence_generation);
  const status = await runCli(["--project", fixture.projectDir, "status"], { env: { CLIMIER_HOME: process.env.CLIMIER_HOME } });
  assert.equal(status.code, 0, status.stdout);
});

test("legacy migration backs up source and reports old migration_pending while continuing sweep", async (t) => {
  const old = await createLegacyProject(t, { version: 4 });
  const next = await createLegacyProject(t, { version: 3 });
  const oldLedger = JSON.stringify({
    version: 1, fence_generation: 1, high_water_revision: 7,
    migration_pending: { source_sha256: "old", destination_sha256: "old", source_version: 4,
      source_high_water_revision: 6, fence_revision: 7, fence_generation: 1 },
  }, null, 2);
  await fs.writeFile(old.ledgerPath, oldLedger);
  // `migrate --all` rejects --project, so it resolves the project root from
  // cwd. Run from a neutral directory so the checkout's own remote-linked
  // .climier.json cannot veto the sweep with REMOTE_UNSUPPORTED_OPERATION.
  const neutralCwd = await createTempProject();
  t.after(() => rmTempProject(neutralCwd));
  const result = await runCli(["migrate", "--all"], { cwd: neutralCwd, env: { CLIMIER_HOME: process.env.CLIMIER_HOME } });
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stdout, new RegExp(old.projectId));
  assert.equal(await fs.readFile(old.statePath, "utf8"), `${JSON.stringify(old.source, null, 2)}\n`);
  assert.equal(JSON.parse(await fs.readFile(next.statePath, "utf8")).version, 1, "sweep continues after the named old pending");
  const backupsRoot = path.join(currentHome(), "backups", next.projectId);
  const backups = await fs.readdir(backupsRoot);
  assert.ok(backups.length > 0);
  assert.ok(await fs.stat(path.join(backupsRoot, backups[0], "tasks.json")));
});

const crashPoints = ["before-pending", "after-pending", "before-state-replace", "after-state-replace"];

test("SIGKILL at each bootstrap publication boundary resumes to a readable consistent state", async (t) => {
  for (const checkpoint of crashPoints) {
    const fixture = await createLegacyProject(t, { version: 4 });
    const childCode = `
      import { withProjectIdLock } from ${JSON.stringify(path.join(repoRoot, "src/storage/lock.ts"))};
      import { migrateProjectUnderLock } from ${JSON.stringify(path.join(repoRoot, "src/storage/migrate.ts"))};
      const id = ${JSON.stringify(fixture.projectId)};
      await withProjectIdLock(id, (lock) => migrateProjectUnderLock(lock, id, {
        onCheckpoint: async (point) => { if (point === ${JSON.stringify(checkpoint)}) { process.stdout.write("CHECKPOINT\\n"); await new Promise(() => {}); } },
      }));
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
      cwd: repoRoot,
      env: { ...process.env, CLIMIER_HOME: process.env.CLIMIER_HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child did not reach ${checkpoint}; output=${stdout}`)), 10_000);
      child.stdout.on("data", () => {
        if (stdout.includes("CHECKPOINT")) { clearTimeout(timer); resolve(); }
      });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`child exited before ${checkpoint}: ${code} ${stdout}`)); });
      t.after(() => clearTimeout(timer));
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // SIGKILL intentionally leaves the documented file lock behind; clear only

    await fs.rm(path.join(currentHome(), "projects", fixture.projectId, ".lock"), { force: true });
    const resumed = await runMigrate(fixture.projectDir);
    assert.equal(resumed.code, 0, `${checkpoint}: ${resumed.stdout}`);
    const state = JSON.parse(await fs.readFile(fixture.statePath, "utf8")) as LegacyState;
    const ledger = JSON.parse(await fs.readFile(fixture.ledgerPath, "utf8")) as Ledger;
    assert.equal(state.version, 1);
    assert.equal(ledger.high_water_revision, state.revision);
    assert.equal(ledger.bootstrap_pending, null);
    assert.equal((await runCli(["--project", fixture.projectDir, "status"], { env: { CLIMIER_HOME: process.env.CLIMIER_HOME } })).code, 0);
    const backups = await fs.readdir(path.join(currentHome(), "backups", fixture.projectId));
    assert.ok(backups.length > 0);
    const backupDir = path.join(currentHome(), "backups", fixture.projectId, backups[0]);
    assert.ok(await fs.stat(path.join(backupDir, "tasks.json")));
    assert.ok(await fs.stat(path.join(backupDir, "revision-ledger.json")));
    if (["after-pending", "before-state-replace"].includes(checkpoint)) {
      assert.ok((await fs.readdir(backupDir)).some((name) => name.startsWith(".bootstrap-stage-") || name === "revision-ledger.json"));
    }
  }
});

// --- boundary: the reader refuses exactly what migrate imports ---------------

test("boundary: the reader refuses the legacy bytes that migrate then imports in place", async (t) => {
  for (const version of [2, 3, 4]) {
    const { projectDir, statePath } = await createLegacyProject(t, { version });
    const before = await fs.readFile(statePath);

    const refused = await runCli(["--project", projectDir, "status"], { env: { CLIMIER_HOME: process.env.CLIMIER_HOME } });
    assert.notEqual(refused.code, 0, `status must refuse a legacy version ${version} state`);
    const error = JSON.parse(refused.stdout).error;
    assert.equal(error.code, "STORAGE_ERROR", `version ${version} must be refused as a storage error`);
    assert.equal(error.details.cause, "CLIMIER_INCOMPATIBLE_VERSION", `version ${version} must be refused as incompatible`);
    assert.match(error.message, /climier migrate/, `version ${version} refusal must point at the importer`);
    assert.deepEqual(await fs.readFile(statePath), before, `the refused read must leave the version ${version} bytes untouched`);

    const migrated = await runMigrate(projectDir);
    assert.equal(migrated.code, 0, `migrate must import version ${version}: ${migrated.stderr}`);

    const imported = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(imported.version, 1, `migrate must land on the canonical version for source ${version}`);
    assert.ok(Number.isInteger(imported.fence_generation), `source ${version} must carry a fence after import`);
    assert.ok(imported.nodes.T1, `source ${version} must keep its nodes`);

    const readable = await runCli(["--project", projectDir, "status"], { env: { CLIMIER_HOME: process.env.CLIMIER_HOME } });
    assert.equal(readable.code, 0, `the imported state must be readable: ${readable.stderr}`);
  }
});

test("boundary: a fenced legacy marker is refused and migrate adopts it without touching the bytes first", async (t) => {
  const projectDir = await createTempProject();
  t.after(() => rmTempProject(projectDir));
  const projectId = `fenced-boundary-${path.basename(projectDir)}`;
  await fs.writeFile(path.join(projectDir, ".climier.json"), JSON.stringify({ version: 1, project_id: projectId }));
  const created = await runCli(["--project", projectDir, "init"], { env: { CLIMIER_HOME: process.env.CLIMIER_HOME } });
  assert.equal(created.code, 0, created.stderr);

  const statePath = stateFile(projectDir);
  const ledger = JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8"));
  const canonical = JSON.parse(await fs.readFile(statePath, "utf8"));
  await fs.writeFile(statePath, `${JSON.stringify({ ...canonical, version: 5, fence_generation: ledger.fence_generation }, null, 2)}\n`);
  const before = await fs.readFile(statePath);

  const refused = await runCli(["--project", projectDir, "status"], { env: { CLIMIER_HOME: process.env.CLIMIER_HOME } });
  assert.notEqual(refused.code, 0, "status must refuse a fenced legacy marker");
  const fencedError = JSON.parse(refused.stdout).error;
  assert.equal(fencedError.details.cause, "CLIMIER_INCOMPATIBLE_VERSION", fencedError.message);
  assert.deepEqual(await fs.readFile(statePath), before, "the refused read must leave the fenced bytes untouched");

  const migrated = await runMigrate(projectDir);
  assert.equal(migrated.code, 0, migrated.stderr);
  const imported = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(imported.version, 1);

  const readable = await runCli(["--project", projectDir, "status"], { env: { CLIMIER_HOME: process.env.CLIMIER_HOME } });
  assert.equal(readable.code, 0, readable.stderr);
});
