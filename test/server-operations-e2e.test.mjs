import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "./helpers.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliLauncher = path.join(repoRoot, "bin", "climier.mjs");
const serverLauncher = path.join(repoRoot, "bin", "climier-server.mjs");
const password = "remote-e2e-password";

const sentinel = {
  version: 1,
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
  if (process.platform !== "win32") {await fs.chmod(file, 0o600);}
}

function clientEnvironment(home) {
  const env = { ...process.env, CLIMIER_HOME: home };
  delete env.CLIMIER_TOKEN;
  delete env.CLIMIER_REMOTE_ORIGIN;
  return env;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function cli(projectDir, command, args, env) {
  const result = await runCli(["--project", projectDir, command, ...args], { env });
  let body;
  try {body = JSON.parse(result.stdout);}
  catch {assert.fail(`${command} output was not JSON (exit ${result.code}): ${result.stdout}\n${result.stderr}`);}
  return { ...result, body };
}

async function interactiveCli(projectDir, command, args, env, input) {
  const commandLine = [process.execPath, cliLauncher, "--project", projectDir, command, ...args]
    .map(shellQuote).join(" ");
  return new Promise((resolve, reject) => {
    const child = spawn("script", ["-qec", commandLine, "/dev/null"], {
      cwd: projectDir,
      env: { ...env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let sent = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (!sent && stdout.includes("Password: ")) {
        sent = true;
        child.stdin.end(`${input}\n`);
      }
    });
    child.stderr.on("data", (chunk) => {stderr += chunk.toString();});
    child.once("error", reject);
    child.once("close", (code) => {
      const start = stdout.indexOf("{");
      const end = stdout.lastIndexOf("}");
      let body;
      if (start >= 0 && end > start) {
        try {body = JSON.parse(stdout.slice(start, end + 1));} catch {}
      }
      if (body === undefined) {
        reject(new Error(`interactive ${command} output was not JSON (exit ${code}): ${stdout}\\n${stderr}`));
        return;
      }
      resolve({ code, stdout, stderr, body });
    });
  });
}

async function waitForHealth(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`server launcher health timeout: ${stderr}`)), 5_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) {return;}
      clearTimeout(timer);
      try {resolve(JSON.parse(stdout.slice(0, newline)));}
      catch (error) {reject(new Error(`server launcher returned invalid health JSON: ${error.message}`));}
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {stderr += chunk;});
    child.once("error", (error) => {clearTimeout(timer); reject(error);});
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server launcher exited before health report (${code}): ${stderr}`));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {return;}
  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("server launcher did not stop after SIGTERM"));
    }, 5_000);
    child.once("exit", () => {clearTimeout(timer); resolve();});
  });
}

async function startConfiguredServer(root, passwordValue, t, port = 0) {
  const configFile = path.join(root, "server.json");
  await writePrivateConfig(configFile, {
    listen: { host: "127.0.0.1", port },
    dataRoot: path.join(root, "server-data"),
    stateHome: path.join(root, "server-home"),
  });
  const child = spawn(process.execPath, [serverLauncher, configFile], {
    env: { ...process.env, CLIMIER_SERVER_PASSWORD: passwordValue, CLIMIER_HOME: path.join(root, "launcher-home") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => stopChild(child));
  const health = await waitForHealth(child);
  assert.deepEqual(Object.keys(health).toSorted(), ["host", "ok", "port"]);
  assert.equal(health.ok, true);
  assert.equal(health.host, "127.0.0.1");
  assert.ok(Number.isInteger(health.port) && health.port > 0);
  return { child, configFile, health, url: `http://127.0.0.1:${health.port}` };
}

async function linkClient(client, origin) {
  const result = await cli(client.projectDir, "link", [origin], client.env);
  assert.equal(result.code, 0, `link: ${JSON.stringify(result.body)}`);
  const metadata = JSON.parse(await fs.readFile(path.join(client.projectDir, ".climier.json"), "utf8"));
  assert.equal(metadata.backend.protocol, "v2");
  assert.equal(metadata.backend.url, new URL(origin).toString());
  return metadata;
}

