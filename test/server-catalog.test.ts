import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProjectCatalog } from "../src/server/catalog/index.ts";
import { createServerRuntime } from "../src/server/runtime.ts";
import { withAuthorizedProject } from "../src/server/auth/project-scope.ts";

async function makeRoot(t) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-catalog-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  return path.join(tempRoot, "data");
}

const authStore = Object.freeze({ async verifyBearer(token) { return token === "token-a"; } });

function withProject({ authorization = "Bearer token-a", projectId = "alpha", catalog, openProject, provision = false }: {
  authorization?: string | null;
  projectId?: string;
  catalog: ReturnType<typeof createProjectCatalog>;
  openProject: (projectDir: string, metadata?: { projectId?: string }) => Promise<{ projectDir: string; [key: string]: unknown } | void>;
  provision?: boolean;
}) {
  return withAuthorizedProject({
    authorization,
    projectId,
    authStore,
    catalog,
    openProject: openProject as (projectDir: string, metadata?: { projectId?: string }) => Promise<{ projectDir: string; [key: string]: unknown }>,
    provision,
  });
}

test("catalog confines generated storage and keeps distinct project IDs isolated", async (t) => {
  const dataRoot = await makeRoot(t);
  const catalog = createProjectCatalog({ dataRoot });
  const alpha = await catalog.provisionProject("alpha");
  const alphaOther = await catalog.provisionProject("alpha-other");

  assert.notEqual(alpha, alphaOther);
  assert.equal(path.dirname(alpha), dataRoot);
  assert.equal(path.dirname(alphaOther), dataRoot);
  assert.notEqual(path.basename(alpha), "alpha");
  await fs.writeFile(path.join(alpha, "tasks.json"), "alpha");
  await fs.writeFile(path.join(alphaOther, "tasks.json"), "alpha-other");
  assert.equal(await fs.readFile(path.join(alpha, "tasks.json"), "utf8"), "alpha");
  assert.equal(await fs.readFile(path.join(alphaOther, "tasks.json"), "utf8"), "alpha-other");
});

test("catalog keeps punctuation variants in separate generated directories", async (t) => {
  const dataRoot = await makeRoot(t);
  const projectIds = ["team-a", "team_a", "team.a"];
  const catalog = createProjectCatalog({ dataRoot });
  const storagePaths = await Promise.all(projectIds.map((projectId) => catalog.provisionProject(projectId)));

  assert.equal(new Set(storagePaths).size, projectIds.length);
  for (const storagePath of storagePaths) {
    assert.equal(path.dirname(storagePath), dataRoot);
  }
});

test("catalog treats traversal-shaped IDs as opaque keys without escaping the data root", async (t) => {
  const dataRoot = await makeRoot(t);
  const catalog = createProjectCatalog({ dataRoot });

  const storagePath = await catalog.provisionProject("../outside");
  assert.equal(path.dirname(storagePath), dataRoot);
  assert.notEqual(storagePath, path.resolve(dataRoot, "../outside"));
  await assert.rejects(fs.access(path.resolve(dataRoot, "..", "outside")));
});

test("unknown project IDs cannot open storage but init provisioning can create them", async (t) => {
  const dataRoot = await makeRoot(t);
  const catalog = createProjectCatalog({ dataRoot });
  let opened = false;

  await assert.rejects(
    withProject({
      projectId: "unknown",
      catalog,
      openProject: async () => { opened = true; },
    }),
    { code: "UNKNOWN_PROJECT" },
  );
  assert.equal(opened, false);
  await assert.rejects(fs.access(dataRoot));

  const created = await withProject({
    projectId: "unknown",
    catalog,
    provision: true,
    openProject: async (projectDir) => ({ projectDir }),
  });
  assert.equal(path.dirname(created.projectDir), dataRoot);
});

test("missing or invalid bearer token is rejected before catalog or storage access", async (t) => {
  const dataRoot = await makeRoot(t);
  const catalog = createProjectCatalog({ dataRoot });
  let opened = false;

  for (const authorization of [null, "Bearer wrong"]) {
    await assert.rejects(
      withProject({
        authorization,
        catalog,
        openProject: async () => { opened = true; },
      }),
      { code: authorization ? "AUTH_INVALID" : "AUTH_REQUIRED" },
    );
  }
  assert.equal(opened, false);
  await assert.rejects(fs.access(dataRoot));
});

