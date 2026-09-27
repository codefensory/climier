import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createBackendClient } from "../src/application/backend-client.mjs";
import { remoteV1Manifest } from "../src/application/operations/remote-v1-manifest.mjs";


async function withServer(handler, run, { approveOrigin = false } = {}) {
  const server = createServer(handler);
  await listen(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const restoreRemoteEnvironment = isolateRemoteEnvironment();
  if (approveOrigin) {
    process.env.CLIMIER_REMOTE_ORIGIN = new URL(url).origin;
  }
  try {
    await run(url);
  } finally {
    restoreRemoteEnvironment();
    await closeServer(server);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function isolateRemoteEnvironment() {
  const previous = Object.fromEntries([
    "CLIMIER_TOKEN",
    "CLIMIER_REMOTE_ORIGIN",
    "CLIMIER_ALLOW_INSECURE_REMOTE_HTTP",
  ].map((key) => [key, process.env[key]]));
  for (const key of Object.keys(previous)) { delete process.env[key]; }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) { delete process.env[key]; }
      else { process.env[key] = value; }
    }
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) { chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function unsupportedRemoteOperation(operation) {
  return (error) => error.code === "REMOTE_UNSUPPORTED_OPERATION" && error.details.operation === operation;
}

async function assertManifestOperationsAccepted(client) {
  for (const { id: operation } of remoteV1Manifest.operations) {
    assert.deepEqual(await client.executeOperation({ actor: "alice", operation, input: {} }), { accepted: true });
  }
  assert.deepEqual(await client.executeBatch({ actor: "alice", operations: [] }), { accepted: true });
}

async function assertUnsupportedRemoteOperations(client) {
  for (const operation of ["plugin.custom", "core.batch"]) {
    await assert.rejects(
      client.executeOperation({ actor: "alice", operation, input: {} }),
      unsupportedRemoteOperation(operation),
    );
    await assert.rejects(
      client.executeBatch({ actor: "alice", operations: [{ op: operation, input: {} }] }),
      unsupportedRemoteOperation(operation),
    );
  }
}

test("remote backend executes manifest operations and rejects IDs outside the manifest without local fallback", async () => {
  const requests = [];
  let localCalls = 0;
  await withServer(async (request, response) => {
    requests.push(await readRequestBody(request));
    response.writeHead(200, { "content-type": "application/json", "x-climier-protocol-version": "1" });
    response.end(JSON.stringify({ ok: true, result: { accepted: true } }));
  }, async (url) => {
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: { project_id: "remote-project", backend: { type: "remote", url } },
      source: {
        registry: { lookup() { localCalls += 1; return { provider: { prepare() {}, apply() {} } }; } },
        mutate() { localCalls += 1; return {}; },
      },
    });
    await assertManifestOperationsAccepted(client);
    await assertUnsupportedRemoteOperations(client);
  }, { approveOrigin: true });
  assert.deepEqual(requests, [
    ...remoteV1Manifest.operations.map(({ id: operation }) => ({ operation, actor: "alice", input: {} })),
    { operation: "core.batch", actor: "alice", input: { operations: [] } },
  ]);
  assert.equal(localCalls, 0);
});

test("remote-v1 operation manifest omits if_revision as an operation property", () => {
  const revisionField = ["if", "revision"].join("_");
  for (const operation of remoteV1Manifest.operations) {
    assert.equal(Object.hasOwn(operation, revisionField), false, `${operation.id} must omit ${revisionField}`);
  }
});

test("backend client uses remote HTTP v1 URL, protocol, bearer auth, actor, and result envelope", async () => {
  const result = { diff: { created: [{ id: "T-remote" }] } };
  await withServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/projects/project%2Fopaque/operations");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["x-climier-protocol-version"], "1");
    assert.equal(request.headers.authorization, "Bearer test-token");
    const chunks = [];
    for await (const chunk of request) { chunks.push(chunk); }
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
      operation: "task.create",
      actor: "alice",
      input: { id: "T-remote" },
    });
    response.writeHead(200, {
      "content-type": "application/json",
      "x-climier-protocol-version": "1",
    });
    response.end(JSON.stringify({ ok: true, result }));
  }, async (url) => {
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: { project_id: "project/opaque", backend: { type: "remote", url } },
      token: "test-token",
      source: { registry: { lookup() { throw new Error("local source must not run"); } }, mutate() { throw new Error("local source must not run"); } },
    });
    assert.deepEqual(await client.executeOperation({
      actor: "alice",
      operation: "task.create",
      input: { id: "T-remote" },
    }), result);
  }, { approveOrigin: true });
});

async function assertTypedReads(client) {
  const results = await Promise.all([
    client.readStatus({
      initiative: "migration & rollout",
      kind: "task",
      status: "in_progress",
      domain: "api/v1",
      claimedBy: "alice smith",
      staleMs: 0,
      limit: 0,
      all: false,
      as: "auditor",
    }),
    client.readContext({ id: "T/context", as: "alice smith", staleMs: 0 }),
    client.readNode({ id: "T/show" }),
    client.readHistory({ id: "T/history", limit: 0 }),
    client.readSearch({ query: "api / v1", all: true }),
    client.readInitiatives({ all: false }),
    client.readLog({ limit: 0, action: "task update", agent: "alice", task: "T-1", decision: "D/1" }),
    client.readState(),
  ]);
  return results;
}

