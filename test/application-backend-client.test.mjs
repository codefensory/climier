import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createBackendClient } from "../src/application/operations/index.mjs";

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function localSource({ calls, result }) {
  return {
    registry: {
      lookup(operation) {
        calls.push({ kind: "lookup", operation });
        return { provider: { prepare() {}, apply() {} } };
      },
    },
    mutate(mutation) {
      calls.push({ kind: "mutate", mutation });
      return result;
    },
  };
}

test("backend client defaults to local and preserves operation dependencies and result", async () => {
  const calls = [];
  const result = { diff: { created: [{ id: "T-local" }] } };
  const client = createBackendClient({
    projectDir: "/project",
    projectConfig: { version: 1, project_id: "local-project" },
    source: localSource({ calls, result }),
  });

  assert.deepEqual(await client.executeOperation({
    actor: "alice",
    operation: "task.create",
    input: { id: "T-local" },
  }), result);
  assert.deepEqual(calls.map(({ kind }) => kind), ["lookup", "mutate"]);
  assert.equal(calls[1].mutation.projectDir, "/project");
  assert.deepEqual(calls[1].mutation.request, {
    action: "task.create",
    actor: "alice",
    input: { id: "T-local" },
  });
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
    for await (const chunk of request) chunks.push(chunk);
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
  });
});

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
      source: {
        registry: { lookup() { localCalls += 1; return { provider: { prepare() {}, apply() {} } }; } },
        mutate() { localCalls += 1; return {}; },
      },
    });
    await assert.rejects(client.executeOperation({
      actor: "alice",
      operation: "task.create",
      input: {},
    }), (error) => {
      assert.equal(error.code, "AUTH_REQUIRED");
      assert.equal(error.message, "server http: bearer token is required");
      assert.deepEqual(error.details, { project_id: "remote-project" });
      assert.equal(error.status, 401);
      return true;
    });
  });
  assert.equal(localCalls, 0);
});

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
    await assert.rejects(client.executeOperation({ actor: "alice", operation: "task.take", input: {} }), (error) => {
      assert.equal(error.code, "PROTOCOL_VERSION_UNSUPPORTED");
      assert.deepEqual(error.details, { expected: "1", received: "2" });
      return true;
    });
  });

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
    await assert.rejects(
      client.executeOperation({ actor: "alice", operation: "task.take", input: {} }),
      (error) => error.code === "REMOTE_INVALID_RESPONSE",
    );
  });
  assert.equal(localCalls, 0);
});

test("backend client times out remote requests and never falls back locally", async () => {
  let localCalls = 0;
  await withServer((_request, _response) => {}, async (url) => {
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: { project_id: "remote-project", backend: { type: "remote", url } },
      token: "test-token",
      timeoutMs: 20,
      source: {
        registry: { lookup() { localCalls += 1; return { provider: { prepare() {}, apply() {} } }; } },
        mutate() { localCalls += 1; return {}; },
      },
    });
    await assert.rejects(client.executeOperation({
      actor: "alice",
      operation: "task.create",
      input: {},
    }), (error) => error.code === "REMOTE_TIMEOUT");
  });
  assert.equal(localCalls, 0);
});
