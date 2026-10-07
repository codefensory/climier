import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createBackendClient as createRawBackendClient, REMOTE_PROTOCOL_VERSION } from "../src/application/operations/index.ts";
import { loginRemote } from "../src/application/backend-remote-transport.ts";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BackendClient, ProjectConfig, SourceInput } from "../src/application/types.ts";

type ClientOptions = NonNullable<Parameters<typeof createRawBackendClient>[0]>;
type CredentialStore = NonNullable<ClientOptions["credentialStore"]>;
type TestBackendClient = BackendClient & {
  exportTransfer: () => Promise<unknown>;
  importTransfer: (options: Record<string, unknown>) => Promise<unknown>;
  readStatus: () => Promise<unknown>;
};
type TestError = { code?: string; status?: number; details?: Record<string, unknown> };

const asTestError = (error: unknown): TestError => error as TestError;
const asCredentialStore = (store: object): CredentialStore => store as CredentialStore;
const asSource = (source: object): SourceInput => source as SourceInput;

function testBackendClient(options: ClientOptions): TestBackendClient {
  return createRawBackendClient(options) as TestBackendClient;
}

function createBackendClient(options: ClientOptions): TestBackendClient {
  return testBackendClient(options);
}

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  run: (origin: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  try { await run(origin); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function remoteConfig(origin: string): ProjectConfig {
  return { project_id: "project/opaque", backend: { type: "remote", url: origin } };
}

function jsonResponse(response: ServerResponse, result: unknown) {
  response.writeHead(200, { "content-type": "application/json", "x-climier-protocol-version": "1" });
  response.end(JSON.stringify({ ok: true, result }));
}

async function withInsecureRemoteHttp(run: () => Promise<void>): Promise<void> {
  const previousFetch = globalThis.fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("backend client keeps local execution unchanged", async () => {
  const calls: string[] = [];
  const result = { diff: { created: [] } };
  const client = createBackendClient({
    projectDir: "/project",
    projectConfig: { version: 1, project_id: "local-project" },
    source: asSource({
      registry: { lookup(operation) { calls.push(String(operation)); return { provider: { prepare() {}, apply() {} } }; } },
      mutate(request: unknown) {
        const mutation = request as { request: { action: string } };
        calls.push(mutation.request.action);
        return result;
      },
    }),
  });
  assert.equal(await client.executeOperation({ actor: "alice", operation: "task.create", input: {} }), result);
  assert.equal(client.exportTransfer, undefined);
  assert.equal(client.importTransfer, undefined);
  assert.deepEqual(calls, ["task.create", "task.create"]);
});

test("remote client uses protocol v1 and only the profile bearer for its origin", async () => {
  const requests: Array<Record<string, unknown>> = [];
  await withServer(async (request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization, protocol: request.headers["x-climier-protocol-version"], body: await readJson(request) });
    jsonResponse(response, { accepted: true });
  }, async (origin) => {
    const lookedUp: string[] = [];
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: remoteConfig(origin),
      credentialStore: asCredentialStore({ async get(value: string) { lookedUp.push(value); return "profile-token"; } }),
    });
    assert.deepEqual(await client.executeOperation({ actor: "alice", operation: "task.create", input: { id: "T1" } }), { accepted: true });
    assert.deepEqual(lookedUp, [origin]);
  });
  assert.equal(REMOTE_PROTOCOL_VERSION, "1");
  assert.deepEqual(requests, [{
    url: "/v1/projects/project%2Fopaque/operations",
    authorization: "Bearer profile-token",
    protocol: "1",
    body: { operation: "task.create", actor: "alice", input: { id: "T1" } },
  }]);
});

test("remote client exports and imports transfers through authenticated v1 endpoints", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const payload = { version: 1, nodes: {}, edges: [], initiatives: {}, log: [] };
  await withServer(async (request, response) => {
    const observed: Record<string, unknown> = {
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
      credentialStore: asCredentialStore({ async get() { return "profile-token"; } }),
    });
    assert.deepEqual(await client.exportTransfer(), { payload, revision: 13 });
    assert.deepEqual(await client.importTransfer({
      payload,
      actor: "alice",
      expected_remote_revision: 13,
      force: false,
      ignored: "must-not-be-sent",
    }), { revision: 14 });
    assert.deepEqual(await client.importTransfer({
      payload,
      actor: "alice",
      expected_remote_revision: 13,
      force: true,
    }), { revision: 14 });
  });
  assert.deepEqual(requests, [
    {
      method: "GET",
      url: "/v1/projects/project%2Fopaque/transfer/export",
      authorization: "Bearer profile-token",
      protocol: "1",
    },
    {
      method: "POST",
      url: "/v1/projects/project%2Fopaque/transfer/import",
      authorization: "Bearer profile-token",
      protocol: "1",
      body: { payload, actor: "alice", expected_remote_revision: 13, force: false },
    },
    {
      method: "POST",
      url: "/v1/projects/project%2Fopaque/transfer/import",
      authorization: "Bearer profile-token",
      protocol: "1",
      body: { payload, actor: "alice", force: true },
    },
  ]);
});

test("HTTP remote clients use each project's configured origin and matching profile bearer", async () => {
  await withInsecureRemoteHttp(async () => {
    const origins = ["http://remote-one.example.test:43128", "http://remote-two.example.test:43128"];
    const sessions = new Map(origins.map((origin, index) => [origin, `profile-token-${index + 1}`]));
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), authorization: new Headers(options?.headers).get("authorization") });
      return new Response(JSON.stringify({ ok: true, result: { ready: [] } }), {
        status: 200,
        headers: { "content-type": "application/json", "x-climier-protocol-version": "1" },
      });
    };
    for (const origin of origins) {
      const client = createBackendClient({
        projectDir: "/project",
        projectConfig: remoteConfig(origin),
        credentialStore: asCredentialStore({ async get(value: string) { return sessions.get(value) ?? null; } }),
      });
      assert.deepEqual(await client.readStatus(), { ready: [] });
    }
    assert.deepEqual(requests, origins.map((origin, index) => ({
      url: `${origin}/v1/projects/project%2Fopaque/read/status`,
      authorization: `Bearer profile-token-${index + 1}`,
    })));
  });
});

