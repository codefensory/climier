import { test } from "node:test";
import assert from "node:assert/strict";

import { createHttpReads } from "../../../src/server/http/reads.mjs";
import { createHttpCodec } from "../../../src/server/http/codec.mjs";
import { PROTOCOL_VERSION } from "../../../src/server/http.mjs";
import * as readModel from "../../../src/read-model/index.mjs";
import { runCli, writeState } from "../../helpers.mjs";
import { authHeaders, operation, withApi } from "./fixtures.mjs";


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

function queryArgs(query) {
  const args = [];
  for (const [key, value] of new URLSearchParams(query)) {
    if (key === "all") {
      if (value === "true" || value === "") {
        args.push("--all");
      }
      continue;
    }
    if (key === "query") {
      continue;
    }
    args.push(`--${key}`, value);
  }
  return args;
}

async function cliCommand(projectDir, command, query = "", positional = []) {
  const args = ["--project", projectDir, command, ...positional, ...queryArgs(query)];
  const result = await runCli(args);
  assert.equal(result.code, 0, result.stdout || result.stderr);
  return JSON.parse(result.stdout);
}

async function cliStatus(projectDir, query = "") {
  return cliCommand(projectDir, "status", query);
}

function hasTransferLogEntry(log, action) {
  return log.some((entry) => entry.action.startsWith(action));
}

function countTransferLogEntries(log, action) {
  return log.filter((entry) => entry.action === action).length;
}

function normalizeStatusTimes(status) {
  return {
    ...status,
    alerts: (status.alerts || []).map(({ age_ms: _ageMs, message, ...alert }) => ({
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

test("HTTP transfer routes capture and install typed payloads through kernel ports only", async () => {
  await withApi(async ({ baseUrl, projectDirs }) => {
    await operation(baseUrl, "project-a", "initiative.create", { name: "source" });
    await operation(baseUrl, "project-a", "task.create", {
      id: "T-transfer-source", initiative: "source", title: "Transfer source", body: "payload", acceptance: "copied",
    });
    const exported = await fetch(`${baseUrl}/v1/projects/project-a/transfer/export`, {
      method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: "{}",
    });
    assert.equal(exported.status, 200, JSON.stringify(await exported.clone().json()));
    const payload = (await exported.json()).result;
    assert.equal(payload.nodes["T-transfer-source"].title, "Transfer source");
    assert.equal(payload.nodes["T-transfer-source"].revision, undefined);
    assert.equal(hasTransferLogEntry(payload.log, "transfer."), false);

    const imported = await fetch(`${baseUrl}/v1/projects/project-b/transfer/import`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ payload, actor: "alice" }),
    });
    assert.equal(imported.status, 200, JSON.stringify(await imported.clone().json()));
    const { readState } = await import("../../../src/storage/state.mjs");
    const installed = await readState(projectDirs[1]);
    assert.equal(installed.nodes["T-transfer-source"].title, "Transfer source");
    assert.equal(countTransferLogEntries(installed.log, "transfer.push"), 1);
    assert.equal(installed.log.at(-1).agent, "alice");
  });
});

async function assertTransferPreOpenError(baseUrl, openCount, request) {
  const { route, headers, body, status, code } = request;
  const before = openCount();
  const response = await fetch(`${baseUrl}/v1/projects/project-a/${route}`, { method: "POST", headers, body });
  assert.equal(response.status, status);
  assert.equal((await response.json()).error.code, code);
  if (route.endsWith("import") && status === 400) {
    assert.equal(openCount(), before);
  }
}

test("HTTP transfer routes validate schema and authorization before kernel access", async () => {
  await withApi(async ({ baseUrl, openCount }) => {
    for (const request of [
      { route: "transfer/export", headers: authHeaders({ authorization: "Bearer wrong", "content-type": "application/json" }), body: "{}", status: 401, code: "AUTH_INVALID" },
      { route: "transfer/import", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ payload: {}, actor: "alice", sourceProjectDir: "/tmp/private" }), status: 400, code: "INVALID_REQUEST" },
      { route: "transfer/import", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ payload: {}, actor: "alice", overwrite: "yes" }), status: 400, code: "INVALID_REQUEST" },
    ]) {
      await assertTransferPreOpenError(baseUrl, openCount, request);
    }
  });
});

test("HTTP reads module receives snapshot query, route, dependencies, and clock explicitly", () => {
  const { httpError } = createHttpCodec({ protocolVersion: PROTOCOL_VERSION });
  const calls = [];
  const reads = createHttpReads({
    httpError,
    routing: { decodeURIComponent },
    query: { searchParams: (url) => url.searchParams },
    deps: {
      ...readModel,
      projectStatusView(args) { calls.push(["status", args]); return { marker: "injected-status" }; },
    },
    clock: () => 1234,
  });

  const route = reads.matchReadRoute("read/status");
  assert.equal(route.kind, "status");
  const parsedQuery = reads.parseReadQuery(new URL("http://localhost/read/status?limit=2"), route);
  assert.deepEqual(parsedQuery, { limit: 2 });
  assert.deepEqual(reads.projectReadResult({ snapshot: { nodes: {} }, route, query: parsedQuery }), { marker: "injected-status" });
  assert.deepEqual(calls, [["status", { snapshot: { nodes: {} }, filters: parsedQuery, now: 1234 }]]);
  assert.equal(reads.matchReadRoute("read/nope"), null);
});

test("HTTP context reads preserve NODE_NOT_FOUND adapter error details", () => {
  const { httpError } = createHttpCodec({ protocolVersion: PROTOCOL_VERSION });
  const calls = [];
  const reads = createHttpReads({
    httpError,
    routing: { decodeURIComponent },
    query: { searchParams: (url) => url.searchParams },
    deps: {
      ...readModel,
      projectContextView(args) {
        calls.push(args);
        return null;
      },
    },
    clock: () => 1234,
  });
  const route = reads.matchReadRoute("read/context/missing-node");
  const query = reads.parseReadQuery(new URL("http://localhost/read/context/missing-node"), route);

  assert.throws(
    () => reads.projectReadResult({ snapshot: { nodes: {} }, route, query }),
    { code: "NODE_NOT_FOUND", status: 404, details: { id: "missing-node" } },
  );
  assert.deepEqual(calls, [{ snapshot: { nodes: {} }, id: "missing-node", agent: undefined, staleMs: undefined, now: 1234 }]);
});
