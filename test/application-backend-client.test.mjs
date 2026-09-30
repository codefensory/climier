import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createBackendClient, REMOTE_PROTOCOL_VERSION } from "../src/application/operations/index.mjs";
import { loginRemote } from "../src/application/backend-remote-transport.mjs";

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { await run(origin); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function remoteConfig(origin) {
  return { project_id: "project/opaque", backend: { type: "remote", url: origin, protocol: "v2" } };
}

function jsonResponse(response, result) {
  response.writeHead(200, { "content-type": "application/json", "x-climier-protocol-version": "2" });
  response.end(JSON.stringify({ ok: true, result }));
}

test("backend client keeps local execution unchanged", async () => {
  const calls = [];
  const result = { diff: { created: [] } };
  const client = createBackendClient({
    projectDir: "/project",
    projectConfig: { version: 1, project_id: "local-project" },
    source: {
      registry: { lookup(operation) { calls.push(operation); return { provider: { prepare() {}, apply() {} } }; } },
      mutate(request) { calls.push(request.request.action); return result; },
    },
  });
  assert.equal(await client.executeOperation({ actor: "alice", operation: "task.create", input: {} }), result);
  assert.equal(client.exportTransfer, undefined);
  assert.equal(client.importTransfer, undefined);
  assert.deepEqual(calls, ["task.create", "task.create"]);
});

test("remote client uses protocol v2 and only the profile bearer for its origin", async () => {
  const requests = [];
  await withServer(async (request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization, protocol: request.headers["x-climier-protocol-version"], body: await readJson(request) });
    jsonResponse(response, { accepted: true });
  }, async (origin) => {
    const lookedUp = [];
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: remoteConfig(origin),
      credentialStore: { async get(value) { lookedUp.push(value); return "profile-token"; } },
    });
    assert.deepEqual(await client.executeOperation({ actor: "alice", operation: "task.create", input: { id: "T1" } }), { accepted: true });
    assert.deepEqual(lookedUp, [origin]);
  });
  assert.equal(REMOTE_PROTOCOL_VERSION, "2");
  assert.deepEqual(requests, [{
    url: "/v2/projects/project%2Fopaque/operations",
    authorization: "Bearer profile-token",
    protocol: "2",
    body: { operation: "task.create", actor: "alice", input: { id: "T1" } },
  }]);
});

test("remote client exports and imports transfers through authenticated v2 endpoints", async () => {
  const requests = [];
  const payload = { version: 1, nodes: {}, edges: [], initiatives: {}, log: [] };
  await withServer(async (request, response) => {
    const observed = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      protocol: request.headers["x-climier-protocol-version"],
    };
    if (request.method === "POST") {observed.body = await readJson(request);}
    requests.push(observed);
    jsonResponse(response, request.method === "GET" ? { payload, revision: 13 } : { revision: 14 });
  }, async (origin) => {
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: remoteConfig(origin),
      credentialStore: { async get() { return "profile-token"; } },
    });
    assert.deepEqual(await client.exportTransfer(), { payload, revision: 13 });
    assert.deepEqual(await client.importTransfer({
      payload,
      actor: "alice",
      expected_remote_revision: 13,
      force: false,
      ignored: "must-not-be-sent",
    }), { revision: 14 });
  });
  assert.deepEqual(requests, [
    {
      method: "GET",
      url: "/v2/projects/project%2Fopaque/transfer/export",
      authorization: "Bearer profile-token",
      protocol: "2",
    },
    {
      method: "POST",
      url: "/v2/projects/project%2Fopaque/transfer/import",
      authorization: "Bearer profile-token",
      protocol: "2",
      body: { payload, actor: "alice", expected_remote_revision: 13, force: false },
    },
  ]);
});

