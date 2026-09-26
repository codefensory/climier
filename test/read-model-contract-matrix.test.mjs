import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRemoteApiServer } from "../src/server/http.mjs";
import { createProjectCatalog } from "../src/server/catalog/index.mjs";
import { initState } from "../src/kernel/state-operations.mjs";
import { writeState } from "./helpers.mjs";
import { projectInitiativesView, projectSearchView } from "../src/read-model/index.mjs";
import { readModelParity } from "./fixtures/read-model-parity.mjs";

const canonicalReadMatrix = [
  ...readModelParity.matrix,
  { name: "log filters", route: "read/log", command: "log", query: "action=take&limit=1", positional: [] },
];

const consumerSources = {
  status: new URL("../src/cli/commands/status.mjs", import.meta.url),
  context: new URL("../src/cli/commands/context.mjs", import.meta.url),
  search: new URL("../src/cli/commands/search.mjs", import.meta.url),
  initiatives: new URL("../src/cli/commands/initiatives.mjs", import.meta.url),
  log: new URL("../src/cli/commands/log.mjs", import.meta.url),
  http: new URL("../src/server/http.mjs", import.meta.url),
  httpReads: new URL("../src/server/http/reads.mjs", import.meta.url),
  plugin: new URL("../src/plugins/query.mjs", import.meta.url),
  ui: new URL("../ui/server/server.mjs", import.meta.url),
};

async function source(url) {
  return fs.readFile(url, "utf8");
}

function authHeaders() {
  return { authorization: "Bearer test-token", "x-climier-protocol-version": "1" };
}

async function runCli(projectDir, command, query, positional) {
  const args = ["--project", projectDir, command, ...positional];
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
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const cli = fileURLToPath(new URL("../bin/climier.mjs", import.meta.url));
  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: projectDir });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { err += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ code: exitCode, stdout: out, stderr: err }));
  });
  assert.equal(code, 0, stdout || stderr);
  return JSON.parse(stdout);
}

function normalizeStatusTimes(status) {
  return {
    ...status,
    alerts: (status.alerts || []).map(({ age_ms: _age_ms, message, ...alert }) => ({
      ...alert,
      message: message.replace(/\(\d+m old\)/, "(rounded old)"),
    })),
  };
}

