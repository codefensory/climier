import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { PROTOCOL_VERSION } from "../../../src/server/http.ts";
import { authHeaders, operation, withApi, withInitApi } from "./fixtures.mjs";

type ErrorBody = { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };
type CanonicalState = { version: number; nodes: Record<string, unknown>; edges: unknown[]; initiatives: Record<string, unknown>; log: unknown[] };

async function errorBody(response: Response): Promise<ErrorBody> {
  return await response.json() as ErrorBody;
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

test("HTTP v2 routes are not accepted by the v1 server", async () => {
  await withApi(async ({ baseUrl, openCount }) => {
    const response = await fetch(`${baseUrl}/v2/projects/project-a/read/status`, { headers: authHeaders() });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("x-climier-protocol-version"), "1");
    assert.equal((await errorBody(response)).error.code, "ROUTE_NOT_FOUND");
    assert.equal(openCount(), 0);
  });
});

async function assertInitAuthFailures(route) {
  const missingBearer = await fetch(route, { method: "POST", headers: { "x-climier-protocol-version": "1", "content-type": "application/json" }, body: "{}" });
  assert.equal(missingBearer.status, 401);
  assert.equal((await errorBody(missingBearer)).error.code, "AUTH_REQUIRED");

  const invalidBearer = await fetch(route, { method: "POST", headers: { ...authHeaders({ authorization: "Bearer wrong" }), "content-type": "application/json" }, body: "{}" });
  assert.equal(invalidBearer.status, 401);
  assert.equal((await errorBody(invalidBearer)).error.code, "AUTH_INVALID");
}

async function assertReadUnknownProject(baseUrl) {
  const unknown = await fetch(`${baseUrl}/v1/projects/unknown/read/status`, { headers: authHeaders() });
  assert.equal(unknown.status, 404);
  assert.equal((await errorBody(unknown)).error.code, "UNKNOWN_PROJECT");
}

async function assertInvalidInit(route) {
  for (const body of [{ force: true }, { reset: true }, { unexpected: true }]) {
    const invalid = await fetch(route, {
      method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await errorBody(invalid)).error.code, body.force || body.reset ? "REMOTE_UNSUPPORTED_OPERATION" : "INVALID_REQUEST");
  }
}

test("HTTP init validates protocol, bearer, scope, catalog and request fields before storage access", async () => {
  await withInitApi(async ({ baseUrl, dataRoot, openCount }) => {
    const route = `${baseUrl}/v1/projects/catalogued/init`;
    await assertInitAuthFailures(route);
    await assertReadUnknownProject(baseUrl);
    await assertInvalidInit(route);
    assert.equal(openCount(), 0);
    await assert.rejects(fs.access(dataRoot));
  });
});

async function verifyInitializedState(dataRoot, response, openCount) {
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, { seeded: null });
  assert.equal(JSON.stringify(response).includes(dataRoot), false);
  assert.equal(openCount(), 1);

  const projectDir = await (await import("../../../src/server/catalog/index.ts")).createProjectCatalog({ dataRoot }).resolveProject("catalogued");
  const { readState, stateFile } = await import("../../../src/storage/state.ts");
  const state = await readState(projectDir) as CanonicalState;
  assert.equal(state.version, 1);
  assert.deepEqual(state.nodes, {});
  assert.deepEqual(state.edges, []);
  assert.deepEqual(state.initiatives, {});
  assert.deepEqual(state.log, []);
  return { projectDir, stateFile };
}

async function assertInitAlreadyExists(route, { dataRoot, projectDir, stateFile, openCount }) {
  const second = await fetch(route, {
    method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: "{}",
  });
  assert.equal(second.status, 409);
  const error = await errorBody(second);
  assert.equal(error.ok, false);
  assert.equal(error.error.code, "STATE_ALREADY_INITIALIZED");
  assert.match(error.error.message, /already initialized/);
  assert.equal(JSON.stringify(error).includes(dataRoot), false);
  assert.equal(JSON.stringify(error).includes(stateFile(projectDir)), false);
  assert.equal(openCount(), 2);
}

test("HTTP init creates only absent catalogued state once and does not expose storage paths", async () => {
  await withInitApi(async ({ baseUrl, dataRoot, openCount }) => {
    const route = `${baseUrl}/v1/projects/catalogued/init`;
    const initialized = await fetch(route, {
      method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: "{}",
    });
    assert.equal(initialized.status, 200);
    const response = await initialized.json();
    const { projectDir, stateFile } = await verifyInitializedState(dataRoot, response, openCount);
    await assertInitAlreadyExists(route, { dataRoot, projectDir, stateFile, openCount });
  });
});

