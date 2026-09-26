import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";

import { createBackendClient } from "../src/application/backend-client.mjs";
import { createBuiltinOperationRegistry } from "../src/application/operations/builtins.mjs";
import { remoteV1Manifest } from "../src/application/operations/remote-v1-manifest.mjs";
import { initState } from "../src/kernel/state-operations.mjs";
import { createProjectCatalog } from "../src/server/catalog/index.mjs";
import { createRemoteApiServer } from "../src/server/http.mjs";
import { remoteV1CapabilityInventory } from "./fixtures/remote-v1-capability-inventory.mjs";

const EXPECTED_REMOTE_IDS = [
  "task.create", "task.update", "task.take", "task.release", "task.reopen", "task.cancel", "task.submit", "task.accept", "task.reject",
  "gate.create", "gate.update", "gate.resolve", "gate.reopen", "gate.cancel",
  "knowledge.create", "knowledge.update", "knowledge.deprecate",
  "edge.add", "edge.remove", "note.add", "initiative.create",
];

function sorted(values) {
  return values.toSorted();
}

function populatedFields(fields) {
  return Object.fromEntries(fields.map((field) => [field, null]));
}

async function withApi(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-remote-v1-conformance-"));
  const restoreHome = useClimierHome(root);
  const server = await createApiServer(root);
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await closeApiServer(server);
    restoreHome();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function useClimierHome(root) {
  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = path.join(root, "home");
  return () => {
    if (previousHome === undefined) { delete process.env.CLIMIER_HOME; }
    else { process.env.CLIMIER_HOME = previousHome; }
  };
}

async function createApiServer(root) {
  const catalog = createProjectCatalog({ dataRoot: path.join(root, "catalog"), projectIds: ["project-a"] });
  const projectDir = await catalog.provisionProject("project-a");
  await initState({ projectDir });
  const server = createRemoteApiServer({
    catalog,
    credentials: [{ token: "test-token", projectIds: ["project-a"] }],
    async openProject(storagePath) { return { projectDir: storagePath }; },
  });
  await listen(server);
  return server;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeApiServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function postOperation(baseUrl, operation, input) {
  return fetch(`${baseUrl}/v1/projects/project-a/operations`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "x-climier-protocol-version": "1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ operation, actor: "alice", input }),
  });
}

async function responseError(response) {
  const body = await response.json();
  assert.equal(body.ok, false);
  return body.error;
}

function assertCatalogSurface() {
  const registry = createBuiltinOperationRegistry();
  const catalogIds = ["task.create", "task.update", "task.take", "task.release", "task.reopen", "task.cancel", "task.submit", "task.accept", "task.reject",
    "gate.create", "gate.update", "gate.resolve", "gate.reopen", "gate.cancel", "knowledge.create", "knowledge.update", "knowledge.deprecate", "edge.add", "edge.remove", "note.add", "initiative.create"];
  const manifestIds = remoteV1Manifest.operations.map(({ id }) => id);
  assertManifestMatchesCatalog(manifestIds, catalogIds, registry);
  assertBatchCatalogProjection();
}

function assertManifestMatchesCatalog(manifestIds, catalogIds, registry) {
  assert.deepEqual(sorted(manifestIds), sorted(catalogIds));
  assert.equal(new Set(manifestIds).size, 21);
  assert.equal(registry.has("core.batch"), false);
  for (const operation of remoteV1Manifest.operations) {
    assertProviderBackedOperation(operation, registry);
  }
}

function assertProviderBackedOperation(operation, registry) {
  assert.deepEqual(Object.keys(operation).toSorted(), ["batch", "httpFields", "id"]);
  assert.deepEqual(operation, remoteV1CapabilityInventory.operations.find(({ id }) => id === operation.id));
  assert.equal(operation.batch, true);
  assert.ok(registry.lookup(operation.id)?.provider);
  assert.equal(hasCliMetadata(operation), false);
}

function hasCliMetadata(operation) {
  return ["target", "preRead", "pre_read", "resultLocator", "result_locator", "argv"]
    .some((field) => Object.hasOwn(operation, field));
}

function assertBatchCatalogProjection() {
  assert.deepEqual(remoteV1Manifest.batch, remoteV1CapabilityInventory.batch);
  assert.equal(remoteV1Manifest.batch.id, "core.batch");
  assert.deepEqual(remoteV1Manifest.batch.inputFields, ["operations", "if_state_revision"]);
  assert.deepEqual(remoteV1Manifest.batch.operationFields, ["op", "input"]);
  assert.equal(remoteV1Manifest.batch.nestedBatches, false);
  assert.deepEqual(sorted(remoteV1Manifest.batch.eligibleOperationIds), sorted(EXPECTED_REMOTE_IDS));
}

test("remote-v1 manifest conforms to the frozen capability inventory and provider catalog", () => {
  assert.equal(remoteV1Manifest.version, 1);
  assert.deepEqual(sorted(remoteV1Manifest.operations.map(({ id }) => id)), sorted(EXPECTED_REMOTE_IDS));
  assert.deepEqual(sorted(remoteV1Manifest.operations.map(({ id }) => id)), sorted(remoteV1CapabilityInventory.operations.map(({ id }) => id)));
  assertCatalogSurface();
});

async function assertRemoteOperations(client) {
  for (const { id } of remoteV1Manifest.operations) {
    assert.deepEqual(await client.executeOperation({ actor: "alice", operation: id, input: {} }), { accepted: true });
  }
}

async function assertRemoteBatch(client) {
  const operations = remoteV1Manifest.batch.eligibleOperationIds.map((op) => ({ op, input: {} }));
  assert.deepEqual(await client.executeBatch({ actor: "alice", operations, if_state_revision: 7 }), { accepted: true });
}

async function assertRemoteFailures(client) {
  await assertUnsupportedOperations(client);
  await assertUnsupportedBatchEntries(client);
}

async function assertUnsupportedOperations(client) {
  for (const operation of ["core.batch", "plugin.custom", "not-in-the-manifest"]) {
    await assert.rejects(client.executeOperation({ actor: "alice", operation, input: {} }), unsupportedOperation(operation));
  }
}

async function assertUnsupportedBatchEntries(client) {
  for (const op of ["core.batch", "plugin.custom"]) {
    await assert.rejects(client.executeBatch({ actor: "alice", operations: [{ op, input: {} }] }), unsupportedOperation(op));
  }
}

function unsupportedOperation(operation) {
  return (error) => error.code === "REMOTE_UNSUPPORTED_OPERATION" && error.details.operation === operation;
}

test("remote client advertises exactly manifest operations, keeps batch separate, and fails closed", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push(await requestBody(request));
    response.writeHead(200, { "content-type": "application/json", "x-climier-protocol-version": "1" });
    response.end(JSON.stringify({ ok: true, result: { accepted: true } }));
  });
  await listen(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const restoreOrigin = approveRemoteOrigin(url);
  const localCalls = await exerciseRemoteBackend(url);
  await closeApiServer(server);
  restoreOrigin();
  assert.equal(localCalls, 0, "unsupported remote requests must not fall back to local execution");
  assert.deepEqual(requests, [
    ...remoteV1Manifest.operations.map(({ id: operation }) => ({ operation, actor: "alice", input: {} })),
    {
      operation: "core.batch",
      actor: "alice",
      input: {
        operations: remoteV1Manifest.batch.eligibleOperationIds.map((op) => ({ op, input: {} })),
        if_state_revision: 7,
      },
    },
  ]);

  await assertLocalExtensionOperation();
});