async function withParityEnvironment(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-read-contract-matrix-"));
  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = path.join(root, "home");
  const catalog = createProjectCatalog({ dataRoot: path.join(root, "catalog"), projectIds: ["matrix"] });
  const projectDir = await catalog.provisionProject("matrix");
  await initState({ projectDir });
  const server = createRemoteApiServer({
    catalog,
    credentials: [{ token: "test-token", projectIds: ["matrix"] }],
    async openProject(storagePath) { return { projectDir: storagePath }; },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await writeState(projectDir, readModelParity.snapshot);
    await run({ baseUrl, projectDir });
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

test("pure initiatives projection preserves default and all-list contracts", () => {
  assert.deepEqual(projectInitiativesView({ snapshot: readModelParity.snapshot }), {
    initiatives: [
      { name: "migration", desc: "Migration initiative", created_at: "2025-01-01T00:00:00.000Z", nodes: 12, tasks: 10, knowledge: 2 },
      { name: "other", desc: "Other initiative", created_at: "2025-01-03T00:00:00.000Z", nodes: 3, tasks: 1, knowledge: 2 },
    ],
    unregistered: { nodes: 0, values: [] },
    all: false,
  });
  assert.deepEqual(projectInitiativesView({ snapshot: readModelParity.snapshot, all: true }), {
    initiatives: [
      { name: "migration", desc: "Migration initiative", created_at: "2025-01-01T00:00:00.000Z", nodes: 12, tasks: 10, knowledge: 2 },
      { name: "other", desc: "Other initiative", created_at: "2025-01-03T00:00:00.000Z", nodes: 3, tasks: 1, knowledge: 2 },
      { name: "empty", desc: "Unused", created_at: "2025-01-02T00:00:00.000Z", nodes: 0, tasks: 0, knowledge: 0 },
    ],
    unregistered: { nodes: 0, values: [] },
    all: true,
  });
});

test("pure search projection matches the fixture's active and historical knowledge contract", () => {
  assert.deepEqual(projectSearchView({ snapshot: readModelParity.snapshot, query: "API" }), {
    matches: [{
      id: "K-active",
      kind: "knowledge",
      title: "API warning",
      initiative: "migration",
      domain: "api",
      status: "active",
      matched_fields: ["title", "body", "domain"],
      snippet: "Use safe API retries",
    }],
    count: 1,
  });
  assert.deepEqual(projectSearchView({ snapshot: readModelParity.snapshot, query: "API", all: true }).matches.map(({ id, status }) => [id, status]), [
    ["K-active", "active"],
    ["K-deprecated", "deprecated"],
  ]);
  assert.deepEqual(projectSearchView({ snapshot: readModelParity.snapshot, query: "" }), { matches: [], count: 0 });
});

test("canonical CLI and HTTP read owners match across every view fixture", async () => {
  await withParityEnvironment(async ({ baseUrl, projectDir }) => {
    for (const entry of canonicalReadMatrix) {
      const query = entry.query ? `?${entry.query}` : "";
      const response = await fetch(`${baseUrl}/v1/projects/matrix/${entry.route}${query}`, { headers: authHeaders() });
      assert.equal(response.status, 200, `${entry.name}: HTTP ${JSON.stringify(await response.clone().json())}`);
      const http = (await response.json()).result;
      const cli = await runCli(projectDir, entry.command, entry.query, entry.positional);
      assert.deepEqual(
        entry.command === "status" ? normalizeStatusTimes(http) : http,
        entry.command === "status" ? normalizeStatusTimes(cli) : cli,
        entry.name,
      );
    }
  });
});

// oxlint-disable-next-line max-statements -- this contract inventory intentionally asserts each read adapter
test("read consumers delegate canonical views and retain adapter-specific shapes", async () => {
  const [status, context, search, initiatives, log, http, httpReads, plugin, ui] = await Promise.all(
    Object.values(consumerSources).map(source),
  );

  assert.match(status, /projectStatusView/);
  assert.match(status, /function emptyResult\(/, "CLI owns only its neutral missing-state result");
  assert.match(context, /projectContextView/);
  assert.doesNotMatch(context, /function contextView\(/);
  assert.match(search, /projectSearchView/);
  assert.match(initiatives, /projectInitiativesView/);
  assert.match(log, /projectLogView/);
  for (const [name, text] of [["search", search], ["initiatives", initiatives], ["log", log]]) {
    assert.doesNotMatch(text, /\.filter\(|\.sort\(/, `${name} owns no duplicate projection assembly`);
  }

  for (const projection of ["projectStatusView", "projectContextView", "projectSearchView", "projectInitiativesView", "projectLogView"]) {
    assert.match(httpReads, new RegExp(projection));
  }
  assert.match(httpReads, /function entryReferencesId\(/, "HTTP history remains a distinct view");
  assert.doesNotMatch(http, /projectStatusView|projectContextView|projectSearchView|projectInitiativesView|projectLogView/);

  assert.match(plugin, /projectStatusView/);
  assert.match(plugin, /blockingForNode/);
  assert.match(plugin, /knowledgeForNode/);
  assert.match(plugin, /informingForNode/);
  assert.match(plugin, /statusOf/);
  assert.match(plugin, /function contextView\(/, "plugin keeps its non-equivalent context DTO");
  assert.match(plugin, /function claimFor\(/, "plugin stale-claim timing remains plugin-specific");
  assert.match(plugin, /function allowedActions\(/, "plugin allowed actions remain identity-based");
  assert.match(plugin, /function entryReferencesId\(/, "plugin history remains a distinct view");
  assert.match(plugin, /query\.node: id required/);
  assert.match(plugin, /show: state file missing/);
  assert.match(plugin, /query\.context: node \$\{id\} not found/);

  assert.match(ui, /derive\(\{ snapshot: state \}\)/, "UI shares canonical graph derivation");
  assert.match(ui, /function detectStaleClaims\(/, "UI stale-claim projection keeps its DTO semantics");
  assert.match(ui, /function summaryOf\(/, "UI summary remains UI-specific");
  assert.match(ui, /open_decisions/);
});
