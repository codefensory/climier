import { test } from "node:test";
import assert from "node:assert/strict";

import * as httpServer from "../../../src/server/http.mjs";
const { createRemoteApiServer, PROTOCOL_VERSION } = httpServer;
import { createHttpCodec } from "../../../src/server/http/codec.mjs";
import { authHeaders, operation, withApi, withInitApi } from "./fixtures.mjs";

test("HTTP codec keeps path and body decoding contracts and receives the public protocol version", async () => {
  const codec = createHttpCodec({ protocolVersion: PROTOCOL_VERSION });
  assert.equal(codec.protocolVersion, PROTOCOL_VERSION);

  assert.deepEqual(codec.parseProjectPath("/v2/projects/project-a/read/status"), {
    projectId: "project-a",
    route: "read/status",
  });
  assert.throws(() => codec.parseProjectPath("/v2/projects/%E0%A4%A/read/status"), {
    code: "INVALID_PROJECT_ID",
    status: 400,
  });
  assert.throws(() => codec.readRoute("read/show/%E0%A4%A"), {
    code: "INVALID_REQUEST",
    status: 400,
  });

  await assert.rejects(codec.readJsonBody({ headers: { "content-type": "text/plain" }, async *[Symbol.asyncIterator]() {} }), {
    code: "UNSUPPORTED_MEDIA_TYPE",
    status: 415,
  });
});

test("HTTP codec accepts a bounded operator body limit for large manual transfers", async () => {
  const previous = process.env.CLIMIER_SERVER_MAX_BODY_BYTES;
  process.env.CLIMIER_SERVER_MAX_BODY_BYTES = String(2 * 1024 * 1024);
  try {
    const codec = createHttpCodec({ protocolVersion: PROTOCOL_VERSION });
    const payload = "x".repeat(1024 * 1024 + 100);
    const body = Buffer.from(JSON.stringify({ payload }));
    const request = {
      headers: { "content-type": "application/json" },
      async *[Symbol.asyncIterator]() { yield body; },
    };
    assert.equal((await codec.readJsonBody(request)).payload.length, payload.length);
    process.env.CLIMIER_SERVER_MAX_BODY_BYTES = String(32 * 1024 * 1024 + 1);
    assert.throws(() => createHttpCodec({ protocolVersion: PROTOCOL_VERSION }), /max body bytes must be an integer/);
  } finally {
    if (previous === undefined) {delete process.env.CLIMIER_SERVER_MAX_BODY_BYTES;} else {process.env.CLIMIER_SERVER_MAX_BODY_BYTES = previous;}
  }
});

function assertHeaders(response, bodyText) {
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(bodyText)));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-climier-protocol-version"), PROTOCOL_VERSION);
}

async function assertOperationResponse(baseUrl) {
  const operationResponse = await operation(baseUrl, "project-a", "initiative.create", { name: "headers" });
  const operationText = await operationResponse.text();
  assert.equal(operationResponse.status, 200);
  assertHeaders(operationResponse, operationText);
  assert.deepEqual(Object.keys(JSON.parse(operationText)), ["ok", "result"]);
}

async function assertReadResponse(baseUrl) {
  const readResponse = await fetch(`${baseUrl}/v2/projects/project-a/read/status`, { headers: authHeaders() });
  const readText = await readResponse.text();
  assert.equal(readResponse.status, 200);
  assertHeaders(readResponse, readText);
  assert.deepEqual(Object.keys(JSON.parse(readText)), ["ok", "result"]);
}

async function assertLoginResponse(baseUrl) {
  const loginHeaders = { "x-climier-protocol-version": PROTOCOL_VERSION, "content-type": "application/json" };
  const loginResponse = await fetch(`${baseUrl}/v2/auth/login`, {
    method: "POST",
    headers: loginHeaders,
    body: JSON.stringify({ password: "password" }),
  });
  const loginText = await loginResponse.text();
  assert.equal(loginResponse.status, 200);
  assertHeaders(loginResponse, loginText);
  assert.deepEqual(JSON.parse(loginText), { ok: true, token: "test-token", token_type: "Bearer", expires_in_days: 30 });

  const wrong = await fetch(`${baseUrl}/v2/auth/login`, {
    method: "POST",
    headers: loginHeaders,
    body: JSON.stringify({ password: "wrong" }),
  });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, "AUTH_INVALID");
}

async function assertErrorResponse(baseUrl) {
  const errorResponse = await operation(baseUrl, "project-a", "not.registered", {});
  const errorText = await errorResponse.text();
  assert.equal(errorResponse.status, 404);
  assertHeaders(errorResponse, errorText);
  assert.deepEqual(JSON.parse(errorText), {
    ok: false,
    error: {
      code: "OPERATION_NOT_FOUND",
      message: "application.executeOperation: operation 'not.registered' is not registered",
      details: { operation: "not.registered" },
    },
  });
}

async function assertInitResponses(baseUrl) {
  const route = `${baseUrl}/v2/projects/catalogued/init`;
  const initialized = await fetch(route, {
    method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: "{}",
  });
  const initializedText = await initialized.text();
  assert.equal(initialized.status, 200);
  assertHeaders(initialized, initializedText);
  assert.deepEqual(JSON.parse(initializedText), { ok: true, result: { seeded: null } });

  const repeated = await fetch(route, {
    method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: "{}",
  });
  const repeatedText = await repeated.text();
  assert.equal(repeated.status, 409);
  assertHeaders(repeated, repeatedText);
  assert.equal(JSON.parse(repeatedText).error.code, "STATE_ALREADY_INITIALIZED");
}

test("HTTP facade exports and response headers/envelopes remain stable", async () => {
  assert.deepEqual(Object.keys(httpServer).toSorted(), ["PROTOCOL_VERSION", "createRemoteApiServer"]);
  assert.equal(typeof createRemoteApiServer, "function");
  assert.equal(PROTOCOL_VERSION, "2");

  await withApi(async ({ baseUrl }) => {
    await assertOperationResponse(baseUrl);
    await assertReadResponse(baseUrl);
    await assertLoginResponse(baseUrl);
    await assertErrorResponse(baseUrl);
  });

  await withInitApi(async ({ baseUrl }) => {
    await assertInitResponses(baseUrl);
  });
});
