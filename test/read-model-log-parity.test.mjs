import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { projectLogView } from "../src/read-model/index.mjs";
import { createRemoteApiServer } from "../src/server/http.mjs";
import { createServerAuthStore } from "../src/server/auth/server-auth-store.mjs";
import { createProjectCatalog } from "../src/server/catalog/index.mjs";
import { initState } from "../src/kernel/state-operations.mjs";
import { runCli, writeCanonicalState } from "./helpers.mjs";
import { readModelParity } from "./fixtures/read-model-parity.mjs";

const log = [
  { ts: "2025-01-01T00:00:00.000Z", agent: "alice", action: "take", node: "T-two" },
  { ts: "2025-01-02T00:00:00.000Z", agent: "bob", action: "update", node: "T-two" },
  { ts: "2025-01-03T00:00:00.000Z", agent: "alice", action: "take", node: "T-two" },
  { ts: "2025-01-04T00:00:00.000Z", agent: "alice", action: "take", node: "T-one" },

  { ts: "2025-01-05T00:00:00.000Z", agent: "alice", action: "take", task: "T-one", decision: "T-one", gotcha: "T-one" },
];
const snapshot = { ...readModelParity.snapshot, log };

function authHeaders(token) {
  return { authorization: `Bearer ${token}`, "x-climier-protocol-version": "1" };
}

async function withLogProject(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-log-parity-"));
  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = path.join(root, "home");
  const catalog = createProjectCatalog({ dataRoot: path.join(root, "catalog"), projectIds: ["log-parity"] });
  const projectDir = await catalog.provisionProject("log-parity");
  await initState({ projectDir });
  const authStore = await createServerAuthStore({ stateHome: path.join(root, "server-auth"), password: "fixture-password" });
  const token = await authStore.login("fixture-password");
  const server = createRemoteApiServer({
    catalog,
    authStore,
    async openProject(storagePath) { return { projectDir: storagePath }; },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await writeCanonicalState(projectDir, snapshot);
    await run({ baseUrl: `http://127.0.0.1:${server.address().port}`, projectDir, token });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousHome === undefined) {
      delete process.env.CLIMIER_HOME;
    } else {
      process.env.CLIMIER_HOME = previousHome;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function cliLog(projectDir, filters) {
  const args = ["--project", projectDir, "log"];
  for (const [key, value] of Object.entries(filters)) {
    args.push(`--${key}`, String(value));
  }
  const result = await runCli(args);
  assert.equal(result.code, 0, result.stdout || result.stderr);
  return JSON.parse(result.stdout);
}

test("pure log projection preserves exact filters, chronological order, limit, and array shape", () => {
  assert.deepEqual(projectLogView({ snapshot }), log);
  assert.deepEqual(projectLogView({ snapshot, filters: { action: "take", agent: "alice", node: "T-two", limit: 1 } }), [log[2]]);
  assert.deepEqual(projectLogView({ snapshot, filters: { agent: "alice", limit: 2 } }), [log[3], log[4]]);
  assert.deepEqual(projectLogView({ snapshot: { ...snapshot, log: undefined } }), []);
  assert.deepEqual(projectLogView({ snapshot, filters: { node: "T-one" } }), [log[3]], "node is the canonical reference field");
});

test("log CLI and HTTP use the same pure filter, order, limit, and array projection", async () => {
  await withLogProject(async ({ baseUrl, projectDir, token }) => {
    const cases = [
      { query: "", filters: {}, expected: log },
      { query: "action=take&agent=alice&node=T-two&limit=1", filters: { action: "take", agent: "alice", node: "T-two", limit: 1 }, expected: [log[2]] },
      { query: "agent=alice&limit=2", filters: { agent: "alice", limit: 2 }, expected: [log[3], log[4]] },
    ];
    for (const entry of cases) {
      const response = await fetch(`${baseUrl}/v1/projects/log-parity/read/log${entry.query ? `?${entry.query}` : ""}`, { headers: authHeaders(token) });
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      const http = (await response.json()).result;
      assert.ok(Array.isArray(http));
      assert.deepEqual(http, entry.expected, entry.query);
      assert.deepEqual(await cliLog(projectDir, entry.filters), entry.expected, entry.query);
    }
  });
});

test("history matches the canonical node reference and ignores the pre-canonical fields", async () => {

  await withLogProject(async ({ baseUrl, projectDir, token }) => {
    const http = await (await fetch(`${baseUrl}/v1/projects/log-parity/read/history/T-one`, { headers: authHeaders(token) })).json();
    const entries = http.result.entries;
    assert.ok(Array.isArray(entries));
    assert.deepEqual(entries.map((entry) => entry.ts), ["2025-01-04T00:00:00.000Z"]);

    const cli = await runCli(["--project", projectDir, "history", "T-one"]);
    assert.equal(cli.code, 0, cli.stdout || cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout).entries.map((entry) => entry.ts), ["2025-01-04T00:00:00.000Z"]);
  });
});