test("remote clients validate the response protocol before status or body, including errors", async () => {
  await withInsecureRemoteHttp(async () => {
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: remoteConfig("http://remote.example.test"),
      credentialStore: asCredentialStore({ async get() { return "profile-token"; } }),
    });
    for (const protocol of [null, "2"]) {
      globalThis.fetch = async () => new Response("not-json", {
        status: 401,
        headers: protocol === null ? {} : { "x-climier-protocol-version": protocol },
      });
      await assert.rejects(client.readStatus(), (error) => asTestError(error).code === "PROTOCOL_VERSION_UNSUPPORTED");
      await assert.rejects(loginRemote({ origin: "http://remote.example.test", password: "private-password" }), (error) => asTestError(error).code === "PROTOCOL_VERSION_UNSUPPORTED");
    }
  });
});

test("legacy token environment variable never authenticates remote requests", async () => {
  const previousToken = process.env.CLIMIER_TOKEN;
  process.env.CLIMIER_TOKEN = "legacy-secret";
  try {
    await withServer((request, response) => {
      assert.equal(request.headers.authorization, undefined);
      jsonResponse(response, {});
    }, async (origin) => {
      const client = createBackendClient({ projectDir: "/project", projectConfig: remoteConfig(origin), credentialStore: asCredentialStore({ async get() { return null; } }) });
      await client.readStatus();
    });
  } finally {
    if (previousToken === undefined) {delete process.env.CLIMIER_TOKEN;} else {process.env.CLIMIER_TOKEN = previousToken;}
  }
});

test("remote transfer methods preserve HTTP, protocol, and timeout errors", async () => {
  const payload = { version: 1, nodes: {}, edges: [], initiatives: {}, log: [] };
  let call = 0;
  await withServer((request, response) => {
    call += 1;
    if (call === 1) {
      response.writeHead(401, { "content-type": "application/json", "x-climier-protocol-version": "1" });
      response.end(JSON.stringify({ ok: false, error: { code: "AUTH_REQUIRED", message: "login required", details: { profile: "missing" } } }));
    } else if (call === 2) {
      response.writeHead(409, { "content-type": "application/json", "x-climier-protocol-version": "1" });
      response.end(JSON.stringify({ ok: false, error: { code: "TRANSFER_REMOTE_CHANGED", message: "remote changed", details: { expected: 3, current: 4 } } }));
    } else if (call === 3) {
      response.writeHead(200, { "content-type": "application/json", "x-climier-protocol-version": "2" });
      response.end(JSON.stringify({ ok: true, result: { payload, revision: 3 } }));
    } else if (call === 4) {
      jsonResponse(response, { payload: [], revision: 3 });
    }
  }, async (origin) => {
    const client = createBackendClient({
      projectDir: "/project",
      projectConfig: remoteConfig(origin),
      credentialStore: asCredentialStore({ async get() { return "profile-token"; } }),
      timeoutMs: 100,
    });
    await assert.rejects(client.exportTransfer(), (error) => {
      const caught = asTestError(error);
      return caught.code === "AUTH_REQUIRED" && caught.status === 401 && caught.details?.profile === "missing";
    });
    await assert.rejects(client.importTransfer({ payload, actor: "alice" }), (error) => {
      const caught = asTestError(error);
      return caught.code === "TRANSFER_REMOTE_CHANGED" && caught.status === 409 && caught.details?.current === 4;
    });
    await assert.rejects(client.exportTransfer(), (error) => asTestError(error).code === "PROTOCOL_VERSION_UNSUPPORTED");
    await assert.rejects(client.exportTransfer(), (error) => asTestError(error).code === "REMOTE_INVALID_RESPONSE");
    await assert.rejects(client.exportTransfer(), (error) => {
      const caught = asTestError(error);
      return caught.code === "REMOTE_TIMEOUT" && caught.details?.timeout_ms === 100;
    });
    assert.equal(call, 5, "transfer failures are not retried");
  });
});

test("login transport posts the password to the origin endpoint and returns the bearer in memory", async () => {
  let observed;
  await withServer(async (request, response) => {
    observed = { url: request.url, protocol: request.headers["x-climier-protocol-version"], body: await readJson(request) };
    response.writeHead(200, { "content-type": "application/json", "x-climier-protocol-version": "1" });
    response.end(JSON.stringify({ ok: true, token: "new-token", token_type: "Bearer", expires_in_days: 30 }));
  }, async (origin) => {
    assert.deepEqual(await loginRemote({ origin, password: "private-password" }), { token: "new-token", expires_in_days: 30 });
  });
  assert.deepEqual(observed, { url: "/v1/auth/login", protocol: "1", body: { password: "private-password" } });
});

test("remote failures never fall back to local execution", async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  let localCalls = 0;
  const client = createBackendClient({
    projectDir: "/project", projectConfig: remoteConfig(origin), credentialStore: asCredentialStore({ async get() { return "token"; } }),
    source: asSource({ registry: { lookup() { localCalls += 1; } }, mutate() { localCalls += 1; } }),
  });
  await assert.rejects(client.readStatus(), (error) => asTestError(error).code === "REMOTE_REQUEST_FAILED");
  assert.equal(localCalls, 0);
});
