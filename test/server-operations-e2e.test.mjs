import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "./helpers.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverLauncher = path.join(repoRoot, "bin", "climier-server.mjs");
const token = "e2e-test-token-not-a-secret";
const projectId = "local-server-e2e-project";

const sentinel = {
  version: 4,
  revision: 13,
  initiatives: { local: { desc: "must remain client-local" } },
  nodes: {
    "T-local-sentinel": {
      id: "T-local-sentinel",
      kind: "resolvable",
      subkind: "task",
      title: "Local sentinel",
      status: "open",
      revision: 2,
    },
  },
  edges: [],
  plugins: {},
  log: [{ id: "local-sentinel-event" }],
};

async function writePrivateConfig(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(file, 0o600);
}

async function writeClient(root, name, backendUrl, clientHome) {
  const projectDir = path.join(root, name);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, ".climier.json"), `${JSON.stringify({
    version: 1,
    project_id: projectId,
    backend: { type: "remote", url: backendUrl },
  }, null, 2)}\n`);
  const stateFile = path.join(clientHome, "projects", projectId, "tasks.json");
  await fs.mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(stateFile, `${JSON.stringify(sentinel, null, 2)}\n`);
  return { projectDir, stateFile };
}

async function readSentinel(stateFile) {
  return JSON.parse(await fs.readFile(stateFile, "utf8"));
}

async function waitForHealth(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`server launcher health timeout: ${stderr}`)), 5_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.slice(0, newline)));
      } catch (error) {
        reject(new Error(`server launcher returned invalid health JSON: ${error.message}`));
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server launcher exited before health report (${code}): ${stderr}`));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("server launcher did not stop after SIGTERM"));
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function cli(projectDir, command, args, env) {
  const result = await runCli(["--project", projectDir, command, ...args], { env });
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    assert.fail(`${command} output was not JSON (exit ${result.code}): ${result.stdout}\n${result.stderr}`);
  }
  return { ...result, body };
}

test("server launcher is exposed by the package and local two-client E2E keeps client state isolated", async (t) => {
  const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.bin["climier-server"], "./bin/climier-server.mjs");
  assert.ok(packageJson.files.includes("bin") && packageJson.files.includes("src"));

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-ops-e2e-"));
  const oldHome = process.env.CLIMIER_HOME;
  t.after(async () => {
    if (oldHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = oldHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  const serverHome = path.join(root, "server-home");
  const configFile = path.join(root, "server.json");
  await writePrivateConfig(configFile, {
    listen: { host: "127.0.0.1", port: 0 },
    dataRoot: path.join(root, "server-data"),
    stateHome: serverHome,
    projectIds: [projectId],
    credentials: [{ token, projectIds: [projectId] }],
  });
  const child = spawn(process.execPath, [serverLauncher, configFile], {
    env: { ...process.env, CLIMIER_HOME: path.join(root, "launcher-home") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => stopChild(child));
  const health = await waitForHealth(child);
  assert.deepEqual(Object.keys(health).sort(), ["host", "ok", "port"]);
  assert.equal(health.ok, true);
  assert.equal(health.host, "127.0.0.1");
  assert.ok(Number.isInteger(health.port) && health.port > 0);

  const serverUrl = `http://127.0.0.1:${health.port}`;
  const clientAHome = path.join(root, "client-a-home");
  const clientBHome = path.join(root, "client-b-home");
  const clientA = await writeClient(root, "client-a", serverUrl, clientAHome);
  const clientB = await writeClient(root, "client-b", serverUrl, clientBHome);
  const clientEnv = (home, extra = {}) => ({
    CLIMIER_HOME: home,
    CLIMIER_TOKEN: token,
    CLIMIER_REMOTE_ORIGIN: serverUrl,
    ...extra,
  });

  const initialized = await cli(clientA.projectDir, "init", [], clientEnv(clientAHome));
  assert.equal(initialized.code, 0, `remote init: ${JSON.stringify(initialized.body)}`);
  assert.deepEqual(await readSentinel(clientA.stateFile), sentinel);
  assert.deepEqual(await readSentinel(clientB.stateFile), sentinel);

  const initiative = await cli(clientA.projectDir, "add-initiative", ["remote-e2e", "--desc", "created by client A", "--as", "alice"], clientEnv(clientAHome));
  assert.equal(initiative.code, 0, `client A mutation: ${JSON.stringify(initiative.body)}`);
  const created = await cli(clientA.projectDir, "add-task", [
    "T-remote-e2e", "--initiative", "remote-e2e", "--title", "Created on server",
    "--body", "remote body", "--acceptance", "remote acceptance", "--blocked-by", "", "--as", "alice",
  ], clientEnv(clientAHome));
  assert.equal(created.code, 0, `client A task mutation: ${JSON.stringify(created.body)}`);
  const readByB = await cli(clientB.projectDir, "show", ["T-remote-e2e"], clientEnv(clientBHome));
  assert.equal(readByB.code, 0, `client B remote read: ${JSON.stringify(readByB.body)}`);
  assert.equal(readByB.body.node.title, "Created on server");
  assert.deepEqual(await readSentinel(clientA.stateFile), sentinel);
  assert.deepEqual(await readSentinel(clientB.stateFile), sentinel);

  const invalidToken = await cli(clientB.projectDir, "add-initiative", ["invalid-token-must-not-fallback", "--as", "bob"], clientEnv(clientBHome, { CLIMIER_TOKEN: "invalid-test-token" }));
  assert.notEqual(invalidToken.code, 0);
  assert.equal(invalidToken.body.error.code, "AUTH_INVALID");
  assert.deepEqual(await readSentinel(clientB.stateFile), sentinel);

  const unavailableUrl = "http://127.0.0.1:1";
  const clientBConfigFile = path.join(clientB.projectDir, ".climier.json");
  const clientBConfig = JSON.parse(await fs.readFile(clientBConfigFile, "utf8"));
  clientBConfig.backend.url = unavailableUrl;
  await fs.writeFile(clientBConfigFile, `${JSON.stringify(clientBConfig, null, 2)}\n`);
  const unavailable = await cli(clientB.projectDir, "add-initiative", ["offline-must-not-fallback", "--as", "bob"], clientEnv(clientBHome, {
    CLIMIER_REMOTE_ORIGIN: unavailableUrl,
  }));
  assert.notEqual(unavailable.code, 0);
  assert.equal(unavailable.body.error.code, "REMOTE_REQUEST_FAILED");
  assert.deepEqual(await readSentinel(clientB.stateFile), sentinel);
});
