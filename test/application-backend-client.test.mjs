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
