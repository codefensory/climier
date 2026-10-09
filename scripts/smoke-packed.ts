#!/usr/bin/env bun
/* oxlint-disable complexity, max-statements, max-lines-per-function -- this is a linear release-artifact smoke sequence. */
// Exercise the published artifact rather than the checkout's source tree.
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectId = "smoke-packed-project";
const serverPassword = "smoke-packed-server-password";
type PipedChild = ChildProcessByStdio<null, Readable, Readable>;
type CommandResult = { code: number; stdout: string; stderr: string };
type CommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv; encoding?: BufferEncoding; maxBuffer?: number };
type ExecFailure = { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
type Health = { ok: boolean; host: string; port: number };
type UiStartup = { ui?: { read_only?: unknown; url?: unknown } };
type TransferSummary = { transfer: string; project_id: string; forced: boolean };

function failureDetails(error: unknown): ExecFailure {
  return typeof error === "object" && error !== null ? error as ExecFailure : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function command(file: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  try {
    const result = await execFileAsync(file, args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = failureDetails(error);
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : errorMessage(error),
    };
  }
}

function jsonOutput<T>(result: CommandResult, label: string): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(`${label}: expected JSON stdout, got ${JSON.stringify(result.stdout)} (${errorMessage(error)})`, { cause: error });
  }
}

async function waitForHealth(child: PipedChild): Promise<Health> {
  return new Promise<Health>((resolve, reject) => {
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
          resolve(JSON.parse(stdout.slice(0, newline)) as Health);
        } catch (error) {
          reject(new Error(`server health was not JSON: ${errorMessage(error)}`));
        }
      });
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => finish(() => reject(new Error(`server exited before health (${code}): ${stderr}`))));
  });
}

