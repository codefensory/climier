import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRemoteApiServer } from "../src/server/http.mjs";
import { createProjectCatalog } from "../src/server/catalog/index.mjs";
import { initState } from "../src/kernel/state-operations.mjs";
import "./helpers.mjs";

async function withApi(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-http-"));
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
    await run({ baseUrl, openCount: () => openCount });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}

function authHeaders(extra = {}) {
  return {
    authorization: "Bearer test-token",
    "x-climier-protocol-version": "1",
    ...extra,
  };
}

async function operation(baseUrl, projectId, operation, input, actor = "alice") {
  return fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/operations`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ operation, input, actor }),
  });
}

test("HTTP v1 rejects protocol mismatches before opening a project", async () => {
  await withApi(async ({ baseUrl, openCount }) => {
    const response = await fetch(`${baseUrl}/v1/projects/project-a/read/status`, {
      headers: { authorization: "Bearer test-token", "x-climier-protocol-version": "2" },
    });
    assert.equal(response.status, 426);
    assert.equal(response.headers.get("x-climier-protocol-version"), "1");
    assert.deepEqual(await response.json(), {
      ok: false,
      error: {
        code: "PROTOCOL_VERSION_UNSUPPORTED",
        message: "server http: protocol version '2' is not supported; expected '1'",
        details: { expected: "1", received: "2" },
      },
    });
    assert.equal(openCount(), 0);
  });
});

test("HTTP v1 delegates core operations and read projections through server boundaries", async () => {
  await withApi(async ({ baseUrl }) => {
    const createdInitiative = await operation(baseUrl, "project-a", "initiative.create", {
      name: "remote",
      desc: "Created by the server kernel",
    });
    assert.equal(createdInitiative.status, 200, JSON.stringify(await createdInitiative.clone().json()));
    assert.equal((await createdInitiative.json()).result.result.name, "remote");

    const createdTask = await operation(baseUrl, "project-a", "task.create", {
      id: "T-remote-1",
      initiative: "remote",
      title: "Remote task",
      body: "Created through Application Operations",
      acceptance: "Visible in the read model",
    });
    assert.equal(createdTask.status, 200);

    const status = await fetch(`${baseUrl}/v1/projects/project-a/read/status`, { headers: authHeaders() });
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.result.revision, 2);
    assert.deepEqual(statusBody.result.derived.ready, ["T-remote-1"]);

    const node = await fetch(`${baseUrl}/v1/projects/project-a/read/nodes/T-remote-1`, { headers: authHeaders() });
    assert.equal(node.status, 200);
    const nodeBody = await node.json();
    assert.equal(nodeBody.result.node.title, "Remote task");
    assert.equal(nodeBody.result.derived_status, "ready");
    assert.deepEqual(nodeBody.result.blocking, []);
  });
});

test("HTTP v1 returns structured errors and exposes no generic file endpoint", async () => {
  await withApi(async ({ baseUrl }) => {
    const unknownOperation = await operation(baseUrl, "project-a", "filesystem.read", { path: "tasks.json" });
    assert.equal(unknownOperation.status, 404);
    assert.equal((await unknownOperation.json()).error.code, "OPERATION_NOT_FOUND");

    const invalidOperation = await operation(baseUrl, "project-a", "initiative.create", { name: "bad/name" });
    assert.equal(invalidOperation.status, 422);
    const error = (await invalidOperation.json()).error;
    assert.equal(error.code, "INVALID_NAME");
    assert.equal(error.details.name, "bad/name");

    for (const endpoint of ["snapshot", "read/snapshot", "files/tasks.json"]) {
      const response = await fetch(`${baseUrl}/v1/projects/project-a/${endpoint}`, { headers: authHeaders() });
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error.code, "ROUTE_NOT_FOUND");
    }

    const privileged = await operation(baseUrl, "project-a", "task.create", {
      id: "T-bypass",
      initiative: "missing",
      title: "No bypass",
      body: "",
      acceptance: "",
      allow_unregistered_initiative: true,
    });
    assert.equal(privileged.status, 400);
    assert.equal((await privileged.json()).error.code, "INVALID_REQUEST");
  });
});

test("HTTP v1 authenticates before storage access and isolates projects", async () => {
  await withApi(async ({ baseUrl, openCount }) => {
    const unauthorized = await fetch(`${baseUrl}/v1/projects/project-a/read/status`, { headers: { "x-climier-protocol-version": "1" } });
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error.code, "AUTH_REQUIRED");
    assert.equal(openCount(), 0);

    const createA = await operation(baseUrl, "project-a", "initiative.create", { name: "only-a" });
    assert.equal(createA.status, 200);

    const statusA = await fetch(`${baseUrl}/v1/projects/project-a/read/status`, { headers: authHeaders() });
    const statusB = await fetch(`${baseUrl}/v1/projects/project-b/read/status`, { headers: authHeaders() });
    assert.deepEqual((await statusA.json()).result.derived.ready, []);
    assert.deepEqual((await statusB.json()).result.derived.ready, []);
  });
});