test("backend client isolates an ambient token for an unconfigured project", async () => {
  const previousToken = process.env.CLIMIER_TOKEN;
  process.env.CLIMIER_TOKEN = "ambient-test-token";
  try {
    await withServer(async (request, response) => {
      assert.equal(request.headers.authorization, undefined);
      response.writeHead(200, { "content-type": "application/json", "x-climier-protocol-version": "1" });
      response.end(JSON.stringify({ ok: true, result: { accepted: true } }));
    }, async (url) => {
      assert.equal(process.env.CLIMIER_TOKEN, undefined);
      const client = createBackendClient({
        projectDir: "/project",
        projectConfig: { project_id: "remote-project", backend: { type: "remote", url } },
      });
      assert.deepEqual(await client.readStatus(), { accepted: true });
    }, { approveOrigin: true });
  } finally {
    if (previousToken === undefined) { delete process.env.CLIMIER_TOKEN; }
    else { process.env.CLIMIER_TOKEN = previousToken; }
  }
});

test("backend client maps all typed reads to v1 routes and preserves filter values", async () => {
  await verifyTypedReadRoutes();
});

async function verifyTypedReadRoutes() {
  const requests = [];
  await withServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, {
      "content-type": "application/json",
      "x-climier-protocol-version": "1",
    });
    response.end(JSON.stringify({ ok: true, result: { request: request.url } }));
  }, async (url) => {
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: { project_id: "project/opaque", backend: { type: "remote", url } },
    });
    const results = await assertTypedReads(client);
    assert.deepEqual(requests, [
      "GET /v1/projects/project%2Fopaque/read/status?initiative=migration+%26+rollout&kind=task&status=in_progress&domain=api%2Fv1&claimed-by=alice+smith&stale-ms=0&limit=0&all=false&as=auditor",
      "GET /v1/projects/project%2Fopaque/read/context/T%2Fcontext?as=alice+smith&staleMs=0",
      "GET /v1/projects/project%2Fopaque/read/show/T%2Fshow",
      "GET /v1/projects/project%2Fopaque/read/history/T%2Fhistory?limit=0",
      "GET /v1/projects/project%2Fopaque/read/search?query=api+%2F+v1&all=true",
      "GET /v1/projects/project%2Fopaque/read/initiatives?all=false",
      "GET /v1/projects/project%2Fopaque/read/log?limit=0&action=task+update&agent=alice&task=T-1&decision=D%2F1",
      "GET /v1/projects/project%2Fopaque/read/state",
    ]);
    assert.deepEqual(results, requests.map((request) => ({ request: request.slice(4) })));
  });
}

function assertInvalidReadOptions(client) {
  const invalidReadOptions = [
    () => client.readStatus({ claimedBy: 42 }),
    () => client.readContext({ id: "T-1", staleMs: -1 }),
    () => client.readNode({ id: "" }),
    () => client.readHistory({ id: "T-1", limit: "2" }),
    () => client.readSearch({ query: 42 }),
    () => client.readInitiatives({ all: "true" }),
    () => client.readLog({ unexpected: "value" }),
  ];
  for (const read of invalidReadOptions) {
    assert.throws(read, { code: "INVALID_REQUEST" });
  }
}

test("typed read methods validate required ids and query option types before requesting", async () => {
  await withServer(() => assert.fail("invalid read inputs must not make HTTP requests"), async (url) => {
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: { project_id: "project", backend: { type: "remote", url } },
    });
    assertInvalidReadOptions(client);
  });
});

function isStructuredRemoteError(error) {
  assert.equal(error.code, "AUTH_REQUIRED");
  assert.equal(error.message, "server http: bearer token is required");
  assert.deepEqual(error.details, { project_id: "remote-project" });
  assert.equal(error.status, 401);
  return true;
}

test("backend client propagates structured remote errors without local fallback", async () => {
  let localCalls = 0;
  await withServer(async (_request, response) => {
    response.writeHead(401, {
      "content-type": "application/json",
      "x-climier-protocol-version": "1",
    });
    response.end(JSON.stringify({
      ok: false,
      error: {
        code: "AUTH_REQUIRED",
        message: "server http: bearer token is required",
        details: { project_id: "remote-project" },
      },
    }));
  }, async (url) => {
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: { project_id: "remote-project", backend: { type: "remote", url } },
      token: "invalid-token",
      remoteOrigin: new URL(url).origin,
      source: {
        registry: { lookup() { localCalls += 1; return { provider: { prepare() {}, apply() {} } }; } },
        mutate() { localCalls += 1; return {}; },
      },
    });
    await assert.rejects(client.readStatus({ initiative: "remote-only" }), isStructuredRemoteError);
  });
  assert.equal(localCalls, 0);
});

function isUnsupportedProtocol(error) {
  assert.equal(error.code, "PROTOCOL_VERSION_UNSUPPORTED");
  assert.deepEqual(error.details, { expected: "1", received: "2" });
  return true;
}

function invalidResponse(error) {
  return error.code === "REMOTE_INVALID_RESPONSE";
}

async function assertMalformedSuccessEnvelope() {
  await withServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "x-climier-protocol-version": "1",
    });
    response.end(JSON.stringify({ ok: true }));
  }, async (url) => {
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: { project_id: "remote-project", backend: { type: "remote", url } },
    });
    await assert.rejects(client.readStatus(), invalidResponse);
  });
}

test("backend client rejects incompatible protocol and malformed success envelopes", async () => {
  let localCalls = 0;
  await withServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "x-climier-protocol-version": "2",
    });
    response.end(JSON.stringify({ ok: true, result: { unexpected: true } }));
  }, async (url) => {
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: { project_id: "remote-project", backend: { type: "remote", url } },
      source: { registry: { lookup() { localCalls += 1; } }, mutate() { localCalls += 1; } },
    });
    await assert.rejects(client.readStatus(), isUnsupportedProtocol);
  });

  await assertMalformedSuccessEnvelope();
  assert.equal(localCalls, 0);
});
