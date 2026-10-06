import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createProjectCatalog } from "../../../src/server/catalog/index.ts";
import { createRemoteApiServer } from "../../../src/server/http.ts";
import { dispatchOperationRequest, validateOperationRequest } from "../../../src/server/http/operations.ts";
import { remoteV1Manifest } from "../../../src/application/operations/remote-v1-manifest.ts";
import { bootstrapFencedState } from "../../../src/storage/ledger.ts";
import { authHeaders, operation, testAuthStore, withApi } from "./fixtures.mjs";


async function assertCreatedTaskProjection(baseUrl) {
  const status = await fetch(`${baseUrl}/v1/projects/project-a/read/status`, { headers: authHeaders() });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.ok, true);
  assert.equal(statusBody.result.summary.ready, 1);
  assert.deepEqual(statusBody.result.tasks.ready.map((task) => task.id), ["T-remote-1"]);

  const node = await fetch(`${baseUrl}/v1/projects/project-a/read/nodes/T-remote-1`, { headers: authHeaders() });
  assert.equal(node.status, 200);
  const nodeBody = await node.json();
  assert.equal(nodeBody.result.node.title, "Remote task");
  assert.equal(nodeBody.result.derived_status, "ready");
  assert.deepEqual(nodeBody.result.blocking, []);
}

test("HTTP v1 delegates core operations and read projections through server boundaries", async () => {
  await withApi(async ({ baseUrl }) => {
    const createdInitiative = await operation(baseUrl, "project-a", "initiative.create", {
      name: "remote",
      desc: "Created by the server kernel",
    });
    assert.equal(createdInitiative.status, 200, JSON.stringify(await createdInitiative.clone().json()));
    assert.equal((await createdInitiative.json()).result.result.name, "remote");

    const createdTask = await operation(baseUrl, "project-a", "task.create", {
      id: "T-remote-1",
      initiative: "remote",
      title: "Remote task",
      body: "Created through Application Operations",
      acceptance: "Visible in the read model",
    });
    assert.equal(createdTask.status, 200);

    await assertCreatedTaskProjection(baseUrl);
  });
});

async function assertGateHasCanonicalEdges(projectDirs) {
  const { readState } = await import("../../../src/storage/state.ts");
  const state = await readState(projectDirs[0]);
  assert.deepEqual(state.edges.filter((edge) => edge.from === "G-http-edges" || edge.to === "G-http-edges"), [
    { from: "T-gate-http-source", to: "G-http-edges", type: "BLOCKS" },
    { from: "G-http-edges", to: "T-gate-http-source", type: "DERIVED_FROM" },
  ]);
}

async function assertEmptyGateBlockers(projectDirs) {
  const { readState } = await import("../../../src/storage/state.ts");
  const state = await readState(projectDirs[0]);
  assert.equal(state.nodes["G-http-empty-blockers"].id, "G-http-empty-blockers");
}

