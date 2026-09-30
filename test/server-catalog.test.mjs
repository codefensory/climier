import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProjectCatalog } from "../src/server/catalog/index.mjs";
import { withAuthorizedProject } from "../src/server/auth/project-scope.mjs";

async function makeRoot(t) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-catalog-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  return path.join(tempRoot, "data");
}

const authStore = Object.freeze({ async verifyBearer(token) { return token === "token-a"; } });

function withProject({ authorization = "Bearer token-a", projectId = "alpha", catalog, openProject, provision = false }) {
  return withAuthorizedProject({ authorization, projectId, authStore, catalog, openProject, provision });
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