async function stopServer(child: PipedChild | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {return;}
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
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

async function startPackedUi(climier: string, projectDir: string, env: NodeJS.ProcessEnv, cwd: string): Promise<{ child: PipedChild; result: UiStartup }> {
  const child = spawn(climier, ["--project", projectDir, "ui", "--open=false", "--port", "0"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  return new Promise<{ child: PipedChild; result: UiStartup }>((resolve, reject) => {
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
        finish(() => resolve({ child, result: result as UiStartup }));
      } catch {
        // Wait for the rest of the JSON output.
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => finish(() => reject(new Error(`installed ui exited before startup (${code}): ${stdout}${stderr}`))));
  });
}

async function seedRemoteSession(origin: string, clientHome: string): Promise<void> {
  const response = await fetch(`${origin}/v1/auth/login`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-climier-protocol-version": "1" },
    body: JSON.stringify({ password: serverPassword }),
  });
  const body = await response.json() as { ok?: unknown; token?: unknown };
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
  let server: PipedChild | undefined;
  let uiChild: PipedChild | undefined;
  try {
    const destination = path.join(root, "pack");
    const prefix = path.join(root, "prefix");
    await fs.mkdir(destination, { recursive: true });
    await fs.mkdir(prefix, { recursive: true });
    const packed = await command("bun", ["pm", "pack", "--destination", destination]);
    if (packed.code !== 0) {throw new Error(`bun pm pack failed: ${packed.stderr}`);}
    const tarball = packed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.endsWith(".tgz") && path.isAbsolute(line));
    if (!tarball) {throw new Error(`bun pm pack returned no tarball filename: ${packed.stdout}`);}

    const installed = await command("bun", ["add", "--cwd", prefix, "--no-save", tarball]);
    if (installed.code !== 0) {throw new Error(`bun add tarball failed: ${installed.stderr}`);}
    const packageRoot = path.join(prefix, "node_modules", "climier");
    const climier = path.join(prefix, "node_modules", ".bin", "climier");
    const serverBin = path.join(prefix, "node_modules", ".bin", "climier-server");
    await fs.access(packageRoot);
    await fs.access(climier);
    await fs.access(serverBin);

    const version = await command(climier, ["--version"], { cwd: root });
    const strictSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\n?$/;
    if (version.code !== 0 || !strictSemver.test(version.stdout)) {
      throw new Error(`installed climier --version failed: ${version.code} ${version.stdout} ${version.stderr}`);
    }
    const versionJson = await command(climier, ["version", "--json"], { cwd: root });
    const metadata = jsonOutput<Record<string, unknown>>(versionJson, "installed version --json");
    if (versionJson.code !== 0 || metadata.version !== version.stdout.trim() || metadata.distribution !== "npm") {
      throw new Error(`installed version --json returned invalid metadata: ${versionJson.code} ${JSON.stringify(metadata)} ${versionJson.stderr}`);
    }

    const sourceVersion = await command("bun", [path.join(repoRoot, "bin", "climier.ts"), "version", "--json"], { cwd: repoRoot });
    const sourceMetadata = jsonOutput<Record<string, unknown>>(sourceVersion, "source-link version --json");
    if (sourceVersion.code !== 0 || sourceMetadata.distribution !== "source-link") {
      throw new Error(`checkout version --json returned invalid metadata: ${sourceVersion.code} ${JSON.stringify(sourceMetadata)} ${sourceVersion.stderr}`);
    }

    const oneOffRoot = path.join(root, "one-off");
    await fs.cp(packageRoot, oneOffRoot, { recursive: true });
    const oneOffVersion = await command("bun", [path.join(oneOffRoot, "bin", "climier.ts"), "version", "--json"], { cwd: root });
    const oneOffMetadata = jsonOutput<Record<string, unknown>>(oneOffVersion, "one-off version --json");
    if (oneOffVersion.code !== 0 || oneOffMetadata.distribution !== "one-off") {
      throw new Error(`copied package version --json returned invalid metadata: ${oneOffVersion.code} ${JSON.stringify(oneOffMetadata)} ${oneOffVersion.stderr}`);
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
    const pushResult = jsonOutput<TransferSummary>(pushed, "packed push");
    if (pushResult.transfer !== "push" || pushResult.project_id !== projectId || pushResult.forced !== false) {
      throw new Error(`packed push returned an invalid transfer summary: ${JSON.stringify(pushResult)}`);
    }
    const remoteTask = await command(climier, ["--project", localProject, "show", "T-packed-transfer"], { cwd: root, env: clientEnv });
    if (remoteTask.code !== 0 || jsonOutput<{ node?: { title?: string } }>(remoteTask, "packed remote task").node?.title !== "Packed local task") {
      throw new Error(`packed push did not publish the local task: ${remoteTask.stdout}${remoteTask.stderr}`);
    }
    const pulled = await command(climier, ["--project", localProject, "pull", "--as", "smoke"], { cwd: root, env: clientEnv });
    if (pulled.code !== 0) {throw new Error(`packed pull failed: ${pulled.stdout}${pulled.stderr}`);}
    const pullResult = jsonOutput<TransferSummary>(pulled, "packed pull");
    if (pullResult.transfer !== "pull" || pullResult.project_id !== projectId || pullResult.forced !== false) {
      throw new Error(`packed pull returned an invalid transfer summary: ${JSON.stringify(pullResult)}`);
    }

    const localMetadata = JSON.parse(await fs.readFile(path.join(localProject, ".climier.json"), "utf8"));
    delete localMetadata.backend;
    await fs.writeFile(path.join(localProject, ".climier.json"), `${JSON.stringify(localMetadata, null, 2)}\n`);
    const startedUi = await startPackedUi(climier, localProject, clientEnv, root);
    uiChild = startedUi.child;
    const ui = startedUi.result.ui;
    if (!ui || ui.read_only !== true || typeof ui.url !== "string") {
      throw new Error(`installed ui returned an invalid startup envelope: ${JSON.stringify(startedUi.result)}`);
    }
    const uiResponse = await fetch(ui.url);
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