async function assertInvalidGateInputs(baseUrl, openCount) {
  for (const extra of [{ resolution_mode: "labor" }, { unexpected: true }]) {
    const opensBefore = openCount();
    const invalid = await operation(baseUrl, "project-a", "gate.create", {
      id: "G-http-invalid", initiative: "gate-http", title: "Invalid gate input",
      body: "Must fail at the HTTP boundary", purpose: "approval", ...extra,
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "INVALID_REQUEST");
    assert.equal(openCount(), opensBefore, "invalid schema must be rejected before storage is opened");
  }
}

test("HTTP gate.create accepts canonical edge inputs and rejects fields before storage", async () => {
  await withApi(async ({ baseUrl, openCount, projectDirs }) => {
    const initiative = await operation(baseUrl, "project-a", "initiative.create", { name: "gate-http" });
    assert.equal(initiative.status, 200, JSON.stringify(await initiative.clone().json()));

    const task = await operation(baseUrl, "project-a", "task.create", {
      id: "T-gate-http-source",
      initiative: "gate-http",
      title: "Gate source",
      body: "Existing source node",
      acceptance: "Can be referenced by a gate",
    });
    assert.equal(task.status, 200, JSON.stringify(await task.clone().json()));

    const gate = await operation(baseUrl, "project-a", "gate.create", {
      id: "G-http-edges",
      initiative: "gate-http",
      title: "Gate with edges",
      body: "Accept canonical edge inputs",
      purpose: "approval",
      blocked_by: ["T-gate-http-source"],
      derived_from: ["T-gate-http-source"],
    });
    assert.equal(gate.status, 200, JSON.stringify(await gate.clone().json()));
    await assertGateHasCanonicalEdges(projectDirs);

    const emptyBlockers = await operation(baseUrl, "project-a", "gate.create", {
      id: "G-http-empty-blockers",
      initiative: "gate-http",
      title: "Gate without blockers",
      body: "Empty blocker lists are normal input",
      purpose: "approval",
      blocked_by: [],
    });
    assert.equal(emptyBlockers.status, 200, JSON.stringify(await emptyBlockers.clone().json()));
    await assertEmptyGateBlockers(projectDirs);
    await assertInvalidGateInputs(baseUrl, openCount);
  });
});

function httpError(code, message, details, status) {
  const error = Object.assign(new Error(message), { code, status });
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function assertCommittedBatchState(state, before) {
  assert.equal(state.nodes["T-batch-remote"].title, "Batch task");
  assert.equal(state.initiatives["batch-remote"].desc, "Created in batch");
  assert.equal(state.revision, before.revision + 1);
  assert.equal(state.log.length, 1);
  assert.equal(state.log[0].action, "core.batch");
}

async function assertFailedBatchIsAtomic(baseUrl, projectDir, expectedRevision) {
  const invalidDomainInput = await operation(baseUrl, "project-a", "core.batch", {
    operations: [{ op: "initiative.create", input: { name: "bad/name" } }],
  });
  assert.equal(invalidDomainInput.status, 400);
  assert.equal((await invalidDomainInput.json()).error.code, "BATCH_OPERATION_FAILED");
  const { readState } = await import("../../../src/storage/state.ts");
  const unchanged = await readState(projectDir);
  assert.equal(unchanged.revision, expectedRevision);
  assert.deepEqual(Object.keys(unchanged.initiatives), ["batch-remote"]);
}

test("HTTP v1 executes core.batch through one canonical server mutation", async () => {
  await withApi(async ({ baseUrl, projectDirs }) => {
    const { readState } = await import("../../../src/storage/state.ts");
    await bootstrapFencedState(projectDirs[0]);
    const before = await readState(projectDirs[0]);
    const response = await operation(baseUrl, "project-a", "core.batch", {
      operations: [
        { op: "initiative.create", input: { name: "batch-remote", desc: "Created in batch" } },
        { op: "task.create", input: {
          id: "T-batch-remote",
          initiative: "batch-remote",
          title: "Batch task",
          body: "Created by server batch",
          acceptance: "Visible after batch",
        } },
      ],
      if_state_revision: before.revision,
    });

    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.results.length, 2);
    assert.equal(body.result.revision_before, before.revision);
    assert.equal(body.result.revision_after, before.revision + 1);
    const after = await readState(projectDirs[0]);
    assertCommittedBatchState(after, before);
    await assertFailedBatchIsAtomic(baseUrl, projectDirs[0], after.revision);
  });
});

test("HTTP operation module accepts manifest capabilities and receives complete source at dispatch", async () => {
  const request = validateOperationRequest({ operation: "initiative.create", actor: "alice", input: { name: "valid" } }, {
    manifest: remoteV1Manifest,
    httpError,
  });
  const calls = [];
  const source = { registry: { lookup() {} }, mutate() {}, selectPolicy() {}, authorizeAction() {} };
  const result = await dispatchOperationRequest({
    projectDir: "/trusted/project",
    body: request,
    source,
    manifest: remoteV1Manifest,
    executeOperation: async (args) => { calls.push(args); return { ok: true }; },
    executeBatch: async () => { throw new Error("unexpected batch dispatch"); },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, source);
  assert.equal(calls[0].operation, "initiative.create");
  assert.equal(calls[0].projectDir, "/trusted/project");
});

test("HTTP v1 dispatches operations with the complete server-owned source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-operation-source-"));
  try {
    const catalog = createProjectCatalog({ dataRoot: path.join(root, "catalog") });
    const projectDir = await catalog.provisionProject("project-a");
    const calls = [];
    const provider = { prepare() {}, apply() {} };
    const server = createRemoteApiServer({
      catalog,
      authStore: testAuthStore,
      registry: { lookup(operationId) { calls.push(["lookup", operationId]); return { provider }; } },
      mutate: async (mutation) => { calls.push(["mutate", mutation]); return { marker: "server-mutation" }; },
      selectPolicy: async (context) => { calls.push(["policy", context.projectDir]); return null; },
      authorizeAction: async () => { throw new Error("unexpected policy authorization"); },
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await operation(baseUrl, "project-a", "initiative.create", { name: "injected-source" });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).result, { marker: "server-mutation" });
      assert.deepEqual(calls.map(([kind]) => kind), ["lookup", "policy", "mutate"]);
      assert.equal(calls[1][1], projectDir);
      assert.equal(calls[2][1].provider, provider);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function assertInvalidActor(baseUrl) {
  const invalidActor = await fetch(`${baseUrl}/v1/projects/project-a/operations`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ operation: "core.batch", actor: "", input: { operations: [{ op: "initiative.create", input: { name: "valid" } }] } }),
  });
  assert.equal(invalidActor.status, 400);
  assert.equal((await invalidActor.json()).error.code, "INVALID_REQUEST");
}

