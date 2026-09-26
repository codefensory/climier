import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createBackendClient } from "../src/application/operations/index.mjs";

async function withServer(handler, run, { approveOrigin = false } = {}) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const previousOrigin = process.env.CLIMIER_REMOTE_ORIGIN;
  if (approveOrigin) {
    process.env.CLIMIER_REMOTE_ORIGIN = new URL(url).origin;
  } else {
    delete process.env.CLIMIER_REMOTE_ORIGIN;
  }
  try {
    await run(url);
  } finally {
    if (previousOrigin === undefined) {
      delete process.env.CLIMIER_REMOTE_ORIGIN;
    } else {
      process.env.CLIMIER_REMOTE_ORIGIN = previousOrigin;
    }
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

test("backend client exposes typed transfer export and import requests", async () => {
  const requests = [];
  const payload = { version: 4, revision: 0, nodes: {}, edges: [], initiatives: {}, log: [] };
  await withServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) { chunks.push(chunk); }
    requests.push({ method: request.method, url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json", "x-climier-protocol-version": "1" });
    response.end(JSON.stringify({ ok: true, result: request.url.endsWith("export") ? payload : { installed: true } }));
  }, async (url) => {
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: { project_id: "remote-project", backend: { type: "remote", url } },
      token: "transfer-token",
      remoteOrigin: new URL(url).origin,
    });
    assert.deepEqual(await client.exportTransfer(), payload);
    assert.deepEqual(await client.importTransfer({ payload, actor: "alice", overwrite: true }), { installed: true });
  }, { approveOrigin: true });
  assert.deepEqual(requests, [
    { method: "POST", url: "/v1/projects/remote-project/transfer/export", body: {} },
    { method: "POST", url: "/v1/projects/remote-project/transfer/import", body: { payload, actor: "alice", overwrite: true } },
  ]);
});

test("backend client maps an ambiguous timed-out push without retrying", async () => {
  const requests = [];
  let observeRequest;
  const requestObserved = new Promise((resolve) => { observeRequest = resolve; });
  let releaseResponse;
  const responseHeld = new Promise((resolve) => { releaseResponse = resolve; });

  await withServer(async (request, response) => {
    requests.push(await requestDetails(request));
    observeRequest(requests[0]);

    // Hold the response until the client times out, simulating a lost reply
    // only after the server has consumed the complete push request.
    await responseHeld;
    response.destroy();
  }, async (url) => {
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: { project_id: "remote-project", backend: { type: "remote", url } },
      timeoutMs: 1000,
    });
    const pushOutcome = client.importTransfer({ payload: {}, actor: "alice" }).then(
      settledPushOutcome("fulfilled"),
      settledPushOutcome("rejected"),
    );

    try {
      const firstEvent = await Promise.race([
        requestObserved.then(observedRequest),
        pushOutcome,
      ]);
      assert.equal(firstEvent.kind, "observed", "push must reach and be consumed by the server before timeout");
      assert.deepEqual(firstEvent.request, {
        method: "POST",
        url: "/v1/projects/remote-project/transfer/import",
        body: { payload: {}, actor: "alice", overwrite: false },
      });

      const outcome = await pushOutcome;
      assertTransferOutcomeUnknown(outcome);
      assert.equal(requests.length, 1, "ambiguous push must not be retried");
    } finally {
      releaseResponse();
    }
  });
});

test("backend client initializes the configured remote project through the typed init endpoint", async () => {
  let requestBody;
  await withServer(async (request, response) => {
    assertInitRequest(request);
    requestBody = await readRequestBody(request);
    response.writeHead(200, {
      "content-type": "application/json",
      "x-climier-protocol-version": "1",
    });
    response.end(JSON.stringify({ ok: true, result: { seeded: null } }));
  }, async (url) => {
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: { project_id: "project/opaque", backend: { type: "remote", url } },
    });
    assert.deepEqual(await client.init(), { seeded: null });
  });
  assert.deepEqual(requestBody, {});
});

async function assertOriginBindingsRejected(url, remoteOrigins) {
  for (const remoteOrigin of remoteOrigins) {
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: { project_id: "remote-project", backend: { type: "remote", url } },
      token: "sensitive-token",
      remoteOrigin,
    });
    await assert.rejects(client.readStatus(), originNotApproved);
  }
}

function originNotApproved(error) {
  return error.code === "REMOTE_ORIGIN_NOT_APPROVED";
}

function settledPushOutcome(kind) {
  return (value) => ({ kind, [kind === "fulfilled" ? "value" : "error"]: value });
}

