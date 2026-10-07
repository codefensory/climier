import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withLock, withProjectIdLock } from "../src/storage/lock.ts";
import { runCli } from "./helpers.ts";

async function makeHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-migrate-home-"));
  await fs.mkdir(path.join(home, "projects"), { recursive: true });
  return home;
}

async function putState(home, id, value) {
  const directory = path.join(home, "projects", id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "tasks.json"), typeof value === "string" ? value : JSON.stringify(value));
  return path.join(directory, "tasks.json");
}

test("migrate --all --dry-run reports the four on-disk forms without changing bytes", async (t) => {
  const home = await makeHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const states: Array<[string, Record<string, unknown>]> = [
    ["pre", { version: 1, tasks: {}, decisions: {}, gotchas: {} }],
    ["legacy-2", { version: 2, nodes: { a: {} }, edges: [], initiatives: {}, log: [{}] }],
    ["legacy-3", { version: 3, nodes: {}, edges: [], initiatives: {}, log: [] }],
    ["legacy-4", { version: 4, nodes: { a: {}, b: {} }, edges: [], initiatives: {}, log: [{}, {}] }],
    ["fenced", { version: 5, nodes: { a: {}, b: {} }, edges: [], initiatives: {}, log: [{}, {}] }],
    ["canonical", { version: 1, fence_generation: 1, nodes: { a: {} }, edges: [], initiatives: {}, log: [] }],
  ];
  const before = new Map<string, Buffer>();
  for (const [id, value] of states) {
    const file = await putState(home, id, value);
    if (["fenced", "canonical"].includes(id)) {
      await fs.writeFile(path.join(path.dirname(file), "revision-ledger.json"), "{}\n");
    }
    before.set(file, await fs.readFile(file));
  }
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "climier-migrate-project-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const result = await runCli(["--project", project, "migrate", "--all", "--dry-run"], { env: { CLIMIER_HOME: home } });
  assert.equal(result.code, 0, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.projects.map(({ project_id, form }) => [project_id, form]), [
    ["canonical", "canonical"], ["fenced", "fenced-legacy"],
    ["legacy-2", "legacy-v2"], ["legacy-3", "legacy-v3"], ["legacy-4", "legacy-v4"], ["pre", "pre-release"],
  ]);
  assert.deepEqual(report.projects.map(({ project_id, nodes, log_entries }) => [project_id, nodes, log_entries]), [
    ["canonical", 1, 0], ["fenced", 2, 2], ["legacy-2", 1, 1], ["legacy-3", 0, 0],
    ["legacy-4", 2, 2], ["pre", 0, 0],
  ]);
  for (const [file, bytes] of before) assert.deepEqual(await fs.readFile(file), bytes);
});

test("migrate --all reports corrupt projects and continues with failure exit", async (t) => {
  const home = await makeHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await putState(home, "broken", "{");
  await putState(home, "valid", { version: 4, nodes: {}, edges: [], initiatives: {}, log: [] });
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "climier-migrate-project-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const result = await runCli(["--project", project, "migrate", "--all", "--dry-run"], { env: { CLIMIER_HOME: home } });
  assert.equal(result.code, 1);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.match(envelope.error.message, /broken/);
  assert.ok(envelope.error.details.projects.some(({ project_id }) => project_id === "valid"));
  assert.ok(envelope.error.details.projects.some(({ project_id, error }) => project_id === "broken" && error));
});

test("migrate rejects --as", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "climier-migrate-project-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const result = await runCli(["--project", project, "migrate", "--dry-run", "--as", "worker"]);
  assert.notEqual(result.code, 0);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.error.code, "CLI_USAGE_ERROR");
  assert.match(envelope.error.message, /unknown flag --as/);
});

test("project-id lock contends with the writer lock for the same storage project", async (t) => {
  const home = await makeHome();
  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
    return fs.rm(home, { recursive: true, force: true });
  });
  const projectId = "shared-project";
  let releaseWriter;
  const writerReady = new Promise((resolve) => { releaseWriter = resolve; });
  let writerRelease;
  const writerGate = new Promise((resolve) => { writerRelease = resolve; });
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "climier-migrate-project-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.writeFile(path.join(project, ".climier.json"), JSON.stringify({ version: 1, project_id: projectId }));
  const writer = withLock(project, async () => { releaseWriter(); await writerGate; });
  await writerReady;
  let acquired = false;
  const migrateLock = withProjectIdLock(projectId, async () => { acquired = true; }, { timeoutMs: 1000, retryEveryMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(acquired, false);
  writerRelease();
  await Promise.all([writer, migrateLock]);
  assert.equal(acquired, true);
  assert.equal(await fs.access(path.join(home, "projects", projectId, ".lock")).then(() => true, () => false), false);
});