test("legacy credential environment variables never authenticate remote requests", async () => {
  const previousToken = process.env.CLIMIER_TOKEN;
  const previousOrigin = process.env.CLIMIER_REMOTE_ORIGIN;
  process.env.CLIMIER_TOKEN = "legacy-secret";
  process.env.CLIMIER_REMOTE_ORIGIN = "https://legacy.example";
  try {
    await withServer((request, response) => {
      assert.equal(request.headers.authorization, undefined);
      jsonResponse(response, {});
    }, async (origin) => {
      const client = createBackendClient({ projectDir: "/project", projectConfig: remoteConfig(origin), credentialStore: { async get() { return null; } } });
      await client.readStatus();
    });
  } finally {
    if (previousToken === undefined) {delete process.env.CLIMIER_TOKEN;} else {process.env.CLIMIER_TOKEN = previousToken;}
    if (previousOrigin === undefined) {delete process.env.CLIMIER_REMOTE_ORIGIN;} else {process.env.CLIMIER_REMOTE_ORIGIN = previousOrigin;}
  }
});

test("remote transfer methods preserve HTTP, protocol, and timeout errors", async () => {
  const payload = { version: 1, nodes: {}, edges: [], initiatives: {}, log: [] };
  let call = 0;
  await withServer((request, response) => {
    call += 1;
    if (call === 1) {
      response.writeHead(401, { "content-type": "application/json", "x-climier-protocol-version": "2" });
      response.end(JSON.stringify({ ok: false, error: { code: "AUTH_REQUIRED", message: "login required", details: { profile: "missing" } } }));
    } else if (call === 2) {
      response.writeHead(409, { "content-type": "application/json", "x-climier-protocol-version": "2" });
      response.end(JSON.stringify({ ok: false, error: { code: "TRANSFER_REMOTE_CHANGED", message: "remote changed", details: { expected: 3, current: 4 } } }));
    } else if (call === 3) {
      response.writeHead(200, { "content-type": "application/json", "x-climier-protocol-version": "1" });
      response.end(JSON.stringify({ ok: true, result: { payload, revision: 3 } }));
    } else if (call === 4) {
      jsonResponse(response, { payload: [], revision: 3 });
    }
  }, async (origin) => {
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: remoteConfig(origin),
      credentialStore: { async get() { return "profile-token"; } },
      timeoutMs: 100,
    });
    await assert.rejects(client.exportTransfer(), (error) => error.code === "AUTH_REQUIRED" && error.status === 401 && error.details.profile === "missing");
    await assert.rejects(client.importTransfer({ payload, actor: "alice" }), (error) => error.code === "TRANSFER_REMOTE_CHANGED" && error.status === 409 && error.details.current === 4);
    await assert.rejects(client.exportTransfer(), (error) => error.code === "PROTOCOL_VERSION_UNSUPPORTED");
    await assert.rejects(client.exportTransfer(), (error) => error.code === "REMOTE_INVALID_RESPONSE");
    await assert.rejects(client.exportTransfer(), (error) => error.code === "REMOTE_TIMEOUT" && error.details.timeout_ms === 100);
    assert.equal(call, 5, "transfer failures are not retried");
  });
});

test("login transport posts the password to the origin endpoint and returns the bearer in memory", async () => {
  let observed;
  await withServer(async (request, response) => {
    observed = { url: request.url, protocol: request.headers["x-climier-protocol-version"], body: await readJson(request) };
    response.writeHead(200, { "content-type": "application/json", "x-climier-protocol-version": "2" });
    response.end(JSON.stringify({ ok: true, token: "new-token", token_type: "Bearer", expires_in_days: 30 }));
  }, async (origin) => {
    assert.deepEqual(await loginRemote({ origin, password: "private-password" }), { token: "new-token", expires_in_days: 30 });
  });
  assert.deepEqual(observed, { url: "/v2/auth/login", protocol: "2", body: { password: "private-password" } });
});

test("remote failures never fall back to local execution", async () => {
  const server = createServer(() => {});
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  let localCalls = 0;
  const client = createBackendClient({
    projectDir: "/project", projectConfig: remoteConfig(origin), credentialStore: { async get() { return "token"; } },
    source: { registry: { lookup() { localCalls += 1; } }, mutate() { localCalls += 1; } },
  });
  await assert.rejects(client.readStatus(), (error) => error.code === "REMOTE_REQUEST_FAILED");
  assert.equal(localCalls, 0);
});
