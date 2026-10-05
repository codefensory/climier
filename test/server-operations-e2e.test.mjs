import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createRemoteTransferBaselineStore } from "../src/storage/remote-transfer-baseline.mjs";
import { runCli, writeCanonicalState } from "./helpers.mjs";

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

async function startResponseDroppingProxy(origin, t) {
  const proxy = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) {chunks.push(chunk);}
      const upstream = await fetch(new URL(request.url, origin), {
        method: request.method,
        headers: { ...request.headers, host: new URL(origin).host },
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      if (request.url.includes("/transfer/import") && upstream.ok) {
        response.destroy();
        return;
      }
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
      response.end(body);
    } catch {
      response.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  return `http://127.0.0.1:${proxy.address().port}`;
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
  assert.equal(metadata.backend.protocol, undefined);
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

async function selectLocalBackend(client) {
  const metadataFile = path.join(client.projectDir, ".climier.json");
  const metadata = JSON.parse(await fs.readFile(metadataFile, "utf8"));
  delete metadata.backend;
  await fs.writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function seedPluginData(client) {
  const file = await clientStateFile(client);
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = client.home;
  try {
    await writeCanonicalState(client.projectDir, {
      ...state,
      plugins: { transferFixture: { data: { marker: "project-data" } } },
      nodes: {
        ...state.nodes,
        "T-transfer-local": {
          ...state.nodes["T-transfer-local"],
          plugins: { transferFixture: { data: { marker: "node-data" } } },
        },
      },
    });
  } finally {
    if (previousHome === undefined) {delete process.env.CLIMIER_HOME;}
    else {process.env.CLIMIER_HOME = previousHome;}
  }
}

function remoteStateDirectory(root, projectId) {
  const internalId = createHash("sha256").update(projectId, "utf8").digest("hex");
  return path.join(root, "server-home", "projects", internalId);
}

test("v1 transfer E2E bootstraps, supports offline work, detects divergence, and makes force replacement visible", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-transfer-e2e-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const server = await startConfiguredServer(root, password, t);
  const client = await makeClient(root, "transfer-client");
  client.origin = server.url;

  const localInit = await cli(client.projectDir, "init", [], client.env);
  assert.equal(localInit.code, 0, `local init: ${JSON.stringify(localInit.body)}`);
  const initiative = await cli(client.projectDir, "add-initiative", ["offline", "--desc", "local DAG", "--as", "alice"], client.env);
  assert.equal(initiative.code, 0, `local initiative: ${JSON.stringify(initiative.body)}`);
  const task = await cli(client.projectDir, "add-task", [
    "T-transfer-local", "--initiative", "offline", "--title", "Local task",
    "--body", "created before link", "--acceptance", "preserved by push", "--blocked-by", "", "--as", "alice",
  ], client.env);
  assert.equal(task.code, 0, `local task: ${JSON.stringify(task.body)}`);
  const claim = await cli(client.projectDir, "take", ["T-transfer-local", "--as", "alice"], client.env);
  assert.equal(claim.code, 0, `local claim: ${JSON.stringify(claim.body)}`);
  await seedPluginData(client);

  const projectId = JSON.parse(await fs.readFile(path.join(client.projectDir, ".climier.json"), "utf8")).project_id;
  const serverProject = remoteStateDirectory(root, projectId);
  await linkClient(client, server.url);
  await loginClient(client);
  const remoteInit = await cli(client.projectDir, "init", [], client.env);
  assert.equal(remoteInit.code, 0, `remote init: ${JSON.stringify(remoteInit.body)}`);
  const initializedServerState = JSON.parse(await fs.readFile(path.join(serverProject, "tasks.json"), "utf8"));
  const initialFence = initializedServerState.fence_generation;
  const pushed = await cli(client.projectDir, "push", ["--as", "alice"], client.env);
  assert.equal(pushed.code, 0, `first push: ${JSON.stringify(pushed.body)}`);
  assert.equal(pushed.body.transfer, "push");
  assert.equal(pushed.body.project_id, projectId);
  assert.equal(pushed.body.forced, false);
  let remoteState = JSON.parse(await fs.readFile(path.join(serverProject, "tasks.json"), "utf8"));
  let remoteLedger = JSON.parse(await fs.readFile(path.join(serverProject, "revision-ledger.json"), "utf8"));
  assert.equal(remoteState.fence_generation, initialFence);
  assert.equal(remoteLedger.fence_generation, initialFence);
  assert.equal(remoteLedger.high_water_revision, remoteState.revision);
  assert.equal(remoteState.nodes["T-transfer-local"].status, "in_progress");
  assert.equal(remoteState.nodes["T-transfer-local"].claim.by, "alice");
  assert.deepEqual(remoteState.plugins, { transferFixture: { data: { marker: "project-data" } } });
  assert.deepEqual(remoteState.nodes["T-transfer-local"].plugins, { transferFixture: { data: { marker: "node-data" } } });
  const pulled = await cli(client.projectDir, "pull", ["--as", "alice"], client.env);
  assert.equal(pulled.code, 0, `pull after push: ${JSON.stringify(pulled.body)}`);
  assert.equal(pulled.body.transfer, "pull");
  const localStateAfterPull = JSON.parse(await fs.readFile(await clientStateFile(client), "utf8"));
  assert.equal(localStateAfterPull.nodes["T-transfer-local"].status, "in_progress");
  assert.equal(localStateAfterPull.nodes["T-transfer-local"].claim.by, "alice");
  assert.deepEqual(localStateAfterPull.plugins, { transferFixture: { data: { marker: "project-data" } } });
  assert.deepEqual(localStateAfterPull.nodes["T-transfer-local"].plugins, { transferFixture: { data: { marker: "node-data" } } });

  await selectLocalBackend(client);
  const localStatus = await cli(client.projectDir, "status", [], client.env);
  assert.equal(localStatus.code, 0, `offline local status: ${JSON.stringify(localStatus.body)}`);
  const offlineTask = await cli(client.projectDir, "add-task", [
    "T-transfer-offline", "--initiative", "offline", "--title", "Offline task",
    "--body", "created without backend metadata", "--acceptance", "pushed after reconnect", "--blocked-by", "", "--as", "bob",
  ], client.env);
  assert.equal(offlineTask.code, 0, `offline task: ${JSON.stringify(offlineTask.body)}`);
  await linkClient(client, server.url);
  const reconnectedPush = await cli(client.projectDir, "push", ["--as", "bob"], client.env);
  assert.equal(reconnectedPush.code, 0, `reconnected push: ${JSON.stringify(reconnectedPush.body)}`);
  const remoteOfflineTask = await cli(client.projectDir, "show", ["T-transfer-offline"], client.env);
  assert.equal(remoteOfflineTask.code, 0, `remote offline task: ${JSON.stringify(remoteOfflineTask.body)}`);
  assert.equal(remoteOfflineTask.body.node.title, "Offline task");

  const remoteOnly = await cli(client.projectDir, "add-note", ["T-transfer-local", "REMOTE-ONLY-LOG-MARKER", "--as", "remote-agent"], client.env);
  assert.equal(remoteOnly.code, 0, `remote divergent note: ${JSON.stringify(remoteOnly.body)}`);
  remoteState = JSON.parse(await fs.readFile(path.join(serverProject, "tasks.json"), "utf8"));
  assert.ok(remoteState.log.some((entry) => entry.action === "note.add" && entry.agent === "remote-agent"));
  await selectLocalBackend(client);
  const localOnly = await cli(client.projectDir, "add-note", ["T-transfer-local", "LOCAL-ONLY-LOG-MARKER", "--as", "local-agent"], client.env);
  assert.equal(localOnly.code, 0, `local divergent note: ${JSON.stringify(localOnly.body)}`);
  await linkClient(client, server.url);
  const baselineStore = createRemoteTransferBaselineStore({ home: client.home });
  const baselineBeforeConflict = await baselineStore.get(new URL(server.url).origin, projectId);
  const rejectedPush = await cli(client.projectDir, "push", ["--as", "alice"], client.env);
  assert.notEqual(rejectedPush.code, 0);
  assert.equal(rejectedPush.body.error.code, "TRANSFER_REMOTE_CHANGED");
  assert.deepEqual(await baselineStore.get(new URL(server.url).origin, projectId), baselineBeforeConflict);
  const rejectedPull = await cli(client.projectDir, "pull", ["--as", "alice"], client.env);
  assert.notEqual(rejectedPull.code, 0);
  assert.equal(rejectedPull.body.error.code, "TRANSFER_LOCAL_CHANGED");
  assert.deepEqual(await baselineStore.get(new URL(server.url).origin, projectId), baselineBeforeConflict);

  const forcedPush = await cli(client.projectDir, "push", ["--as", "alice", "--force"], client.env);
  assert.equal(forcedPush.code, 0, `forced push: ${JSON.stringify(forcedPush.body)}`);
  remoteState = JSON.parse(await fs.readFile(path.join(serverProject, "tasks.json"), "utf8"));
  remoteLedger = JSON.parse(await fs.readFile(path.join(serverProject, "revision-ledger.json"), "utf8"));
  assert.equal(remoteState.fence_generation, initialFence);
  assert.equal(remoteLedger.fence_generation, initialFence);
  assert.equal(remoteLedger.high_water_revision, remoteState.revision);
  assert.equal(remoteState.nodes["T-transfer-offline"].title, "Offline task");
  assert.ok(remoteState.log.some((entry) => entry.action === "transfer.push" && entry.agent === "alice" && Number.isInteger(entry.replaced_revision)));
  assert.ok(!remoteState.log.some((entry) => entry.action === "note.add" && entry.agent === "remote-agent"), "push force deliberately discards the destination-only log");

  const authProfileFile = path.join(client.home, "remote-sessions.json");
  const authProfile = JSON.parse(await fs.readFile(authProfileFile, "utf8"));
  const savedToken = authProfile.sessions[new URL(server.url).origin].token;
  authProfile.sessions[new URL(server.url).origin].token = "invalid-transfer-token";
  await fs.writeFile(authProfileFile, `${JSON.stringify(authProfile, null, 2)}\n`);
  const markerBeforeAuthError = await baselineStore.get(new URL(server.url).origin, projectId);
  const invalidAuthPush = await cli(client.projectDir, "push", ["--as", "alice"], client.env);
  assert.notEqual(invalidAuthPush.code, 0);
  assert.equal(invalidAuthPush.body.error.code, "AUTH_INVALID");
  assert.deepEqual(await baselineStore.get(new URL(server.url).origin, projectId), markerBeforeAuthError);
  authProfile.sessions[new URL(server.url).origin].token = savedToken;
  await fs.writeFile(authProfileFile, `${JSON.stringify(authProfile, null, 2)}\n`);
  await selectLocalBackend(client);
  await cli(client.projectDir, "add-note", ["T-transfer-local", "LOCAL-ONLY-BEFORE-PULL-FORCE", "--as", "offline-agent"], client.env);
  await linkClient(client, server.url);
  await cli(client.projectDir, "add-note", ["T-transfer-local", "REMOTE-ONLY-BEFORE-PULL-FORCE", "--as", "remote-agent"], client.env);
  const forcedPull = await cli(client.projectDir, "pull", ["--as", "alice", "--force"], client.env);
  assert.equal(forcedPull.code, 0, `forced pull: ${JSON.stringify(forcedPull.body)}`);
  const localStateAfterForcedPull = JSON.parse(await fs.readFile(await clientStateFile(client), "utf8"));
  const localLedgerAfterForcedPull = JSON.parse(await fs.readFile(path.join(client.home, "projects", projectId, "revision-ledger.json"), "utf8"));
  assert.ok(localStateAfterForcedPull.log.some((entry) => entry.action === "note.add" && entry.agent === "remote-agent"));
  assert.ok(!localStateAfterForcedPull.log.some((entry) => entry.action === "note.add" && entry.agent === "offline-agent"), "pull force deliberately discards the destination-only log");
  assert.ok(localStateAfterForcedPull.log.some((entry) => entry.action === "transfer.pull" && entry.agent === "alice" && Number.isInteger(entry.replaced_revision)));
  assert.equal(localStateAfterForcedPull.fence_generation, initializedServerState.fence_generation);
  assert.equal(localLedgerAfterForcedPull.fence_generation, initializedServerState.fence_generation);
  assert.equal(localLedgerAfterForcedPull.high_water_revision, localStateAfterForcedPull.revision);
  remoteState = JSON.parse(await fs.readFile(path.join(serverProject, "tasks.json"), "utf8"));
  remoteLedger = JSON.parse(await fs.readFile(path.join(serverProject, "revision-ledger.json"), "utf8"));
  assert.equal(remoteState.fence_generation, initialFence);
  assert.equal(remoteLedger.fence_generation, initialFence);
  assert.equal(remoteLedger.high_water_revision, remoteState.revision);
});

test("v1 transfer E2E never provisions via push and leaves baselines unchanged on failure or ambiguous timeout", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-transfer-failures-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = await startConfiguredServer(root, password, t);

  const absent = await makeClient(root, "transfer-absent");
  absent.origin = server.url;
  assert.equal((await cli(absent.projectDir, "init", [], absent.env)).code, 0);
  assert.equal((await cli(absent.projectDir, "add-initiative", ["local", "--as", "alice"], absent.env)).code, 0);
  assert.equal((await cli(absent.projectDir, "add-task", [
    "T-absent-source", "--initiative", "local", "--title", "Source",
    "--body", "local source", "--acceptance", "kept", "--blocked-by", "", "--as", "alice",
  ], absent.env)).code, 0);
  const absentId = JSON.parse(await fs.readFile(path.join(absent.projectDir, ".climier.json"), "utf8")).project_id;
  await linkClient(absent, server.url);
  await loginClient(absent);
  const absentBaseline = createRemoteTransferBaselineStore({ home: absent.home });
  const absentPush = await cli(absent.projectDir, "push", ["--as", "alice"], absent.env);
  assert.notEqual(absentPush.code, 0);
  assert.equal(absentPush.body.error.code, "UNKNOWN_PROJECT");
  assert.equal(await absentBaseline.get(new URL(server.url).origin, absentId), null);
  const absentRead = await cli(absent.projectDir, "status", [], absent.env);
  assert.notEqual(absentRead.code, 0);
  assert.equal(absentRead.body.error.code, "UNKNOWN_PROJECT");
  await selectLocalBackend(absent);
  const absentLocalRead = await cli(absent.projectDir, "show", ["T-absent-source"], absent.env);
  assert.equal(absentLocalRead.code, 0);
  assert.equal(absentLocalRead.body.node.title, "Source");

  const noBase = await makeClient(root, "transfer-no-base");
  noBase.origin = server.url;
  assert.equal((await cli(noBase.projectDir, "init", [], noBase.env)).code, 0);
  assert.equal((await cli(noBase.projectDir, "add-initiative", ["local", "--as", "alice"], noBase.env)).code, 0);
  assert.equal((await cli(noBase.projectDir, "add-task", [
    "T-no-base-source", "--initiative", "local", "--title", "Source",
    "--body", "local source", "--acceptance", "kept", "--blocked-by", "", "--as", "alice",
  ], noBase.env)).code, 0);
  const noBaseId = JSON.parse(await fs.readFile(path.join(noBase.projectDir, ".climier.json"), "utf8")).project_id;
  await linkClient(noBase, server.url);
  await loginClient(noBase);
  assert.equal((await cli(noBase.projectDir, "init", [], noBase.env)).code, 0);
  const remoteInitiative = await cli(noBase.projectDir, "add-initiative", ["remote-only", "--desc", "must not be replaced", "--as", "remote"], noBase.env);
  assert.equal(remoteInitiative.code, 0, JSON.stringify(remoteInitiative.body));
  const noBaseBaseline = createRemoteTransferBaselineStore({ home: noBase.home });
  const noBasePush = await cli(noBase.projectDir, "push", ["--as", "alice"], noBase.env);
  assert.notEqual(noBasePush.code, 0);
  assert.equal(noBasePush.body.error.code, "TRANSFER_BASE_UNKNOWN");
  assert.equal(await noBaseBaseline.get(new URL(server.url).origin, noBaseId), null);
  const remoteOnly = await cli(noBase.projectDir, "initiatives", ["--all"], noBase.env);
  assert.equal(remoteOnly.code, 0);
  assert.ok(remoteOnly.body.initiatives.some((item) => item.name === "remote-only"));

  const timeoutClient = await makeClient(root, "transfer-timeout");
  assert.equal((await cli(timeoutClient.projectDir, "init", [], timeoutClient.env)).code, 0);
  assert.equal((await cli(timeoutClient.projectDir, "add-initiative", ["local", "--as", "alice"], timeoutClient.env)).code, 0);
  assert.equal((await cli(timeoutClient.projectDir, "add-task", [
    "T-timeout-source", "--initiative", "local", "--title", "Ambiguous source",
    "--body", "local source", "--acceptance", "server may apply", "--blocked-by", "", "--as", "alice",
  ], timeoutClient.env)).code, 0);
  const timeoutId = JSON.parse(await fs.readFile(path.join(timeoutClient.projectDir, ".climier.json"), "utf8")).project_id;
  timeoutClient.origin = await startResponseDroppingProxy(server.url, t);
  await linkClient(timeoutClient, timeoutClient.origin);
  await loginClient(timeoutClient);
  assert.equal((await cli(timeoutClient.projectDir, "init", [], timeoutClient.env)).code, 0);
  const timeoutBaseline = createRemoteTransferBaselineStore({ home: timeoutClient.home });
  const timedOutPush = await cli(timeoutClient.projectDir, "push", ["--as", "alice"], timeoutClient.env);
  assert.notEqual(timedOutPush.code, 0);
  assert.equal(timedOutPush.body.error.code, "REMOTE_REQUEST_FAILED");
  assert.equal(timedOutPush.body.error.details.remote_result_ambiguous, true);
  assert.equal(await timeoutBaseline.get(new URL(timeoutClient.origin).origin, timeoutId), null);
  const appliedDespiteTimeout = JSON.parse(await fs.readFile(path.join(remoteStateDirectory(root, timeoutId), "tasks.json"), "utf8"));
  assert.ok(appliedDespiteTimeout.nodes["T-timeout-source"]);
  assert.ok(appliedDespiteTimeout.log.some((entry) => entry.action === "transfer.push"));
});

test("v1 remote E2E links and logs in two clients, isolates project IDs, and fails closed", async (t) => {
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
  await assert.rejects(fs.access(serviceLock), { code: "ENOENT" }, "normal SIGTERM should release the service lock");
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

  const cleanClient = await makeClient(root, "client-clean");
  const cleanMeta = { version: 1, project_id: metadataA.project_id, backend: { type: "remote", url: second.url } };
  await fs.writeFile(path.join(cleanClient.projectDir, ".climier.json"), `${JSON.stringify(cleanMeta, null, 2)}\n`);
  const cleanState = await writeSentinel(cleanClient);
  const unauthenticated = await cli(cleanClient.projectDir, "status", [], cleanClient.env);
  assert.notEqual(unauthenticated.code, 0);
  assert.equal(unauthenticated.body.error.code, "AUTH_REQUIRED");
  assert.deepEqual(await readSentinel(cleanState), sentinel);

  const unavailableClient = await makeClient(root, "client-unavailable");
  const unavailableMeta = { version: 1, project_id: metadataA.project_id, backend: { type: "remote", url: "http://127.0.0.1:1" } };
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
