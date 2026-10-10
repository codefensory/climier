import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetNames = {
  linux: { x64: "linux-x64", arm64: "linux-arm64" },
  darwin: { x64: "darwin-x64", arm64: "darwin-arm64" },
  win32: { x64: "windows-x64" },
};
const target = targetNames[process.platform]?.[process.arch];
const targetFlag = target ? `bun-${target}` : undefined;

type ExecFileError = {
  code?: string | number;
  stdout?: string;
  stderr?: string;
};

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, { ...options, maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    const execError = typeof error === "object" && error !== null ? error as ExecFileError : {};
    throw new Error(
      `${command} ${args.join(" ")} failed (${execError.code}):\n${execError.stdout ?? ""}${execError.stderr ?? ""}`,
      { cause: error },
    );
  }
}

async function seedPlugin(home, project) {
  const installed = path.join(home, "plugins", "installed", "binary-plugin");
  await fs.mkdir(installed, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(installed, "package.json"), JSON.stringify({
    name: "binary-plugin",
    version: "1.0.0",
    type: "module",
    climier: { id: "binary-plugin", command: "binary-plugin", entry: "./climier.mjs", api: 1 },
  }) + "\n");
  await fs.writeFile(
    path.join(installed, "climier.mjs"),
    "export default { commands: { probe: (args, api) => ({ loaded: true, args, project: api.runtime.project_dir }) } };\n",
  );
}

async function buildBinary(dist, env) {
  await run(process.execPath, [
    "scripts/build-binary.ts", "--target", targetFlag, "--output-dir", dist,
  ], { cwd: root, env });
  return path.join(dist, `climier-${target}${process.platform === "win32" ? ".exe" : ""}`);
}

async function installUiFixture(rootDir) {
  const uiRoot = path.join(root, "ui", "dist");
  const backupUiRoot = path.join(root, "ui", `.dist-test-backup-${path.basename(rootDir)}`);
  let hadUiBuild = false;
  try {
    try {
      await fs.rename(uiRoot, backupUiRoot);
      hadUiBuild = true;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") { throw error; }
    }
    await fs.mkdir(path.join(uiRoot, "assets"), { recursive: true });
    await fs.writeFile(path.join(uiRoot, "index.html"), "<!doctype html><main>compiled UI fixture</main>\n");
    await fs.writeFile(path.join(uiRoot, "assets", "hash-test.js"), "console.log('compiled asset');\n");
  } catch (error) {
    await fs.rm(uiRoot, { recursive: true, force: true });
    if (hadUiBuild) { await fs.rename(backupUiRoot, uiRoot); }
    throw error;
  }

  return async () => {
    await fs.rm(uiRoot, { recursive: true, force: true });
    if (hadUiBuild) { await fs.rename(backupUiRoot, uiRoot); }
  };
}

function startBinaryCliUi(executable, project, env) {
  const child = spawn(executable, ["--project", project, "ui", "--open=false", "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`compiled UI CLI did not return a URL: ${stderr}`)), 5_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      try {
        const result = JSON.parse(stdout);
        if (typeof result.ui?.url === "string") {
          clearTimeout(timer);
          resolve(result);
        }
      } catch {}
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`compiled UI CLI exited before returning a URL (${code}): ${stderr}`));
    });
  });
  return { child, ready };
}

function startBinaryServer(executable, configPath, env) {
  const child = spawn(executable, ["server", "run", configPath], { env, stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`compiled server did not report health: ${stderr}`)), 5_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timer);
        resolve(JSON.parse(stdout.slice(0, newline)));
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`compiled server exited before health (${code}): ${stderr}`));
    });
  });
  return { child, ready };
}

async function stopChild(child) {
  if (child.exitCode !== null) { return; }
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function assertPluginLoads(executable, project, env) {
  await run(executable, ["--project", project, "init"], { env });
  const { stdout } = await run(executable, [
    "--project", project, "--as", "binary-test", "binary-plugin", "probe", "--external",
  ], { env });
  assert.deepEqual(JSON.parse(stdout), {
    loaded: true,
    args: ["--project", project, "--as", "binary-test", "--external"],
    project,
  });
}

async function assertHostedUi(executable, rootDir, env) {
  const serverConfig = path.join(rootDir, "server.json");
  await fs.writeFile(serverConfig, JSON.stringify({
    listen: { host: "127.0.0.1", port: 0 },
    dataRoot: path.join(rootDir, "catalog"),
    stateHome: path.join(rootDir, "server-home"),
  }), { mode: 0o600 });
  const { child, ready } = startBinaryServer(executable, serverConfig, env);
  try {
    const health = await ready as { port: number };
    const baseUrl = `http://127.0.0.1:${health.port}`;
    const html = await fetch(`${baseUrl}/`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /compiled UI fixture/u);
    const asset = await fetch(`${baseUrl}/assets/hash-test.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.match(await asset.text(), /compiled asset/u);
  } finally {
    await stopChild(child);
  }
}

async function assertLocalUi(executable, project, env) {
  const { child, ready } = startBinaryCliUi(executable, project, env);
  try {
    const result = await ready as { ui: { url: string } };
    const html = await fetch(`${result.ui.url}/`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /compiled UI fixture/u);
  } finally {
    await stopChild(child);
  }
}

test("compiled binary embeds its UI and loads an installed external .mjs plugin", { skip: !targetFlag }, async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-binary-plugin-"));
  const project = path.join(rootDir, "project");
  const env = { ...process.env, CLIMIER_HOME: path.join(rootDir, "home"), CLIMIER_SERVER_PASSWORD: "binary-test-password" };
  let restoreUiBuild;
  try {
    restoreUiBuild = await installUiFixture(rootDir);
    await seedPlugin(env.CLIMIER_HOME, project);
    const executable = await buildBinary(path.join(rootDir, "dist"), env);
    await assertPluginLoads(executable, project, env);
    await assertHostedUi(executable, rootDir, env);
    await assertLocalUi(executable, project, env);
  } finally {
    await restoreUiBuild?.();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