test("HTTP init rejects unsupported protocol before project opening", async () => {
  await withInitApi(async ({ baseUrl, openCount }) => {
    const response = await fetch(`${baseUrl}/v1/projects/catalogued/init`, {
      method: "POST", headers: { ...authHeaders({ "x-climier-protocol-version": "2" }), "content-type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 426);
    assert.equal((await errorBody(response)).error.code, "PROTOCOL_VERSION_UNSUPPORTED");
    assert.equal(openCount(), 0);
  });
});

test("HTTP v1 authenticates before storage access and isolates projects", async () => {
  await withApi(async ({ baseUrl, openCount }) => {
    const unauthorized = await fetch(`${baseUrl}/v1/projects/project-a/read/status`, { headers: { "x-climier-protocol-version": "1" } });
    assert.equal(unauthorized.status, 401);
    assert.equal((await errorBody(unauthorized)).error.code, "AUTH_REQUIRED");
    assert.equal(openCount(), 0);

    const createA = await operation(baseUrl, "project-a", "initiative.create", { name: "only-a" });
    assert.equal(createA.status, 200);

    const statusA = await fetch(`${baseUrl}/v1/projects/project-a/read/status`, { headers: authHeaders() });
    const statusB = await fetch(`${baseUrl}/v1/projects/project-b/read/status`, { headers: authHeaders() });
    assert.deepEqual((await statusA.json() as { result: { tasks: { ready: unknown[] } } }).result.tasks.ready, []);
    assert.deepEqual((await statusB.json() as { result: { tasks: { ready: unknown[] } } }).result.tasks.ready, []);
  });
});

async function assertMalformedRequestRejected(baseUrl, openCount, request) {
  const openedBefore = openCount();
  const response = await fetch(`${baseUrl}${request.url}`, {
    method: request.method || "GET",
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  assert.equal(response.status, request.status, request.label);
  assert.equal(response.headers.get("x-climier-protocol-version"), PROTOCOL_VERSION, request.label);
  const error = await errorBody(response);
  assert.equal(error.ok, false, request.label);
  assert.equal(error.error.code, request.code, request.label);
  assert.equal(openCount(), openedBefore, `${request.label} must reject before opening a project`);
}

async function assertUnauthorizedOperationRequests(baseUrl, openCount, validOperation) {
  for (const { headers, code } of [
    { headers: { "x-climier-protocol-version": PROTOCOL_VERSION, "content-type": "application/json" }, code: "AUTH_REQUIRED" },
    { headers: { ...authHeaders({ authorization: "Bearer wrong", "content-type": "application/json" }) }, code: "AUTH_INVALID" },
  ]) {
    const response = await fetch(`${baseUrl}/v1/projects/project-a/operations`, {
      method: "POST", headers, body: validOperation,
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("x-climier-protocol-version"), PROTOCOL_VERSION);
    assert.equal((await errorBody(response)).error.code, code);
    assert.equal(openCount(), 0, `${code} must reject before opening a project`);
  }
}

function malformedRequests(protocolOnly) {
  return [
    { label: "invalid JSON operation body", url: "/v1/projects/project-a/operations", method: "POST", headers: { ...protocolOnly, "content-type": "application/json" }, body: "{", status: 400, code: "INVALID_JSON" },
    { label: "unsupported operation media type", url: "/v1/projects/project-a/operations", method: "POST", headers: { ...protocolOnly, "content-type": "text/plain" }, body: "{}", status: 415, code: "UNSUPPORTED_MEDIA_TYPE" },
    { label: "oversized operation body", url: "/v1/projects/project-a/operations", method: "POST", headers: { ...protocolOnly, "content-type": "application/json" }, body: " ".repeat(1024 * 1024 + 1), status: 413, code: "REQUEST_TOO_LARGE" },
    { label: "invalid project ID path encoding", url: "/v1/projects/%E0%A4%A/read/status", headers: protocolOnly, status: 400, code: "INVALID_PROJECT_ID" },
    { label: "invalid read ID path encoding", url: "/v1/projects/project-a/read/show/%E0%A4%A", headers: protocolOnly, status: 400, code: "INVALID_REQUEST" },
    { label: "invalid read query", url: "/v1/projects/project-a/read/status?limit=-1", headers: protocolOnly, status: 400, code: "INVALID_QUERY" },
    { label: "invalid operation schema", url: "/v1/projects/project-a/operations", method: "POST", headers: { ...protocolOnly, "content-type": "application/json" }, body: JSON.stringify({ operation: "initiative.create", actor: "alice", input: { name: "valid", unexpected: true } }), status: 400, code: "INVALID_REQUEST" },
    { label: "v2 transfer route removed", url: "/v2/projects/project-a/transfer/import", method: "POST", headers: { ...protocolOnly, "content-type": "application/json" }, body: JSON.stringify({ payload: {}, actor: "alice" }), status: 404, code: "ROUTE_NOT_FOUND" },
    { label: "invalid transfer payload schema", url: "/v1/projects/project-a/transfer/import", method: "POST", headers: { ...protocolOnly, "content-type": "application/json" }, body: JSON.stringify({ payload: {}, actor: "alice" }), status: 400, code: "INVALID_REQUEST" },
    { label: "extra transfer request field", url: "/v1/projects/project-a/transfer/import", method: "POST", headers: { ...protocolOnly, "content-type": "application/json" }, body: JSON.stringify({ payload: { version: 1, nodes: {}, edges: [], initiatives: {}, log: [] }, actor: "alice", overwrite: true }), status: 400, code: "INVALID_REQUEST" },
    { label: "force with expected revision", url: "/v1/projects/project-a/transfer/import", method: "POST", headers: { ...protocolOnly, "content-type": "application/json" }, body: JSON.stringify({ payload: { version: 1, nodes: {}, edges: [], initiatives: {}, log: [] }, actor: "alice", expected_remote_revision: 0, force: true }), status: 400, code: "INVALID_REQUEST" },
    { label: "invalid init schema", url: "/v1/projects/project-a/init", method: "POST", headers: { ...protocolOnly, "content-type": "application/json" }, body: JSON.stringify({ reset: true }), status: 400, code: "REMOTE_UNSUPPORTED_OPERATION" },
  ];
}

async function assertMalformedRequests(baseUrl, openCount, protocolOnly) {
  for (const request of malformedRequests(protocolOnly)) {
    await assertMalformedRequestRejected(baseUrl, openCount, request);
  }
}

async function assertValidOperationRejectedBeforeOpen(baseUrl, openCount) {
  const validOperation = JSON.stringify({ operation: "initiative.create", actor: "alice", input: { name: "auth" } });
  await assertUnauthorizedOperationRequests(baseUrl, openCount, validOperation);
}

async function assertHttpRequestValidation(baseUrl, openCount) {
  const protocolOnly = { "x-climier-protocol-version": PROTOCOL_VERSION };
  await assertMalformedRequests(baseUrl, openCount, protocolOnly);
  await assertValidOperationRejectedBeforeOpen(baseUrl, openCount);
}

test("HTTP transfer routes authenticate and reject unsupported protocol before project access", async () => {
  await withApi(async ({ baseUrl, openCount }) => {
    const exportUrl = `${baseUrl}/v1/projects/project-a/transfer/export`;
    const unauthenticated = await fetch(exportUrl, { headers: { "x-climier-protocol-version": PROTOCOL_VERSION } });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get("x-climier-protocol-version"), PROTOCOL_VERSION);
    assert.equal((await errorBody(unauthenticated)).error.code, "AUTH_REQUIRED");
    assert.equal(openCount(), 0);

    const invalidBearer = await fetch(exportUrl, { headers: authHeaders({ authorization: "Bearer wrong" }) });
    assert.equal(invalidBearer.status, 401);
    assert.equal(invalidBearer.headers.get("x-climier-protocol-version"), PROTOCOL_VERSION);
    assert.equal((await errorBody(invalidBearer)).error.code, "AUTH_INVALID");
    assert.equal(openCount(), 0);

    const wrongProtocol = await fetch(exportUrl, { headers: authHeaders({ "x-climier-protocol-version": "2" }) });
    assert.equal(wrongProtocol.status, 426);
    assert.equal(wrongProtocol.headers.get("x-climier-protocol-version"), PROTOCOL_VERSION);
    assert.equal((await errorBody(wrongProtocol)).error.code, "PROTOCOL_VERSION_UNSUPPORTED");
    assert.equal(openCount(), 0);

    const validPayload = { version: 1, nodes: {}, edges: [], initiatives: {}, log: [] };
    const unauthorizedImport = await fetch(`${baseUrl}/v1/projects/project-a/transfer/import`, {
      method: "POST",
      headers: { "x-climier-protocol-version": PROTOCOL_VERSION, "content-type": "application/json" },
      body: JSON.stringify({ payload: validPayload, actor: "alice" }),
    });
    assert.equal(unauthorizedImport.status, 401);
    assert.equal((await errorBody(unauthorizedImport)).error.code, "AUTH_REQUIRED");
    assert.equal(openCount(), 0);
  });
});

test("HTTP transfer requires an existing catalog project and never provisions one", async () => {
  await withInitApi(async ({ baseUrl, dataRoot, openCount }) => {
    const response = await fetch(`${baseUrl}/v1/projects/not-provisioned/transfer/export`, { headers: authHeaders() });
    assert.equal(response.status, 404);
    assert.equal((await errorBody(response)).error.code, "UNKNOWN_PROJECT");
    assert.equal(openCount(), 0);
    await assert.rejects(fs.access(dataRoot));
  });
});

test("HTTP validates malformed requests before auth and project opening", async () => {
  await withApi(async ({ baseUrl, openCount }) => {
    await assertHttpRequestValidation(baseUrl, openCount);
  });
});
