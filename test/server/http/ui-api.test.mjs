import assert from "node:assert/strict";
import { test } from "node:test";

import { authHeaders, withApi, withInitApi } from "./fixtures.mjs";
import { createProjectCatalog } from "../../../src/server/catalog/index.mjs";
import { createUiApi } from "../../../src/server/http/ui-api.mjs";
import { readState, writeCanonicalState } from "../../helpers.mjs";

function state() {
  return {
    revision: 12,
    initiatives: { alpha: { desc: "Alpha", created_at: "2026-01-01T00:00:00.000Z" } },
    nodes: {
      gate: { id: "gate", kind: "resolvable", subkind: "gate", title: "Approve", status: "resolved", initiative: "alpha" },
      task: { id: "task", kind: "resolvable", subkind: "task", title: "Ship", status: "open", initiative: "alpha", domain: "api" },
    },
    edges: [{ from: "gate", to: "task", type: "BLOCKS" }],
    log: [{ ts: "2026-01-01T00:00:00.000Z", agent: "alice", action: "take", node: "task" }],
  };
}

test("UI HTTP endpoints authenticate, project, and return the pure projections", async () => {
  await withApi(async ({ baseUrl, projectDirs }) => {
    await writeCanonicalState(projectDirs[0], state());

    const snapshotResponse = await fetch(`${baseUrl}/v1/projects/project-a/ui/snapshot`, { headers: authHeaders() });
    assert.equal(snapshotResponse.status, 200);
    assert.equal(snapshotResponse.headers.get("x-climier-protocol-version"), "1");
    const snapshotBody = await snapshotResponse.json();
    assert.equal(snapshotBody.ok, true);
    assert.deepEqual(snapshotBody.result.project, {
      id: "project-a",
      name: "project-a",
      revision: (await readState(projectDirs[0])).revision,
      generated_at: snapshotBody.result.project.generated_at,
    });
    assert.equal(snapshotBody.result.recent_activity.length, 1);

    const nodeResponse = await fetch(`${baseUrl}/v1/projects/project-a/ui/nodes/task`, { headers: authHeaders() });
    assert.equal(nodeResponse.status, 200);
    const nodeBody = await nodeResponse.json();
    assert.equal(nodeBody.result.node.id, "task");
    assert.equal(nodeBody.result.derived_status, "ready");
    assert.deepEqual(nodeBody.result.blocking.map(({ node, satisfied }) => [node.id, satisfied]), [["gate", true]]);

    const activityResponse = await fetch(`${baseUrl}/v1/projects/project-a/ui/activity?limit=1&offset=0&agent=alice`, { headers: authHeaders() });
    assert.equal(activityResponse.status, 200);
    const activityBody = await activityResponse.json();
    assert.deepEqual(activityBody.result.entries.map((entry) => entry.node_id), ["task"]);
    assert.equal(activityBody.result.total, 1);
  });
});

test("UI HTTP endpoints use the existing auth, query, and project errors", async () => {
  await withApi(async ({ baseUrl }) => {
    const unauthenticated = await fetch(`${baseUrl}/v1/projects/project-a/ui/snapshot`, {
      headers: { "x-climier-protocol-version": "1" },
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).error.code, "AUTH_REQUIRED");

    const invalidQuery = await fetch(`${baseUrl}/v1/projects/project-a/ui/activity?limit=nope`, { headers: authHeaders() });
    assert.equal(invalidQuery.status, 400);
    assert.equal((await invalidQuery.json()).error.code, "INVALID_QUERY");

    const unknown = await fetch(`${baseUrl}/v1/projects/unknown/ui/snapshot`, { headers: authHeaders() });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, "UNKNOWN_PROJECT");
  });

  await withInitApi(async ({ baseUrl, dataRoot }) => {
    await createProjectCatalog({ dataRoot }).provisionProject("not-initialized");
    const response = await fetch(`${baseUrl}/v1/projects/not-initialized/ui/snapshot`, { headers: authHeaders() });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "STATE_NOT_INITIALIZED");
  });
});

test("UI API accepts local project, auth, and snapshot adapters", async () => {
  const calls = [];
  const api = createUiApi({
    authorize(request, context) {
      calls.push(["authorize", request, context.projectId]);
    },
    getProject(projectId) {
      calls.push(["getProject", projectId]);
      return { id: projectId, name: "Local" };
    },
    readSnapshot(project) {
      calls.push(["readSnapshot", project.id]);
      return state();
    },
  });

  const result = await api.read({
    request: { local: true },
    projectId: "local-project",
    route: api.matchRoute("ui/snapshot"),
    now: Date.parse("2026-01-02T03:04:05.000Z"),
  });
  assert.equal(result.project.name, "Local");
  assert.deepEqual(calls, [
    ["authorize", { local: true }, "local-project"],
    ["getProject", "local-project"],
    ["readSnapshot", "local-project"],
  ]);
});
