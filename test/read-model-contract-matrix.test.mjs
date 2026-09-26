import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRemoteApiServer } from "../src/server/http.mjs";
import { createProjectCatalog } from "../src/server/catalog/index.mjs";
import { initState } from "../src/kernel/state-operations.mjs";
import { writeState } from "./helpers.mjs";
import { projectSearchView } from "../src/read-model/index.mjs";
import { readModelParity } from "./fixtures/read-model-parity.mjs";

function authHeaders() {
  return { authorization: "Bearer test-token", "x-climier-protocol-version": "1" };
}

async function runCli(projectDir, command, query, positional) {
  const args = ["--project", projectDir, command, ...positional];
  for (const [key, value] of new URLSearchParams(query)) {
    if (key === "all") {
      if (value === "true" || value === "") args.push("--all");
      continue;
    }
    if (key === "query") continue;
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
    alerts: (status.alerts || []).map(({ age_ms, message, ...alert }) => ({
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
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

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

test("read-model contract matrix matches CLI and HTTP projections for the same snapshot", async () => {
  await withParityEnvironment(async ({ baseUrl, projectDir }) => {
    for (const entry of readModelParity.matrix) {
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