async function loginClient(client) {
  const result = await interactiveCli(client.projectDir, "login", [], client.env, client.password);
  assert.equal(result.code, 0, `login: ${JSON.stringify(result.body)}\n${result.stdout}`);
  assert.equal(result.body.session.origin, client.origin);
  assert.equal(result.stdout.includes(client.password), false);
  const profileFile = path.join(client.home, "remote-sessions.json");
  const profile = JSON.parse(await fs.readFile(profileFile, "utf8"));
  const token = profile.sessions[client.origin]?.token;
  assert.equal(typeof token, "string");
  assert.equal(result.stdout.includes(token), false);
  return { profileFile, token };
}

async function makeClient(root, name, homeName = `${name}-home`) {
  const projectDir = path.join(root, name);
  const home = path.join(root, homeName);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, ".climier.json"), `${JSON.stringify({ version: 1, project_id: `remote-e2e-${name}` }, null, 2)}\n`);
  return { name, projectDir, home, env: clientEnvironment(home), password, origin: null };
}

async function clientStateFile(client) {
  const metadata = JSON.parse(await fs.readFile(path.join(client.projectDir, ".climier.json"), "utf8"));
  return path.join(client.home, "projects", metadata.project_id, "tasks.json");
}

async function writeSentinel(client) {
  const file = await clientStateFile(client);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(sentinel, null, 2)}\n`);
  return file;
}

async function readSentinel(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function cloneLinkedClient(source, target) {
  await fs.writeFile(
    path.join(target.projectDir, ".climier.json"),
    await fs.readFile(path.join(source.projectDir, ".climier.json"), "utf8"),
  );
}

test("v2 remote E2E links and logs in two clients, isolates project IDs, and fails closed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-ops-e2e-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const first = await startConfiguredServer(root, password, t);
  const clientA = await makeClient(root, "client-a");
  const clientB = await makeClient(root, "client-b");
  const clientC = await makeClient(root, "client-c");
  clientA.origin = first.url;
  clientB.origin = first.url;
  clientC.origin = first.url;

  const metadataA = await linkClient(clientA, first.url);
  await cloneLinkedClient(clientA, clientB);
  const metadataB = JSON.parse(await fs.readFile(path.join(clientB.projectDir, ".climier.json"), "utf8"));
  assert.equal(metadataB.project_id, metadataA.project_id);
  const metadataC = await linkClient(clientC, first.url);
  assert.notEqual(metadataC.project_id, metadataA.project_id);

  const stateA = await writeSentinel(clientA);
  const stateB = await writeSentinel(clientB);
  const stateC = await writeSentinel(clientC);
  await loginClient(clientA);
  await loginClient(clientB);
  await loginClient(clientC);

  const initialized = await cli(clientA.projectDir, "init", [], clientA.env);
  assert.equal(initialized.code, 0, `remote init: ${JSON.stringify(initialized.body)}`);
  assert.deepEqual(await readSentinel(stateA), sentinel);
  assert.deepEqual(await readSentinel(stateB), sentinel);
  assert.deepEqual(await readSentinel(stateC), sentinel);

  const initiative = await cli(clientA.projectDir, "add-initiative", ["remote-e2e", "--desc", "created by client A", "--as", "alice"], clientA.env);
  assert.equal(initiative.code, 0, `client A mutation: ${JSON.stringify(initiative.body)}`);
  const created = await cli(clientA.projectDir, "add-task", [
    "T-remote-e2e", "--initiative", "remote-e2e", "--title", "Created on server",
    "--body", "remote body", "--acceptance", "remote acceptance", "--blocked-by", "", "--as", "alice",
  ], clientA.env);
  assert.equal(created.code, 0, `client A task mutation: ${JSON.stringify(created.body)}`);
  const readByB = await cli(clientB.projectDir, "show", ["T-remote-e2e"], clientB.env);
  assert.equal(readByB.code, 0, `client B remote read: ${JSON.stringify(readByB.body)}`);
  assert.equal(readByB.body.node.title, "Created on server");
  const beforeUninitializedRead = await fs.readdir(path.join(root, "server-data"));
  const uninitializedRead = await cli(clientC.projectDir, "status", [], clientC.env);
  assert.notEqual(uninitializedRead.code, 0);
  assert.equal(uninitializedRead.body.error.code, "UNKNOWN_PROJECT");
  assert.deepEqual(await fs.readdir(path.join(root, "server-data")), beforeUninitializedRead);
  const isolatedInit = await cli(clientC.projectDir, "init", [], clientC.env);
  assert.equal(isolatedInit.code, 0, `isolated init: ${JSON.stringify(isolatedInit.body)}`);
  const isolated = await cli(clientC.projectDir, "show", ["T-remote-e2e"], clientC.env);
  assert.notEqual(isolated.code, 0);
  assert.equal(isolated.body.error.code, "NODE_NOT_FOUND");
  assert.deepEqual(await readSentinel(stateA), sentinel);
  assert.deepEqual(await readSentinel(stateB), sentinel);
  assert.deepEqual(await readSentinel(stateC), sentinel);

  const invalidProfile = JSON.parse(await fs.readFile(path.join(clientB.home, "remote-sessions.json"), "utf8"));
  invalidProfile.sessions[first.url].token = "invalid-test-token";
  await fs.writeFile(path.join(clientB.home, "remote-sessions.json"), `${JSON.stringify(invalidProfile, null, 2)}\n`);
  const invalidToken = await cli(clientB.projectDir, "add-initiative", ["invalid-token-must-not-fallback", "--as", "bob"], clientB.env);
  assert.notEqual(invalidToken.code, 0);
  assert.equal(invalidToken.body.error.code, "AUTH_INVALID");
  assert.deepEqual(await readSentinel(stateB), sentinel);

  await stopChild(first.child);
  const serviceLock = path.join(root, "server-home", ".server.lock");
  await fs.rm(serviceLock, { force: true });
  assert.equal(first.child.exitCode, 0);
  const second = await startConfiguredServer(root, "rotated-password", t, first.health.port);
  const staleToken = await cli(clientA.projectDir, "show", ["T-remote-e2e"], clientA.env);
  assert.notEqual(staleToken.code, 0);
  assert.equal(staleToken.body.error.code, "AUTH_INVALID");
  clientA.password = "rotated-password";
  const refreshed = await loginClient(clientA);
  assert.notEqual(refreshed.token, "");
  const afterRotation = await cli(clientA.projectDir, "show", ["T-remote-e2e"], clientA.env);
  assert.equal(afterRotation.code, 0, `rotated login: ${JSON.stringify(afterRotation.body)}`);

  const v1Client = await makeClient(root, "client-v1");
  const v1Meta = { version: 1, project_id: metadataA.project_id, backend: { type: "remote", url: second.url } };
  await fs.writeFile(path.join(v1Client.projectDir, ".climier.json"), `${JSON.stringify(v1Meta, null, 2)}\n`);
  const v1State = await writeSentinel(v1Client);
  const outdated = await cli(v1Client.projectDir, "status", [], v1Client.env);
  assert.notEqual(outdated.code, 0);
  assert.equal(outdated.body.error.code, "REMOTE_CONFIG_OUTDATED");
  assert.deepEqual(await readSentinel(v1State), sentinel);

  const unavailableClient = await makeClient(root, "client-unavailable");
  const unavailableMeta = { version: 1, project_id: metadataA.project_id, backend: { type: "remote", url: "http://127.0.0.1:1", protocol: "v2" } };
  await fs.writeFile(path.join(unavailableClient.projectDir, ".climier.json"), `${JSON.stringify(unavailableMeta, null, 2)}\n`);
  const unavailableState = await writeSentinel(unavailableClient);
  const unavailable = await cli(unavailableClient.projectDir, "add-initiative", ["offline-must-not-fallback", "--as", "bob"], unavailableClient.env);
  assert.notEqual(unavailable.code, 0);
  assert.equal(unavailable.body.error.code, "REMOTE_REQUEST_FAILED");
  assert.deepEqual(await readSentinel(unavailableState), sentinel);

  const initForce = await cli(clientA.projectDir, "init", ["--force"], clientA.env);
  assert.notEqual(initForce.code, 0);
  assert.equal(initForce.body.error.code, "REMOTE_UNSUPPORTED_OPERATION");
});