test("catalog refuses a provisioned storage path replaced by a symlink", async (t) => {
  const dataRoot = await makeRoot(t);
  const catalog = createProjectCatalog({ dataRoot });
  const storageDir = await catalog.provisionProject("alpha");
  const outside = path.join(path.dirname(dataRoot), "outside");
  await fs.mkdir(outside);
  await fs.rm(storageDir, { recursive: true, force: true });
  await fs.symlink(outside, storageDir, "dir");
  let opened = false;

  await assert.rejects(
    withProject({
      catalog,
      openProject: async () => { opened = true; },
    }),
    { code: "UNSAFE_PROJECT_STORAGE" },
  );
  assert.equal(opened, false);
});

test("provisionProject writes the source project ID and optional name to catalog metadata", async (t) => {
  const dataRoot = await makeRoot(t);
  const catalog = createProjectCatalog({ dataRoot });
  const projectDir = await catalog.provisionProject("alpha", { name: "Alpha" });

  assert.deepEqual(JSON.parse(await fs.readFile(path.join(projectDir, ".climier.json"), "utf8")), {
    version: 1,
    project_id: path.basename(projectDir),
    source_project_id: "alpha",
    name: "Alpha",
  });
});

test("listProjects returns only real directories with valid indexed metadata", async (t) => {
  const dataRoot = await makeRoot(t);
  const catalog = createProjectCatalog({ dataRoot });
  const alphaDir = await catalog.provisionProject("alpha");
  await catalog.provisionProject("beta");

  await fs.mkdir(path.join(dataRoot, "unindexed"));
  await fs.writeFile(path.join(dataRoot, "unindexed", ".climier.json"), JSON.stringify({
    version: 1,
    project_id: "unindexed",
  }));
  await fs.mkdir(path.join(dataRoot, "not-a-directory-file"));
  await fs.writeFile(path.join(dataRoot, "not-a-directory-file", ".climier.json"), "not json");

  const projects = await catalog.listProjects();
  assert.deepEqual(projects.map(({ source_project_id: sourceId }) => sourceId), ["alpha", "beta"]);
  assert.equal(projects[0].projectDir, alphaDir);
  assert.equal(projects[0].name, null);
});

test("openProject upgrades legacy catalog metadata once and preserves it on repeated opens", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-catalog-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const runtime = createServerRuntime({
    listen: { host: "127.0.0.1", port: 0 },
    dataRoot,
    stateHome: path.join(root, "state-home"),
  });
  const projectDir = await runtime.catalog.provisionProject("legacy");
  const metadataFile = path.join(projectDir, ".climier.json");
  await fs.writeFile(metadataFile, JSON.stringify({ version: 1, project_id: path.basename(projectDir) }));

  await runtime.openProject(projectDir, { projectId: "legacy" });
  const upgraded = await fs.readFile(metadataFile, "utf8");
  assert.deepEqual(JSON.parse(upgraded), {
    version: 1,
    project_id: path.basename(projectDir),
    source_project_id: "legacy",
  });

  await runtime.openProject(projectDir, { projectId: "legacy" });
  assert.equal(await fs.readFile(metadataFile, "utf8"), upgraded);
});

test("catalog provisions and renames a project's display name", async (t) => {
  const dataRoot = await makeRoot(t);
  const catalog = createProjectCatalog({ dataRoot });

  await catalog.provisionProject("alpha", { name: "  Alpha   One  " });
  assert.equal((await catalog.listProjects())[0].name, "Alpha One");

  await catalog.setProjectName("alpha", "Alpha Renamed");
  assert.equal((await catalog.listProjects())[0].name, "Alpha Renamed");

  await assert.rejects(catalog.setProjectName("missing", "Nope"), (error: { code?: string }) => error.code === "UNKNOWN_PROJECT");
  await assert.rejects(catalog.setProjectName("alpha", "   "), (error: { code?: string }) => error.code === "INVALID_PROJECT_NAME");
  await assert.rejects(catalog.provisionProject("beta", { name: "x".repeat(121) }), (error: { code?: string }) => error.code === "INVALID_PROJECT_NAME");
});
