import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { authHeaders, withApi, withInitApi } from "./fixtures.ts";

type ProjectSummary = { project_id: string; name: string | null; revision: number; node_count: number; updated_at: string };
type ProjectsBody = { projects: ProjectSummary[] };
type ErrorBody = { error: { code: string } };
async function errorCode(response: Response): Promise<string> {
  return (await response.json() as ErrorBody).error.code;
}

test("GET /v1/projects lists indexed projects without opening a project", async () => {
  await withApi(async ({ baseUrl, openCount, projectDirs }) => {
    const alphaMetadataFile = `${projectDirs[0]}/.climier.json`;
    const alphaMetadata = JSON.parse(await fs.readFile(alphaMetadataFile, "utf8"));
    await fs.writeFile(alphaMetadataFile, JSON.stringify({ ...alphaMetadata, name: "Alpha" }));

    const response = await fetch(`${baseUrl}/v1/projects`, { headers: authHeaders() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-climier-protocol-version"), "1");
    assert.deepEqual(Object.keys(await response.clone().json() as object), ["projects"]);
    const body = await response.json() as ProjectsBody;
    assert.deepEqual(body.projects.map(({ project_id: projectId }) => projectId), ["project-a", "project-b"]);
    assert.deepEqual(body.projects.find(({ project_id: projectId }) => projectId === "project-a"), {
      project_id: "project-a",
      name: "Alpha",
      revision: 1,
      node_count: 0,
      updated_at: body.projects[0].updated_at,
    });
    assert.equal(body.projects.find(({ project_id: projectId }) => projectId === "project-b")!.name, null);
    assert.match(body.projects[0].updated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(openCount(), 0);
  });
});

test("GET /v1/projects requires the protocol header and explicit bearer auth", async () => {
  await withApi(async ({ baseUrl, openCount }) => {
    const missingBearer = await fetch(`${baseUrl}/v1/projects`, {
      headers: { "x-climier-protocol-version": "1" },
    });
    assert.equal(missingBearer.status, 401);
    assert.equal(await errorCode(missingBearer), "AUTH_REQUIRED");

    const invalidBearer = await fetch(`${baseUrl}/v1/projects`, {
      headers: authHeaders({ authorization: "Bearer wrong" }),
    });
    assert.equal(invalidBearer.status, 401);
    assert.equal(await errorCode(invalidBearer), "AUTH_INVALID");

    const missingProtocol = await fetch(`${baseUrl}/v1/projects`, {
      headers: { authorization: "Bearer test-token" },
    });
    assert.equal(missingProtocol.status, 426);
    assert.equal(await errorCode(missingProtocol), "PROTOCOL_VERSION_UNSUPPORTED");
    assert.equal(openCount(), 0);
  });
});

test("GET /v1/projects returns an empty catalog without creating the data root", async () => {
  await withInitApi(async ({ baseUrl, dataRoot, openCount }) => {
    const response = await fetch(`${baseUrl}/v1/projects`, { headers: authHeaders() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { projects: [] });
    assert.equal(openCount(), 0);
    await assert.rejects(fs.access(dataRoot), { code: "ENOENT" });
  });
});