async function assertLocalExtensionOperation() {
  let localOperation;
  const localClient = createBackendClient({
    projectDir: "/project",
    projectConfig: { project_id: "local-project" },
    source: {
      registry: { lookup(operation) { localOperation = operation; return { provider: { prepare() {}, apply() {} } }; } },
      mutate() { return { local: true }; },
    },
  });
  assert.deepEqual(await localClient.executeOperation({ actor: "alice", operation: "plugin.local", input: {} }), { local: true });
  assert.equal(localOperation, "plugin.local", "local extension operations remain available outside remote-v1");
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) { chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function approveRemoteOrigin(url) {
  const previousOrigin = process.env.CLIMIER_REMOTE_ORIGIN;
  process.env.CLIMIER_REMOTE_ORIGIN = new URL(url).origin;
  return () => {
    if (previousOrigin === undefined) { delete process.env.CLIMIER_REMOTE_ORIGIN; }
    else { process.env.CLIMIER_REMOTE_ORIGIN = previousOrigin; }
  };
}

async function exerciseRemoteBackend(url) {
  let localCalls = 0;
  const client = createBackendClient({
    projectDir: "/project",
    projectConfig: { project_id: "remote-project", backend: { type: "remote", url } },
    source: {
      registry: { lookup() { localCalls += 1; return { provider: { prepare() {}, apply() {} } }; } },
      mutate() { localCalls += 1; return {}; },
    },
  });
  await assertRemoteOperations(client);
  await assertRemoteBatch(client);
  await assertRemoteFailures(client);
  return localCalls;
}

test("HTTP v1 allowlist and nested batch surface exactly match manifest fields", async () => {
  await withApi(async (baseUrl) => {
    await assertOperationAllowlist(baseUrl);
    await assertBatchAllowlist(baseUrl);
    await assertUnknownBatchInputs(baseUrl);
  });
});

async function assertOperationAllowlist(baseUrl) {
  for (const { id, httpFields } of remoteV1Manifest.operations) {
    await assertOperationActorRejected(baseUrl, id, httpFields);
    await assertOperationUnknownFieldRejected(baseUrl, id, httpFields);
  }
}

async function assertOperationActorRejected(baseUrl, id, httpFields) {
  const response = await postOperation(baseUrl, id, {
    ...populatedFields(httpFields),
    actor: "forbidden-adaptation-override",
  });
  assert.equal(response.status, 400, `${id} is recognized and deep validation rejects actor`);
  const error = await responseError(response);
  assert.equal(error.code, "INVALID_REQUEST");
  assert.match(error.message, /actor.*not allowed/);
  assert.ok(error.message.includes(id));
  assert.deepEqual(error.details, { field: "input.actor", operation: id });
}

async function assertOperationUnknownFieldRejected(baseUrl, id, httpFields) {
  const response = await postOperation(baseUrl, id, {
    ...populatedFields(httpFields),
    conformance_unknown: null,
  });
  assert.equal(response.status, 400, `${id} rejects fields outside its manifest surface`);
  const error = await responseError(response);
  assert.equal(error.code, "INVALID_REQUEST");
  assert.deepEqual(error.details, { field: "input.conformance_unknown", operation: id });
}

async function assertBatchAllowlist(baseUrl) {
  for (const { id, httpFields } of remoteV1Manifest.operations) {
    await assertBatchOperationActorRejected(baseUrl, id, httpFields);
  }
}

async function assertBatchOperationActorRejected(baseUrl, id, httpFields) {
  const response = await postOperation(baseUrl, "core.batch", {
    operations: [{ op: id, input: { ...populatedFields(httpFields), actor: "forbidden-adaptation-override" } }],
    if_state_revision: 0,
  });
  assert.equal(response.status, 400, `${id} is batch eligible and deep validation rejects actor`);
  const error = await responseError(response);
  assert.equal(error.code, "INVALID_REQUEST");
  assert.equal(error.details.field, "input.operations[0].input.actor");
}

async function assertUnknownBatchInputs(baseUrl) {
  await assertUnknownEnvelopeFieldRejected(baseUrl);
  await assertUnknownBatchEntryFieldRejected(baseUrl);
  await assertNestedBatchRejected(baseUrl);
}

async function assertUnknownEnvelopeFieldRejected(baseUrl) {
  const response = await postOperation(baseUrl, "core.batch", {
    operations: [{ op: "initiative.create", input: { name: "x" } }],
    unexpected: true,
  });
  assert.equal(response.status, 400);
  assert.deepEqual((await responseError(response)).details, { field: "input.unexpected", operation: "core.batch" });
}

async function assertUnknownBatchEntryFieldRejected(baseUrl) {
  const response = await postOperation(baseUrl, "core.batch", {
    operations: [{ op: "initiative.create", input: { name: "x" }, unexpected: true }],
  });
  assert.equal(response.status, 400);
  assert.equal((await responseError(response)).details.field, "input.operations[0].unexpected");
}

async function assertNestedBatchRejected(baseUrl) {
  const response = await postOperation(baseUrl, "core.batch", {
    operations: [{ op: "core.batch", input: { operations: [] } }],
  });
  assert.equal(response.status, 400);
  assert.equal((await responseError(response)).details.field, "input.operations[0].op");
}
