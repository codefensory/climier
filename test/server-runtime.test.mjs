import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadServerRuntimeConfig } from "../src/server/runtime-config.mjs";
import { createServerRuntime, startServerRuntime } from "../src/server/runtime.mjs";
import { stateFile } from "../src/storage/state.mjs";

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function config(root, overrides = {}) {
  return {
    listen: { host: "127.0.0.1", port: 0 },
    dataRoot: path.join(root, "catalog"),
    stateHome: path.join(root, "state-home"),
    projectIds: ["alpha", "../beta"],
    credentials: [{ token: "runtime-secret", projectIds: ["alpha", "../beta"] }],
    ...overrides,
  };
}

async function writeConfig(root, value) {
  const file = path.join(root, "server.json");
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}

test("private server config fails closed for malformed or unsafe settings", async (t) => {
  const root = await makeRoot(t);
  const valid = config(root);
  const invalid = [
    { ...valid, unexpected: true },
    { ...valid, stateHome: "" },
    { ...valid, listen: { host: "127.0.0.1", port: 65_536 } },
    { ...valid, projectIds: ["alpha", "alpha"] },
    { ...valid, credentials: [{ token: "secret", projectIds: ["not-configured"] }] },
    { ...valid, credentials: [{ token: "", projectIds: ["alpha"] }] },
  ];

  for (const value of invalid) {
    const file = await writeConfig(root, value);
    await assert.rejects(loadServerRuntimeConfig(file), { code: "INVALID_SERVER_CONFIG" });
  }
  const malformed = path.join(root, "malformed.json");
  await fs.writeFile(malformed, "{", { mode: 0o600 });
  await assert.rejects(loadServerRuntimeConfig(malformed), { code: "INVALID_SERVER_CONFIG" });
  if (process.platform !== "win32") {
    const exposed = path.join(root, "exposed.json");
    await fs.writeFile(exposed, JSON.stringify(valid), { mode: 0o644 });
    await fs.chmod(exposed, 0o644);
    await assert.rejects(loadServerRuntimeConfig(exposed), { code: "INVALID_SERVER_CONFIG" });
  }
});

test("server runtime pins state home and writes trusted hash-safe project metadata", async (t) => {
  const root = await makeRoot(t);
  const stateHome = path.join(root, "fixed-state-home");
  const previousHome = process.env.CLIMIER_HOME;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
  });

  const runtime = createServerRuntime(config(root, { stateHome }));
  assert.equal(process.env.CLIMIER_HOME, path.resolve(stateHome));
  const alphaPath = await runtime.catalog.provisionProject("alpha");
  const betaPath = await runtime.catalog.provisionProject("../beta");

  process.env.CLIMIER_HOME = path.join(root, "attacker-controlled-home");
  const alpha = await runtime.openProject(alphaPath, { projectId: "alpha" });
  assert.equal(process.env.CLIMIER_HOME, path.resolve(stateHome));
  const beta = await runtime.openProject(betaPath, { projectId: "../beta" });

  const alphaMeta = JSON.parse(await fs.readFile(path.join(alpha.projectDir, ".climier.json"), "utf8"));
  const betaMeta = JSON.parse(await fs.readFile(path.join(beta.projectDir, ".climier.json"), "utf8"));
  assert.match(alphaMeta.project_id, /^[a-f0-9]{64}$/u);
  assert.match(betaMeta.project_id, /^[a-f0-9]{64}$/u);
  assert.notEqual(alphaMeta.project_id, betaMeta.project_id);
  assert.equal(stateFile(alpha.projectDir), path.join(stateHome, "projects", alphaMeta.project_id, "tasks.json"));
  assert.equal(stateFile(beta.projectDir), path.join(stateHome, "projects", betaMeta.project_id, "tasks.json"));
  assert.notEqual(stateFile(alpha.projectDir), stateFile(beta.projectDir));
  assert.equal(path.dirname(alphaPath), path.join(root, "catalog"));
  assert.equal(path.dirname(betaPath), path.join(root, "catalog"));
  await assert.rejects(runtime.openProject(betaPath, { projectId: "alpha" }), { code: "UNSAFE_PROJECT_STORAGE" });
});

test("server runtime rejects a project directory with conflicting metadata", async (t) => {
  const root = await makeRoot(t);
  const runtime = createServerRuntime(config(root));
  const projectDir = await runtime.catalog.provisionProject("alpha");
  await fs.writeFile(path.join(projectDir, ".climier.json"), JSON.stringify({ version: 1, project_id: "client-controlled" }));

  await assert.rejects(runtime.openProject(projectDir, { projectId: "alpha" }), { code: "UNTRUSTED_PROJECT_METADATA" });
});

test("launcher starts the configured server and reports its listening health", async (t) => {
  const root = await makeRoot(t);
  const configPath = await writeConfig(root, config(root));
  const launcher = new URL("../bin/climier-server.mjs", import.meta.url);
  const child = spawn(process.execPath, [launcher.pathname, configPath], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGTERM"));

  const line = await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`launcher did not report health: ${stderr}`)), 5_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timer);
        resolve(stdout.slice(0, newline));
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`launcher exited before health report (${code}): ${stderr}`));
    });
  });
  const health = JSON.parse(line);
  assert.equal(health.ok, true);
  assert.equal(health.host, "127.0.0.1");
  assert.ok(Number.isInteger(health.port) && health.port > 0);
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
});

test("runtime startup binds state home once and listens on configured address", async (t) => {
  const root = await makeRoot(t);
  const previousHome = process.env.CLIMIER_HOME;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
  });
  const file = await writeConfig(root, config(root));
  const runtime = await startServerRuntime(file);
  t.after(() => new Promise((resolve) => runtime.server.close(resolve)));
  assert.equal(runtime.server.listening, true);
  assert.equal(process.env.CLIMIER_HOME, path.resolve(path.join(root, "state-home")));
  assert.equal(runtime.server.address().address, "127.0.0.1");
});
