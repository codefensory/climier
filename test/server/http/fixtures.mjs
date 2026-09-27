import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initState } from "../../../src/kernel/state-operations.mjs";
import { createProjectCatalog } from "../../../src/server/catalog/index.mjs";
import { createRemoteApiServer } from "../../../src/server/http.mjs";

export async function withApi(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-http-"));
  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = path.join(root, "home");
  const projectIds = ["project-a", "project-b"];
  const catalog = createProjectCatalog({ dataRoot: path.join(root, "catalog"), projectIds });
  const projectDirs = await Promise.all(projectIds.map((id) => catalog.provisionProject(id)));
  for (const projectDir of projectDirs) await initState({ projectDir });
  let openCount = 0;
  const server = createRemoteApiServer({
    catalog,
    credentials: [{ token: "test-token", projectIds }],
    async openProject(storagePath, metadata) {
      openCount += 1;
      assert.equal(typeof metadata.projectId, "string");
      return { projectDir: storagePath };
    },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({ baseUrl, openCount: () => openCount, projectDirs });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function withInitApi(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-init-http-"));
  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = path.join(root, "home");
  const dataRoot = path.join(root, "catalog");
  const catalog = createProjectCatalog({ dataRoot, projectIds: ["catalogued"] });
  let openCount = 0;
  const server = createRemoteApiServer({
    catalog,
    credentials: [{ token: "test-token", projectIds: ["catalogued", "unknown"] }],
    async openProject(projectDir) {
      openCount += 1;
      return { projectDir };
    },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({ baseUrl, dataRoot, openCount: () => openCount });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

export function authHeaders(extra = {}) {
  return {
    authorization: "Bearer test-token",
    "x-climier-protocol-version": "1",
    ...extra,
  };
}

export async function operation(baseUrl, projectId, operation, input, actor = "alice") {
  return fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/operations`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ operation, input, actor }),
  });
}
