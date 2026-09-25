import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRemoteApiServer } from "../src/server/http.mjs";
import { createProjectCatalog } from "../src/server/catalog/index.mjs";
import { initState } from "../src/kernel/state-operations.mjs";
import { bootstrapFencedState } from "../src/storage/ledger.mjs";
import { runCli, writeState } from "./helpers.mjs";

async function withApi(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-http-"));
  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = path.join(root, "home");
  const projectIds = ["project-a", "project-b"];
  const catalog = createProjectCatalog({ dataRoot: path.join(root, "catalog"), projectIds });
  const projectDirs = await Promise.all(projectIds.map((id) => catalog.provisionProject(id)));
  for (const projectDir of projectDirs) await initState({ projectDir });
  let openCount = 0;
  const server = createRemoteApiServer({
    catalog,
    credentials: [{ token: "test-token", projectIds }],
    async openProject(storagePath, metadata) {
      openCount += 1;
      assert.equal(typeof metadata.projectId, "string");
      return { projectDir: storagePath };
    },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({ baseUrl, openCount: () => openCount, projectDirs });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function withInitApi(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-init-http-"));
  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = path.join(root, "home");
  const dataRoot = path.join(root, "catalog");
  const catalog = createProjectCatalog({ dataRoot, projectIds: ["catalogued"] });
  let openCount = 0;
  const server = createRemoteApiServer({
    catalog,
    credentials: [{ token: "test-token", projectIds: ["catalogued", "unknown"] }],
    async openProject(projectDir) {
      openCount += 1;
      return { projectDir };
    },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({ baseUrl, dataRoot, openCount: () => openCount });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

function authHeaders(extra = {}) {
  return {
    authorization: "Bearer test-token",
    "x-climier-protocol-version": "1",
    ...extra,
  };
}

async function operation(baseUrl, projectId, operation, input, actor = "alice") {
  return fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/operations`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ operation, input, actor }),
  });
}

function readApiState() {
  return {
    version: 4,
    revision: 41,
    initiatives: {
      migration: { desc: "Migration initiative", created_at: "2025-01-01T00:00:00.000Z" },
      empty: { desc: "Unused", created_at: "2025-01-02T00:00:00.000Z" },
    },
    nodes: {
      "T-ready": { id: "T-ready", kind: "resolvable", subkind: "task", title: "Ready API", status: "open", initiative: "migration", domain: "api", revision: 1 },
      "T-progress": { id: "T-progress", kind: "resolvable", subkind: "task", title: "Progress API", status: "in_progress", initiative: "migration", domain: "api", revision: 2, claim: { by: "alice", at: "2000-01-01T00:00:00.000Z" } },
      "T-submitted": { id: "T-submitted", kind: "resolvable", subkind: "task", title: "Submitted API", status: "submitted", initiative: "migration", domain: "api", revision: 3 },
      "T-blocked": { id: "T-blocked", kind: "resolvable", subkind: "task", title: "Blocked Worker", status: "open", initiative: "migration", domain: "worker", revision: 1 },
      "T-backlog": { id: "T-backlog", kind: "resolvable", subkind: "task", title: "Backlog UI", status: "open", initiative: "other", domain: "ui", backlog: true, revision: 1 },
      "T-done": { id: "T-done", kind: "resolvable", subkind: "task", title: "Done API", status: "done", initiative: "migration", domain: "api", revision: 4 },
      "T-canceled": { id: "T-canceled", kind: "resolvable", subkind: "task", title: "Canceled API", status: "canceled", initiative: "migration", domain: "api", revision: 4 },
      "G-open": { id: "G-open", kind: "resolvable", subkind: "gate", title: "Open approval", status: "open", initiative: "migration", revision: 1 },
      "G-resolved": { id: "G-resolved", kind: "resolvable", subkind: "gate", title: "Resolved approval", status: "resolved", initiative: "migration", revision: 2 },
      "K-active": { id: "K-active", kind: "knowledge", title: "API warning", body: "Use safe API retries", status: "active", initiative: "migration", domain: "api", scope: { domains: ["api"], initiatives: [], tags: [], node_ids: [] } },
      "K-deprecated": { id: "K-deprecated", kind: "knowledge", title: "Old API warning", body: "Old API retry behavior", status: "deprecated", initiative: "migration", domain: "api", deprecation_reason: "Replaced", deprecated_at: "2025-01-03T00:00:00.000Z", deprecated_by: "alice", scope: { domains: ["api"], initiatives: [], tags: [], node_ids: [] } },
    },
    edges: [{ from: "T-progress", to: "T-blocked", type: "BLOCKS" }],
    log: [
      { ts: "2025-01-01T00:00:00.000Z", agent: "alice", action: "take", node: "T-progress", task: "T-progress" },
      { ts: "2025-01-02T00:00:00.000Z", agent: "bob", action: "update", node: "T-ready", task: "T-ready" },
    ],
  };
}

async function cliCommand(projectDir, command, query = "", positional = []) {
  const args = ["--project", projectDir, command, ...positional];
  for (const [key, value] of new URLSearchParams(query)) {
    if (key === "all") {
      if (value === "true" || value === "") args.push("--all");
      continue;
    }
    if (key === "query") continue;
    args.push(`--${key}`, value);
  }
  const result = await runCli(args);
  assert.equal(result.code, 0, result.stdout || result.stderr);
  return JSON.parse(result.stdout);
}

async function cliStatus(projectDir, query = "") {
  return cliCommand(projectDir, "status", query);
}

function normalizeStatusTimes(status) {
  return {
    ...status,
    alerts: (status.alerts || []).map(({ age_ms, message, ...alert }) => ({
      ...alert,
      message: message.replace(/\(\d+m old\)/, "(rounded old)"),
    })),
  };
}

test("HTTP status read matches the complete CLI projection and all nine exact filters", async () => {
  await withApi(async ({ baseUrl, projectDirs }) => {
    await writeState(projectDirs[0], readApiState());
    const queries = [
      "",
      "initiative=migration",
      "kind=task",
      "status=ready",
      "domain=api",
      "claimed-by=alice",
      "stale-ms=0",
      "limit=1",
      "all=true",
      "as=bob",
      "initiative=migration&kind=task&status=in_progress&domain=api&claimed-by=alice&stale-ms=0&limit=1&all=true&as=bob",
      "initiative=migration&domain=api&limit=1&all=true",
      "initiative=migration&domain=api&kind=task&status=ready&limit=1",
      "claimed-by=bob&status=in_progress&as=alice",
    ];
    for (const query of queries) {
      const response = await fetch(`${baseUrl}/v1/projects/project-a/read/status${query ? `?${query}` : ""}`, { headers: authHeaders() });
      assert.equal(response.status, 200, `${query}: ${JSON.stringify(await response.clone().json())}`);
      const body = await response.json();
      assert.deepEqual(normalizeStatusTimes(body.result), normalizeStatusTimes(await cliStatus(projectDirs[0], query)), query);
      assert.deepEqual(Object.keys(body.result).slice(0, 5), ["summary", "tasks", "gates", "knowledge_count", "alerts"]);
    }
  });
});

test("HTTP typed read routes match the CLI output from the same state snapshot", async () => {
  await withApi(async ({ baseUrl, projectDirs }) => {
    await writeState(projectDirs[0], readApiState());
    const routes = [
      ["read/context/T-ready", "context", "as=alice&staleMs=0", ["T-ready"]],
      ["read/show/T-ready", "show", "", ["T-ready"]],
      ["read/history/T-progress", "history", "limit=1", ["T-progress"]],
      ["read/search/API", "search", "all=true", ["API"]],
      ["read/initiatives", "initiatives", "all=true", []],
      ["read/log", "log", "limit=1&agent=alice", []],
      ["read/state", "state", "", []],
    ];
    for (const [route, command, query, positional] of routes) {
      const response = await fetch(`${baseUrl}/v1/projects/project-a/${route}${query ? `?${query}` : ""}`, { headers: authHeaders() });
      assert.equal(response.status, 200, `${route}: ${JSON.stringify(await response.clone().json())}`);
      assert.deepEqual((await response.json()).result, await cliCommand(projectDirs[0], command, query, positional), route);
    }
  });
});

test("HTTP typed read routes reject unknown, repeated, and invalid query parameters", async () => {
  await withApi(async ({ baseUrl, projectDirs }) => {
    await writeState(projectDirs[0], readApiState());
    for (const query of ["claimedBy=alice", "kind=task&kind=gate", "limit=-1", "stale-ms=nope", "all=maybe", "as=alice&as=bob"]) {
      const response = await fetch(`${baseUrl}/v1/projects/project-a/read/status?${query}`, { headers: authHeaders() });
      assert.equal(response.status, 400, query);
      assert.equal((await response.json()).error.code, "INVALID_QUERY", query);
    }
  });
});

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
  });
});

test("HTTP v1 executes core.batch through one canonical server mutation", async () => {
  await withApi(async ({ baseUrl, projectDirs }) => {
    const { readState } = await import("../src/storage/state.mjs");
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
    assert.equal(after.nodes["T-batch-remote"].title, "Batch task");
    assert.equal(after.initiatives["batch-remote"].desc, "Created in batch");
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.log.length, 1);
    assert.equal(after.log[0].action, "core.batch");

    const invalidDomainInput = await operation(baseUrl, "project-a", "core.batch", {
      operations: [{ op: "initiative.create", input: { name: "bad/name" } }],
    });
    assert.equal(invalidDomainInput.status, 400);
    assert.equal((await invalidDomainInput.json()).error.code, "BATCH_OPERATION_FAILED");
    const unchanged = await readState(projectDirs[0]);
    assert.equal(unchanged.revision, after.revision);
    assert.deepEqual(Object.keys(unchanged.initiatives), ["batch-remote"]);
  });
});

test("HTTP v1 validates core.batch schema and nested operation inputs before opening storage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-batch-schema-"));
  try {
    const catalog = createProjectCatalog({ dataRoot: path.join(root, "catalog"), projectIds: ["project-a"] });
    let openCount = 0;
    const server = createRemoteApiServer({
      catalog,
      credentials: [{ token: "test-token", projectIds: ["project-a"] }],
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
      const invalidActor = await fetch(`${baseUrl}/v1/projects/project-a/operations`, {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ operation: "core.batch", actor: "", input: { operations: [{ op: "initiative.create", input: { name: "valid" } }] } }),
      });
      assert.equal(invalidActor.status, 400);
      assert.equal((await invalidActor.json()).error.code, "INVALID_REQUEST");
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

test("HTTP init validates protocol, bearer, scope, catalog and request fields before storage access", async () => {
  await withInitApi(async ({ baseUrl, dataRoot, openCount }) => {
    const route = `${baseUrl}/v1/projects/catalogued/init`;
    const missingBearer = await fetch(route, { method: "POST", headers: { "x-climier-protocol-version": "1", "content-type": "application/json" }, body: "{}" });
    assert.equal(missingBearer.status, 401);
    assert.equal((await missingBearer.json()).error.code, "AUTH_REQUIRED");

    const invalidBearer = await fetch(route, { method: "POST", headers: { ...authHeaders({ authorization: "Bearer wrong" }), "content-type": "application/json" }, body: "{}" });
    assert.equal(invalidBearer.status, 401);
    assert.equal((await invalidBearer.json()).error.code, "AUTH_INVALID");

    const noScopeServer = createRemoteApiServer({
      catalog: createProjectCatalog({ dataRoot: path.join(dataRoot, "no-scope"), projectIds: ["catalogued"] }),
      credentials: [{ token: "no-scope-token", projectIds: [] }],
      async openProject() { assert.fail("scope denial must precede project opening"); },
    });
    await new Promise((resolve, reject) => { noScopeServer.once("error", reject); noScopeServer.listen(0, "127.0.0.1", resolve); });
    try {
      const noScopeAddress = noScopeServer.address();
      const noScope = await fetch(`http://127.0.0.1:${noScopeAddress.port}/v1/projects/catalogued/init`, {
        method: "POST",
        headers: { ...authHeaders({ authorization: "Bearer no-scope-token" }), "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(noScope.status, 403);
      assert.equal((await noScope.json()).error.code, "PROJECT_SCOPE_DENIED");
    } finally {
      await new Promise((resolve, reject) => noScopeServer.close((error) => error ? reject(error) : resolve()));
    }

    const unknown = await fetch(`${baseUrl}/v1/projects/unknown/init`, {
      method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: "{}",
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, "UNKNOWN_PROJECT");

    for (const body of [{ force: true }, { reset: true }, { unexpected: true }]) {
      const invalid = await fetch(route, {
        method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error.code, body.force || body.reset ? "REMOTE_UNSUPPORTED_OPERATION" : "INVALID_REQUEST");
    }
    assert.equal(openCount(), 0);
    await assert.rejects(fs.access(dataRoot));
  });
});

test("HTTP init creates only absent catalogued state once and does not expose storage paths", async () => {
  await withInitApi(async ({ baseUrl, dataRoot, openCount }) => {
    const route = `${baseUrl}/v1/projects/catalogued/init`;
    const initialized = await fetch(route, {
      method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: "{}",
    });
    assert.equal(initialized.status, 200);
    const response = await initialized.json();
    assert.equal(response.ok, true);
    assert.deepEqual(response.result, { seeded: null });
    assert.equal(JSON.stringify(response).includes(dataRoot), false);
    assert.equal(openCount(), 1);

    const projectDir = await (await import("../src/server/catalog/index.mjs")).createProjectCatalog({ dataRoot, projectIds: ["catalogued"] }).resolveProject("catalogued");
    const { readState, stateFile } = await import("../src/storage/state.mjs");
    const state = await readState(projectDir);
    assert.equal(state.version, 4);
    assert.deepEqual(state.nodes, {});
    assert.deepEqual(state.edges, []);
    assert.deepEqual(state.initiatives, {});
    assert.deepEqual(state.log, []);

    const second = await fetch(route, {
      method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: "{}",
    });
    assert.equal(second.status, 409);
    const error = await second.json();
    assert.equal(error.ok, false);
    assert.equal(error.error.code, "STATE_ALREADY_INITIALIZED");
    assert.match(error.error.message, /already initialized/);
    assert.equal(JSON.stringify(error).includes(dataRoot), false);
    assert.equal(JSON.stringify(error).includes(stateFile(projectDir)), false);
    assert.equal(openCount(), 2);
  });
});

test("HTTP init rejects unsupported protocol before project opening", async () => {
  await withInitApi(async ({ baseUrl, openCount }) => {
    const response = await fetch(`${baseUrl}/v1/projects/catalogued/init`, {
      method: "POST", headers: { ...authHeaders({ "x-climier-protocol-version": "2" }), "content-type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 426);
    assert.equal((await response.json()).error.code, "PROTOCOL_VERSION_UNSUPPORTED");
    assert.equal(openCount(), 0);
  });
});

test("HTTP v1 authenticates before storage access and isolates projects", async () => {
  await withApi(async ({ baseUrl, openCount }) => {
    const unauthorized = await fetch(`${baseUrl}/v1/projects/project-a/read/status`, { headers: { "x-climier-protocol-version": "1" } });
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error.code, "AUTH_REQUIRED");
    assert.equal(openCount(), 0);

    const createA = await operation(baseUrl, "project-a", "initiative.create", { name: "only-a" });
    assert.equal(createA.status, 200);

    const statusA = await fetch(`${baseUrl}/v1/projects/project-a/read/status`, { headers: authHeaders() });
    const statusB = await fetch(`${baseUrl}/v1/projects/project-b/read/status`, { headers: authHeaders() });
    assert.deepEqual((await statusA.json()).result.tasks.ready, []);
    assert.deepEqual((await statusB.json()).result.tasks.ready, []);
  });
});