test("HTTP v1 validates core.batch schema and nested operation inputs before opening storage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-batch-schema-"));
  try {
    const catalog = createProjectCatalog({ dataRoot: path.join(root, "catalog") });
    let openCount = 0;
    const server = createRemoteApiServer({
      catalog,
      authStore: testAuthStore,
      async openProject(projectDir) { openCount += 1; return { projectDir }; },
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const invalidInputs = [
        { operations: [] },
        { operations: [{ op: "initiative.create", input: [] }] },
        { operations: [{ op: "filesystem.read", input: { path: "tasks.json" } }] },
        { operations: [{ op: "initiative.create", input: { name: "valid" }, extra: "not allowed" }] },
        { operations: [{ op: "initiative.create", input: { name: "valid" }, provider: { prepare: "untrusted" } }] },
        { operations: [{ op: "initiative.create", input: { name: "valid", handler: "arbitrary" } }] },
        { operations: [{ op: "initiative.create", input: { name: "valid", unexpected: true } }] },
        { operations: [{ op: "initiative.create", input: { name: "valid", if_state_revision: 3 } }] },
        { operations: [{ op: "initiative.create", input: { name: "valid" }, actor: "forged" }] },
      ];
      for (const input of invalidInputs) {
        const response = await operation(baseUrl, "project-a", "core.batch", input);
        assert.equal(response.status, 400, JSON.stringify(await response.clone().json()));
        assert.equal((await response.json()).error.code, "INVALID_REQUEST");
      }
      await assertInvalidActor(baseUrl);
      assert.equal(openCount, 0);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HTTP v1 validates protocol and auth for core.batch before opening storage", async () => {
  await withApi(async ({ baseUrl, openCount }) => {
    const route = `${baseUrl}/v1/projects/project-a/operations`;
    const body = JSON.stringify({ operation: "core.batch", actor: "alice", input: { operations: [{ op: "initiative.create", input: { name: "no-open" } }] } });
    for (const { headers, status, code } of [
      { headers: { "content-type": "application/json" }, status: 426, code: "PROTOCOL_VERSION_UNSUPPORTED" },
      { headers: authHeaders({ authorization: "Bearer wrong", "content-type": "application/json" }), status: 401, code: "AUTH_INVALID" },
    ]) {
      const before = openCount();
      const response = await fetch(route, { method: "POST", headers, body });
      assert.equal(response.status, status);
      assert.equal((await response.json()).error.code, code);
      assert.equal(openCount(), before);
    }
  });
});

test("HTTP v1 returns structured errors and exposes no generic file endpoint", async () => {
  await withApi(async ({ baseUrl }) => {
    const unknownOperation = await operation(baseUrl, "project-a", "filesystem.read", { path: "tasks.json" });
    assert.equal(unknownOperation.status, 404);
    assert.equal((await unknownOperation.json()).error.code, "OPERATION_NOT_FOUND");

    const invalidOperation = await operation(baseUrl, "project-a", "initiative.create", { name: "bad/name" });
    assert.equal(invalidOperation.status, 422);
    const error = (await invalidOperation.json()).error;
    assert.equal(error.code, "INVALID_NAME");
    assert.equal(error.details.name, "bad/name");

    for (const endpoint of ["snapshot", "read/snapshot", "files/tasks.json"]) {
      const response = await fetch(`${baseUrl}/v1/projects/project-a/${endpoint}`, { headers: authHeaders() });
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error.code, "ROUTE_NOT_FOUND");
    }

    const privileged = await operation(baseUrl, "project-a", "task.create", {
      id: "T-bypass",
      initiative: "missing",
      title: "No bypass",
      body: "",
      acceptance: "",
      allow_unregistered_initiative: true,
    });
    assert.equal(privileged.status, 400);
    assert.equal((await privileged.json()).error.code, "INVALID_REQUEST");
  });
});
