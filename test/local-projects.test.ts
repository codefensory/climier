import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initState } from "../src/kernel/state-operations.ts";
import { listProjectIds, readStateByProjectId } from "../src/storage/state.ts";

type ProjectState = { version: number; revision: number; nodes: Record<string, unknown> };

async function makeHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-local-projects-"));
  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  });
  return home;
}

async function makeProject(home, projectId) {
  const root = path.join(home, "roots", projectId);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, ".climier.json"), `${JSON.stringify({ version: 1, project_id: projectId })}\n`);
  await initState({ projectDir: root });
  return root;
}

test("readStateByProjectId reads a canonical state without a project root", async (t) => {
  const home = await makeHome(t);
  await makeProject(home, "proj-a");

  const state = await readStateByProjectId("proj-a") as ProjectState;
  assert.equal(state.version, 1);
  assert.equal(state.revision, 1);
  assert.deepEqual(state.nodes, {});
  assert.equal(await fs.access(path.join(home, "projects", "proj-a", "state.sqlite")).then(() => true), true);
});

test("readStateByProjectId returns null for an unknown id without creating the project", async (t) => {
  const home = await makeHome(t);

  assert.equal(await readStateByProjectId("missing"), null);
  await assert.rejects(fs.access(path.join(home, "projects", "missing")));
});

test("listProjectIds lists projects with SQLite state and skips other storage dirs", async (t) => {
  const home = await makeHome(t);
  await makeProject(home, "proj-b");
  await makeProject(home, "proj-a");
  await fs.mkdir(path.join(home, "projects", "stray"), { recursive: true });
  await fs.writeFile(path.join(home, "projects", "stray", "notes.txt"), "x");
  await fs.mkdir(path.join(home, "projects", "json-only"), { recursive: true });
  await fs.writeFile(path.join(home, "projects", "json-only", "tasks.json"), "{}\n");

  assert.deepEqual(await listProjectIds(), ["proj-a", "proj-b"]);
});

test("listProjectIds is empty when the projects root does not exist", async (t) => {
  const home = await makeHome(t);
  assert.deepEqual(await listProjectIds(), []);
  await fs.access(home);
});

test("readStateByProjectId rejects a tasks.json-only project with migration guidance", async (t) => {
  const home = await makeHome(t);
  const dir = path.join(home, "projects", "legacy");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "tasks.json"), `${JSON.stringify({ version: 3, nodes: {}, edges: [], initiatives: {}, log: [] })}\n`);

  await assert.rejects(
    readStateByProjectId("legacy"),
    (error) => typeof error === "object" && error !== null && "code" in error && error.code === "CLIMIER_SQLITE_MIGRATION_REQUIRED" && "message" in error && typeof error.message === "string" && /climier state migrate/.test(error.message),
  );
});
