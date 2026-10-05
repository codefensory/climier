#!/usr/bin/env node
/* oxlint-disable complexity, max-statements, max-lines-per-function -- this is a linear release-artifact smoke sequence. */
// Exercise the published artifact rather than the checkout's source tree.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectId = "smoke-packed-project";
const serverPassword = "smoke-packed-server-password";

async function command(file, args, options = {}) {
  try {
    const result = await execFileAsync(file, args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
    };
  }
}

function jsonOutput(result, label) {
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label}: expected JSON stdout, got ${JSON.stringify(result.stdout)} (${error.message})`, { cause: error });
  }
  return value;
}

async function waitForHealth(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`server health timeout: ${stderr}`)), 10_000);
    const finish = (callback) => {
      clearTimeout(timer);
      callback();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) {return;}
      finish(() => {
        try {
          resolve(JSON.parse(stdout.slice(0, newline)));
        } catch (error) {
          reject(new Error(`server health was not JSON: ${error.message}`));
        }
      });
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => finish(() => reject(new Error(`server exited before health (${code}): ${stderr}`))));
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {return;}
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startPackedUi(climier, projectDir, env, cwd) {
  const child = spawn(climier, ["--project", projectDir, "ui", "--open=false", "--port", "0"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error(`installed ui startup timed out: ${stderr}`)));
    }, 10_000);
    const finish = (callback) => {
      clearTimeout(timer);
      callback();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      try {
        const result = JSON.parse(stdout);
        finish(() => resolve({ child, result }));
      } catch {
        // Wait for the rest of the JSON output.
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => finish(() => reject(new Error(`installed ui exited before startup (${code}): ${stdout}${stderr}`))));
  });
}

async function seedRemoteSession(origin, clientHome) {
  const response = await fetch(`${origin}/v1/auth/login`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-climier-protocol-version": "1" },
    body: JSON.stringify({ password: serverPassword }),
  });
  const body = await response.json();
  if (!response.ok || body.ok !== true || typeof body.token !== "string" || body.token.length === 0) {
    throw new Error(`v1 login failed with HTTP ${response.status}`);
  }
  await fs.mkdir(clientHome, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {await fs.chmod(clientHome, 0o700);}
  const profile = { version: 1, sessions: { [origin]: { token: body.token } } };
  const profileFile = path.join(clientHome, "remote-sessions.json");
  await fs.writeFile(profileFile, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") {await fs.chmod(profileFile, 0o600);}
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-packed-smoke-"));
  let server;
  let uiChild;
  try {
    const destination = path.join(root, "pack");
    const prefix = path.join(root, "prefix");
    await fs.mkdir(destination, { recursive: true });
    const packed = await command("npm", ["pack", "--json", "--pack-destination", destination]);
    if (packed.code !== 0) {throw new Error(`npm pack failed: ${packed.stderr}`);}
    const report = jsonOutput(packed, "npm pack");
    const manifest = Array.isArray(report) ? report[0] : Object.values(report)[0];
    if (!manifest?.filename) {throw new Error(`npm pack returned no tarball filename: ${JSON.stringify(report)}`);}
    const tarball = path.join(destination, manifest.filename);

    const installed = await command("npm", ["install", "--prefix", prefix, "--no-save", "--no-audit", "--no-fund", "--ignore-scripts", tarball]);
    if (installed.code !== 0) {throw new Error(`npm install tarball failed: ${installed.stderr}`);}
    const packageRoot = path.join(prefix, "node_modules", "climier");
    const climier = path.join(prefix, "node_modules", ".bin", "climier");
    const serverBin = path.join(prefix, "node_modules", ".bin", "climier-server");
    await fs.access(packageRoot);
    await fs.access(climier);
    await fs.access(serverBin);

    const version = await command(climier, ["--version"], { cwd: root });
    if (version.code !== 0 || !/^\d+\.\d+\.\d+\n?$/.test(version.stdout)) {
      throw new Error(`installed climier --version failed: ${version.code} ${version.stdout} ${version.stderr}`);
    }

    const localProject = path.join(root, "local-project");
    const clientHome = path.join(root, "client-home");
    const clientEnv = { ...process.env, CLIMIER_HOME: clientHome };
    for (const name of Object.keys(clientEnv)) {
      if (name.startsWith("CLIMIER_") && name !== "CLIMIER_HOME") {delete clientEnv[name];}
    }
    await fs.mkdir(localProject, { recursive: true });
    await fs.writeFile(path.join(localProject, ".climier.json"), `${JSON.stringify({ version: 1, project_id: projectId }, null, 2)}\n`);
    const initialized = await command(climier, ["--project", localProject, "init"], { cwd: root, env: clientEnv });
    if (initialized.code !== 0) {throw new Error(`installed climier init failed: ${initialized.stderr}`);}
    const localInitiative = await command(climier, ["--project", localProject, "add-initiative", "packed-transfer", "--desc", "packed smoke", "--as", "smoke"], { cwd: root, env: clientEnv });
    if (localInitiative.code !== 0) {throw new Error(`installed local initiative failed: ${localInitiative.stdout}${localInitiative.stderr}`);}
    const localTask = await command(climier, ["--project", localProject, "add-task", "T-packed-transfer", "--initiative", "packed-transfer", "--title", "Packed local task", "--body", "seeded before remote link", "--acceptance", "push preserves this task", "--blocked-by", "", "--as", "smoke"], { cwd: root, env: clientEnv });
    if (localTask.code !== 0) {throw new Error(`installed local task failed: ${localTask.stdout}${localTask.stderr}`);}
    const localStatus = await command(climier, ["--project", localProject, "status"], { cwd: root, env: clientEnv });
    if (localStatus.code !== 0) {throw new Error(`installed climier status failed: ${localStatus.stderr}`);}
    jsonOutput(localStatus, "installed status");

    const dataRoot = path.join(root, "server-data");
    const stateHome = path.join(root, "server-home");
    const launcherHome = path.join(root, "launcher-home");
    const configFile = path.join(root, "server.json");
    await fs.writeFile(configFile, `${JSON.stringify({
      listen: { host: "127.0.0.1", port: 0 },
      dataRoot,
      stateHome,
    }, null, 2)}\n`, { mode: 0o600 });
    server = spawn(serverBin, [configFile], {
      cwd: root,
      env: { ...process.env, CLIMIER_HOME: launcherHome, CLIMIER_SERVER_PASSWORD: serverPassword },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const health = await waitForHealth(server);
    if (health.ok !== true || health.host !== "127.0.0.1" || !Number.isInteger(health.port)) {
      throw new Error(`invalid server health: ${JSON.stringify(health)}`);
    }
    const remoteUrl = `http://127.0.0.1:${health.port}`;
    const linked = await command(climier, ["--project", localProject, "link", remoteUrl], { cwd: root, env: clientEnv });
    if (linked.code !== 0) {throw new Error(`installed climier link failed: ${linked.stderr}`);}
    const remoteConfig = JSON.parse(await fs.readFile(path.join(localProject, ".climier.json"), "utf8"));
    if (
      remoteConfig.backend?.type !== "remote" ||
      remoteConfig.backend?.url !== new URL(remoteUrl).toString() ||
      remoteConfig.backend?.protocol !== undefined ||
      remoteConfig.project_id !== projectId
    ) {
      throw new Error(`link did not write the expected v1 project metadata without a protocol marker: ${JSON.stringify(remoteConfig)}`);
    }
    await seedRemoteSession(new URL(remoteUrl).origin, clientHome);
    const remoteInit = await command(climier, ["--project", localProject, "init"], { cwd: root, env: clientEnv });
    if (remoteInit.code !== 0) {throw new Error(`authorized remote init failed: ${remoteInit.stderr}`);}
    const remoteStatus = await command(climier, ["--project", localProject, "status"], { cwd: root, env: clientEnv });
    if (remoteStatus.code !== 0) {throw new Error(`authorized remote status failed: ${remoteStatus.stderr}`);}
    jsonOutput(remoteStatus, "authorized remote status");
    const pushed = await command(climier, ["--project", localProject, "push", "--as", "smoke"], { cwd: root, env: clientEnv });
    if (pushed.code !== 0) {throw new Error(`packed push failed: ${pushed.stdout}${pushed.stderr}`);}
    const pushResult = jsonOutput(pushed, "packed push");
    if (pushResult.transfer !== "push" || pushResult.project_id !== projectId || pushResult.forced !== false) {
      throw new Error(`packed push returned an invalid transfer summary: ${JSON.stringify(pushResult)}`);
    }
    const remoteTask = await command(climier, ["--project", localProject, "show", "T-packed-transfer"], { cwd: root, env: clientEnv });
    if (remoteTask.code !== 0 || jsonOutput(remoteTask, "packed remote task").node?.title !== "Packed local task") {
      throw new Error(`packed push did not publish the local task: ${remoteTask.stdout}${remoteTask.stderr}`);
    }
    const pulled = await command(climier, ["--project", localProject, "pull", "--as", "smoke"], { cwd: root, env: clientEnv });
    if (pulled.code !== 0) {throw new Error(`packed pull failed: ${pulled.stdout}${pulled.stderr}`);}
    const pullResult = jsonOutput(pulled, "packed pull");
    if (pullResult.transfer !== "pull" || pullResult.project_id !== projectId || pullResult.forced !== false) {
      throw new Error(`packed pull returned an invalid transfer summary: ${JSON.stringify(pullResult)}`);
    }

    const localMetadata = JSON.parse(await fs.readFile(path.join(localProject, ".climier.json"), "utf8"));
    delete localMetadata.backend;
    await fs.writeFile(path.join(localProject, ".climier.json"), `${JSON.stringify(localMetadata, null, 2)}\n`);
    const startedUi = await startPackedUi(climier, localProject, clientEnv, root);
    uiChild = startedUi.child;
    if (startedUi.result.ui?.read_only !== true || typeof startedUi.result.ui.url !== "string") {
      throw new Error(`installed ui returned an invalid startup envelope: ${JSON.stringify(startedUi.result)}`);
    }
    const uiResponse = await fetch(startedUi.result.ui.url);
    if (!uiResponse.ok || !uiResponse.headers.get("content-type")?.startsWith("text/html")) {
      throw new Error(`installed ui did not serve its packaged SPA: HTTP ${uiResponse.status}`);
    }
    const uiHtml = await uiResponse.text();
    if (!/<!doctype html>/i.test(uiHtml) || !/assets\//.test(uiHtml)) {
      throw new Error(`installed ui served an unexpected entry document: ${uiHtml.slice(0, 300)}`);
    }
    console.log("packed smoke: version, local init/status, Remote v1 init, push/pull transfer, and packaged UI startup passed");
  } finally {
    await stopServer(uiChild);
    await stopServer(server);
    await fs.rm(root, { recursive: true, force: true });
  }
}

await main();
