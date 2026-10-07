import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { test } from "node:test";

import { authHeaders, withApi, withInitApi } from "./fixtures.ts";
import { createProjectCatalog } from "../../../src/server/catalog/index.ts";
import { createUiApi } from "../../../src/server/http/ui-api.ts";
import { readState, writeCanonicalState } from "../../helpers.ts";

type RawResponse = { status: number | undefined; headers: http.IncomingHttpHeaders; body: Buffer };
type UiBody = { ok?: boolean; result: { project: { id: string; name: string; revision: number; generated_at: string }; recent_activity: unknown[]; node: { id: string }; derived_status: string; blocking: Array<{ node: { id: string }; satisfied: boolean }>; entries: Array<{ node_id: string | null }>; total: number } };
type ErrorBody = { error: { code: string } };
async function errorCode(response: Response): Promise<string> {
  return (await response.json() as ErrorBody).error.code;
}

function rawGet(url: string, headers: Record<string, string>): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on("error", reject);
  });
}

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
    const snapshotBody = await snapshotResponse.json() as UiBody;
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
    const nodeBody = await nodeResponse.json() as UiBody;
    assert.equal(nodeBody.result.node.id, "task");
    assert.equal(nodeBody.result.derived_status, "ready");
    assert.deepEqual(nodeBody.result.blocking.map(({ node, satisfied }) => [node.id, satisfied]), [["gate", true]]);

    const activityResponse = await fetch(`${baseUrl}/v1/projects/project-a/ui/activity?limit=1&offset=0&agent=alice`, { headers: authHeaders() });
    assert.equal(activityResponse.status, 200);
    const activityBody = await activityResponse.json() as UiBody;
    assert.deepEqual(activityBody.result.entries.map((entry) => entry.node_id), ["task"]);
    assert.equal(activityBody.result.total, 1);
  });
});

test("UI snapshot uses revision ETags, 304, and cached negotiated compression", async () => {
  await withApi(async ({ baseUrl, projectDirs }) => {
    await writeCanonicalState(projectDirs[0], state());
    const route = `${baseUrl}/v1/projects/project-a/ui/snapshot`;
    const revision = (await readState(projectDirs[0])).revision;

    const plainResponse = await rawGet(route, authHeaders({ "accept-encoding": "identity" }));
    assert.equal(plainResponse.status, 200);
    assert.equal(plainResponse.headers.etag, `"${revision}"`);
    assert.equal(plainResponse.headers["content-encoding"], undefined);
    const plain = plainResponse.body;

    const notModified = await rawGet(route, authHeaders({ "accept-encoding": "identity", "if-none-match": `"${revision}"` }));
    assert.equal(notModified.status, 304);
    assert.equal(notModified.body.byteLength, 0);
    assert.equal(notModified.headers["content-length"], "0");

    const gzipResponse = await rawGet(route, authHeaders({ "accept-encoding": "gzip" }));
    assert.equal(gzipResponse.status, 200);
    assert.equal(gzipResponse.headers["content-encoding"], "gzip");
    assert.deepEqual(gunzipSync(gzipResponse.body), plain);

    const brResponse = await rawGet(route, authHeaders({ "accept-encoding": "br" }));
    assert.equal(brResponse.status, 200);
    assert.equal(brResponse.headers["content-encoding"], "br");
    assert.deepEqual(brotliDecompressSync(brResponse.body), plain);
  });
});

test("UI snapshot brotli stays interactive on a multi-megabyte body", async () => {
  await withApi(async ({ baseUrl, projectDirs }) => {
    // Incompressible bodies reproduce the real snapshot cost: brotli's default
    // quality (11) spends seconds on them, and the revision cache makes every
    // post-mutation refresh pay it again.
    const nodes = {};
    for (let index = 0; index < 400; index += 1) {
      let body = "";
      while (body.length < 6_000) {
        body += `${randomBytes(3).toString("base64")} `;
      }
      nodes[`T-${index}`] = {
        id: `T-${index}`,
        kind: "resolvable",
        subkind: "task",
        title: `Task ${index} ${randomBytes(4).toString("hex")}`,
        body: body.slice(0, 6_000),
        status: "open",
        initiative: "alpha",
      };
    }
    await writeCanonicalState(projectDirs[0], { ...state(), nodes, edges: [] });

    const route = `${baseUrl}/v1/projects/project-a/ui/snapshot`;
    const plain = (await rawGet(route, authHeaders({ "accept-encoding": "identity" }))).body;
    assert.ok(plain.byteLength > 2_000_000, `expected a multi-megabyte body, got ${plain.byteLength}`);

    const started = Date.now();
    const brResponse = await rawGet(route, authHeaders({ "accept-encoding": "br" }));
    const elapsed = Date.now() - started;
    assert.equal(brResponse.headers["content-encoding"], "br");
    assert.deepEqual(brotliDecompressSync(brResponse.body), plain);
    assert.ok(elapsed < 2_500, `brotli compression took ${elapsed}ms`);
  });
});

test("UI HTTP endpoints use the existing auth, query, and project errors", async () => {
  await withApi(async ({ baseUrl }) => {
    const unauthenticated = await fetch(`${baseUrl}/v1/projects/project-a/ui/snapshot`, {
      headers: { "x-climier-protocol-version": "1" },
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(await errorCode(unauthenticated), "AUTH_REQUIRED");

    const invalidQuery = await fetch(`${baseUrl}/v1/projects/project-a/ui/activity?limit=nope`, { headers: authHeaders() });
    assert.equal(invalidQuery.status, 400);
    assert.equal(await errorCode(invalidQuery), "INVALID_QUERY");

    const unknown = await fetch(`${baseUrl}/v1/projects/unknown/ui/snapshot`, { headers: authHeaders() });
    assert.equal(unknown.status, 404);
    assert.equal(await errorCode(unknown), "UNKNOWN_PROJECT");
  });

  await withInitApi(async ({ baseUrl, dataRoot }) => {
    await createProjectCatalog({ dataRoot }).provisionProject("not-initialized");
    const response = await fetch(`${baseUrl}/v1/projects/not-initialized/ui/snapshot`, { headers: authHeaders() });
    assert.equal(response.status, 409);
    assert.equal(await errorCode(response), "STATE_NOT_INITIALIZED");
  });
});

test("UI API accepts local project, auth, and snapshot adapters", async () => {
  const calls: unknown[][] = [];
  const api = createUiApi({
    async authorize(request, context: { projectId: string }) {
      calls.push(["authorize", request, context.projectId]);
    },
    async getProject(projectId) {
      calls.push(["getProject", projectId]);
      return { id: projectId, name: "Local" };
    },
    async readSnapshot(project: { id: string }) {
      calls.push(["readSnapshot", project.id]);
      return state();
    },
  } as unknown as Parameters<typeof createUiApi>[0]);

  const result = await api.read({
    request: { local: true },
    projectId: "local-project",
    route: api.matchRoute("ui/snapshot"),
    now: Date.parse("2026-01-02T03:04:05.000Z"),
  });
  assert.equal((result as { project: { name: string } }).project.name, "Local");
  assert.deepEqual(calls, [
    ["authorize", { local: true }, "local-project"],
    ["getProject", "local-project"],
    ["readSnapshot", "local-project"],
  ]);
});