function observedRequest(request) {
  return { kind: "observed", request };
}

function assertTransferOutcomeUnknown(outcome) {
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.error.code, "TRANSFER_OUTCOME_UNKNOWN");
  assert.deepEqual(outcome.error.details, { applied: "unknown", timeout_ms: 1000 });
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) { chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requestDetails(request) {
  return readRequestBody(request).then((body) => ({ method: request.method, url: request.url, body }));
}

function assertInitRequest(request) {
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v1/projects/project%2Fopaque/init");
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.headers["x-climier-protocol-version"], "1");
}

test("backend client refuses to send a bearer token when origin binding is absent or differs", async () => {
  let requests = 0;
  await withServer((_request, response) => {
    requests += 1;
    response.writeHead(200, {
      "content-type": "application/json",
      "x-climier-protocol-version": "1",
    });
    response.end(JSON.stringify({ ok: true, result: {} }));
  }, async (url) => {
    const remoteOrigins = [undefined, "http://127.0.0.1:1"];
    await assertOriginBindingsRejected(url, remoteOrigins);
  });
  assert.equal(requests, 0);
});

test("backend client allows opt-in remote HTTP only with exact origin binding", async () => {
  const previousOptIn = process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
  const previousFetch = globalThis.fetch;
  const requested = [];
  process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = "true";
  globalThis.fetch = async (url, options) => {
    requested.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name === "x-climier-protocol-version" ? "1" : null },
      json: async () => ({ ok: true, result: { status: "ok" } }),
    };
  };
  try {
    const httpUrl = "http://internal.example.test:4312";
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: { project_id: "remote-project", backend: { type: "remote", url: httpUrl } },
      token: "internal-token",
      remoteOrigin: new URL(httpUrl).origin,
    });

    assert.equal(client.type, "remote");
    assert.equal(client.insecureRemoteHttp, true);
    assert.deepEqual(await client.readStatus(), { status: "ok" });
    assert.equal(requested.length, 1);
    assert.equal(requested[0].url, "http://internal.example.test:4312/v1/projects/remote-project/read/status");
    assert.equal(requested[0].options.headers.authorization, "Bearer internal-token");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousOptIn === undefined) { delete process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP; }
    else { process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = previousOptIn; }
  }
});

test("backend client rejects remote HTTP with missing or inexact opt-in and never requests", async () => {
  const previousOptIn = process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error("remote HTTP must be rejected before a request");
  };
  try {
    for (const value of [undefined, "false", "TRUE", "true "]) {
      if (value === undefined) { delete process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP; }
      else { process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = value; }
      assert.throws(() => createBackendClient({
        projectDir: "/project",
        projectConfig: { project_id: "remote-project", backend: { type: "remote", url: "http://internal.example.test" } },
      }), /backend config: remote url must use HTTPS outside localhost/);
    }
    process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = "true";
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: { project_id: "remote-project", backend: { type: "remote", url: "http://internal.example.test" } },
      token: "internal-token",
    });
    await assert.rejects(client.readStatus(), originNotApproved);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousOptIn === undefined) { delete process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP; }
    else { process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = previousOptIn; }
  }
});

test("backend client reports network failures without invoking local execution", async () => {
  const server = createServer(() => {});
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  let localCalls = 0;
  const client = createBackendClient({
    projectDir: "/project",
    projectConfig: { project_id: "remote-project", backend: { type: "remote", url: `http://127.0.0.1:${port}` } },
    source: {
      registry: { lookup() { localCalls += 1; return { provider: { prepare() {}, apply() {} } }; } },
      mutate() { localCalls += 1; return {}; },
    },
  });
  await assert.rejects(client.readStatus(), (error) => error.code === "REMOTE_REQUEST_FAILED");
  assert.equal(localCalls, 0);
});

function remoteTimeout(error) {
  return error.code === "REMOTE_TIMEOUT";
}

test("backend client times out remote requests and never falls back locally", async () => {
  let localCalls = 0;
  await withServer((_request, _response) => {}, async (url) => {
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: { project_id: "remote-project", backend: { type: "remote", url } },
      token: "test-token",
      remoteOrigin: new URL(url).origin,
      timeoutMs: 20,
      source: {
        registry: { lookup() { localCalls += 1; return { provider: { prepare() {}, apply() {} } }; } },
        mutate() { localCalls += 1; return {}; },
      },
    });
    await assert.rejects(client.readStatus({ initiative: "remote-only" }), remoteTimeout);
  });
  assert.equal(localCalls, 0);
});
