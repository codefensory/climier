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
const token = "smoke-packed-token";
const projectId = "smoke-packed-project";

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

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-packed-smoke-"));
  let server;
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
    const initialized = await command(climier, ["--project", localProject, "init"], { cwd: root, env: { ...process.env, CLIMIER_HOME: path.join(root, "local-home") } });
    if (initialized.code !== 0) {throw new Error(`installed climier init failed: ${initialized.stderr}`);}
    const localStatus = await command(climier, ["--project", localProject, "status"], { cwd: root, env: { ...process.env, CLIMIER_HOME: path.join(root, "local-home") } });
    if (localStatus.code !== 0) {throw new Error(`installed climier status failed: ${localStatus.stderr}`);}
    jsonOutput(localStatus, "installed status");

    const dataRoot = path.join(root, "server-data");
    const stateHome = path.join(root, "server-home");
    const launcherHome = path.join(root, "launcher-home");
    const serverProject = path.join(root, "remote-project");
    const configFile = path.join(root, "server.json");
    await fs.mkdir(serverProject, { recursive: true });
    await fs.writeFile(path.join(serverProject, ".climier.json"), `${JSON.stringify({ version: 1, project_id: projectId, backend: { type: "remote", url: "http://127.0.0.1:0" } }, null, 2)}\n`);
    await fs.writeFile(configFile, `${JSON.stringify({
      listen: { host: "127.0.0.1", port: 0 },
      dataRoot,
      stateHome,
      projectIds: [projectId],
      credentials: [{ token, projectIds: [projectId] }],
    }, null, 2)}\n`, { mode: 0o600 });
    server = spawn(serverBin, [configFile], { cwd: root, env: { ...process.env, CLIMIER_HOME: launcherHome }, stdio: ["ignore", "pipe", "pipe"] });
    const health = await waitForHealth(server);
    if (health.ok !== true || health.host !== "127.0.0.1" || !Number.isInteger(health.port)) {
      throw new Error(`invalid server health: ${JSON.stringify(health)}`);
    }
    const remoteUrl = `http://127.0.0.1:${health.port}`;
    const remoteConfig = JSON.parse(await fs.readFile(path.join(serverProject, ".climier.json"), "utf8"));
    remoteConfig.backend.url = remoteUrl;
    await fs.writeFile(path.join(serverProject, ".climier.json"), `${JSON.stringify(remoteConfig, null, 2)}\n`);
    const remoteEnv = { ...process.env, CLIMIER_HOME: path.join(root, "client-home"), CLIMIER_TOKEN: token, CLIMIER_REMOTE_ORIGIN: remoteUrl };
    const remoteInit = await command(climier, ["--project", serverProject, "init"], { cwd: root, env: remoteEnv });
    if (remoteInit.code !== 0) {throw new Error(`authorized remote init failed: ${remoteInit.stderr}`);}
    const remoteStatus = await command(climier, ["--project", serverProject, "status"], { cwd: root, env: remoteEnv });
    if (remoteStatus.code !== 0) {throw new Error(`authorized remote status failed: ${remoteStatus.stderr}`);}
    jsonOutput(remoteStatus, "authorized remote status");

    const ui = await command(climier, ["--project", localProject, "ui", "--open=false"], { cwd: root, env: { ...process.env, CLIMIER_HOME: path.join(root, "local-home") } });
    if (ui.code === 0) {throw new Error("installed ui unexpectedly succeeded without the UI subproject");}
    const uiBody = jsonOutput(ui, "installed ui failure");
    if (uiBody.ok !== false || uiBody.error?.code !== "UI_SUBPROJECT_MISSING") {
      throw new Error(`installed ui did not return actionable envelope: ${JSON.stringify(uiBody)}`);
    }
    if (/Cannot find (?:package|module)|ERR_MODULE_NOT_FOUND|\n\s+at\s/.test(ui.stdout + ui.stderr)) {
      throw new Error(`installed ui leaked module-resolution failure: ${ui.stdout}${ui.stderr}`);
    }
    console.log("packed smoke: version, local init/status, authorized server request, and experimental ui failure passed");
  } finally {
    await stopServer(server);
    await fs.rm(root, { recursive: true, force: true });
  }
}

await main();
