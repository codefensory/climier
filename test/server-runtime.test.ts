import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadServerRuntimeConfig, parseServerRuntimeConfig } from "../src/server/runtime-config.ts";
import { createServerRuntime, startServerRuntime } from "../src/server/runtime.ts";
import { stateFile } from "../src/storage/state.ts";

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
    ...overrides,
  };
}

type RuntimeAuthStore = NonNullable<NonNullable<Parameters<typeof createServerRuntime>[1]>["authStore"]>;
type RuntimeServer = NonNullable<ReturnType<typeof createServerRuntime>["server"]>;

const authStore = Object.freeze({
  async login(password) {
    if (password !== "password") {
      const error = new Error("invalid password");
      error.code = "AUTH_INVALID_PASSWORD";
      throw error;
    }
    return "runtime-token";
  },
  async verifyBearer(token) { return token === "runtime-token"; },
}) as unknown as RuntimeAuthStore;

async function writeConfig(root, value) {
  const file = path.join(root, "server.json");
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}

function restoreClimierHome(previousHome) {
  if (previousHome === undefined) {
    delete process.env.CLIMIER_HOME;
  } else {
    process.env.CLIMIER_HOME = previousHome;
  }
}

async function assertTrustedProjects(runtime, root, stateHome) {
  const alphaPath = await runtime.catalog.provisionProject("alpha");
  const betaPath = await runtime.catalog.provisionProject("../beta");

  process.env.CLIMIER_HOME = path.join(root, "attacker-controlled-home");
  const alpha = await runtime.openProject(alphaPath, { projectId: "alpha", create: true });
  assert.equal(process.env.CLIMIER_HOME, path.resolve(stateHome));
  const beta = await runtime.openProject(betaPath, { projectId: "../beta", create: true });

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
}

test("private server config fails closed for malformed or unsafe settings", async (t) => {
  const root = await makeRoot(t);
  const valid = config(root);
  const invalid = [
    { ...valid, unexpected: true },
    { ...valid, stateHome: "" },
    { ...valid, uiRoot: "relative/ui/dist" },
    { ...valid, listen: { host: "127.0.0.1", port: 65_536 } },
    { ...valid, listen: {} },
    { ...valid, listen: { host: 123, port: 0 } },
    { ...valid, projectIds: ["alpha"] },
    { ...valid, credentials: [{ token: "secret", projectIds: ["alpha"] }] },
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

  const explicitUiRoot = path.join(root, "ui", "dist");
  const parsed = parseServerRuntimeConfig({ ...valid, uiRoot: explicitUiRoot });
  assert.equal(parsed.uiRoot, explicitUiRoot);
});

test("private server config accepts every non-empty listen host without a network policy", async (t) => {
  const root = await makeRoot(t);

  for (const host of ["0.0.0.0", "::", "localhost", "192.0.2.10", "127.0.0.1"]) {
    assert.equal(parseServerRuntimeConfig(config(root, { listen: { host, port: 0 } })).listen.host, host);
  }
});

test("server runtime leaves UI root configurable and passes the packaged UI source to the server factory", async (t) => {
  const root = await makeRoot(t);
  let received;
  const server = {} as RuntimeServer;
  const runtime = createServerRuntime(config(root), {
    authStore,
    serverFactory(options) {
      received = options;
      return server;
    },
  });
  const packageUiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "ui", "dist");

  assert.equal(runtime.server, server);
  assert.equal(runtime.config.uiRoot, undefined);
  assert.equal(received.uiRoot, undefined);
  assert.deepEqual(await received.uiSource, { kind: "fs", root: packageUiRoot });
});

test("server runtime pins state home and writes trusted hash-safe project metadata", async (t) => {
  const root = await makeRoot(t);
  const stateHome = path.join(root, "fixed-state-home");
  const previousHome = process.env.CLIMIER_HOME;
  t.after(() => restoreClimierHome(previousHome));

  const runtime = createServerRuntime(config(root, { stateHome }), { authStore });
  assert.equal(process.env.CLIMIER_HOME, path.resolve(stateHome));
  await assertTrustedProjects(runtime, root, stateHome);
});

test("server runtime rejects a project directory with conflicting metadata", async (t) => {
  const root = await makeRoot(t);
  const runtime = createServerRuntime(config(root), { authStore });
  const projectDir = await runtime.catalog.provisionProject("alpha");
  await fs.writeFile(path.join(projectDir, ".climier.json"), JSON.stringify({ version: 1, project_id: "client-controlled" }));

  await assert.rejects(runtime.openProject(projectDir, { projectId: "alpha", create: true }), { code: "UNTRUSTED_PROJECT_METADATA" });
});

test("server run starts the configured server and reports its listening health", async (t) => {
  const root = await makeRoot(t);
  const configPath = await writeConfig(root, config(root));
  const launcher = new URL("../bin/climier.ts", import.meta.url);
  const child = spawn(process.execPath, [launcher.pathname, "server", "run", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CLIMIER_SERVER_PASSWORD: "password" },
  });
  t.after(() => child.kill("SIGTERM"));

  const line = await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`server run did not report health: ${stderr}`)), 5_000);
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
      reject(new Error(`server run exited before health report (${code}): ${stderr}`));
    });
  });
  const health = JSON.parse(line) as { ok: boolean; host: string; port: number };
  assert.equal(health.ok, true);
  assert.equal(health.host, "127.0.0.1");
  assert.ok(Number.isInteger(health.port) && health.port > 0);
  child.kill("SIGTERM");
  const exitCode = await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  assert.equal(exitCode, 0);
});

test("runtime serves the configured UI root through the remote server", async (t) => {
  const root = await makeRoot(t);
  const uiRoot = path.join(root, "ui", "dist");
  await fs.mkdir(path.join(uiRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(uiRoot, "index.html"), "<!doctype html><main>runtime SPA</main>\n");
  await fs.writeFile(path.join(uiRoot, "assets", "app-123.js"), "console.log('runtime');\n");
  const file = await writeConfig(root, config(root, { uiRoot }));
  const runtime = await startServerRuntime(file, { password: "password" });
  t.after(() => new Promise((resolve) => runtime.server.close(resolve)));

  const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
  const html = await fetch(`${baseUrl}/`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("cache-control"), "no-cache");
  assert.equal(await html.text(), "<!doctype html><main>runtime SPA</main>\n");

  const asset = await fetch(`${baseUrl}/assets/app-123.js`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await asset.text(), "console.log('runtime');\n");
});

test("runtime reports a missing UI build without absorbing the API", async (t) => {
  const root = await makeRoot(t);
  const file = await writeConfig(root, config(root, { uiRoot: path.join(root, "missing-ui", "dist") }));
  const runtime = await startServerRuntime(file, { password: "password" });
  t.after(() => new Promise((resolve) => runtime.server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;

  const missingBuild = await fetch(`${baseUrl}/`);
  assert.equal(missingBuild.status, 503);
  assert.equal(missingBuild.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(await missingBuild.text(), /UI build is not available/u);

  const apiUnknown = await fetch(`${baseUrl}/v1/not-a-route`, {
    headers: { "x-climier-protocol-version": "1" },
  });
  assert.equal(apiUnknown.status, 404);
  assert.equal(apiUnknown.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await apiUnknown.json(), {
    ok: false,
    error: { code: "ROUTE_NOT_FOUND", message: "server http: route was not found" },
  });
});

test("runtime startup binds state home once and listens on configured address", async (t) => {
  const root = await makeRoot(t);
  const previousHome = process.env.CLIMIER_HOME;
  t.after(() => restoreClimierHome(previousHome));
  const file = await writeConfig(root, config(root));
  const runtime = await startServerRuntime(file, { password: "password" });
  t.after(() => new Promise((resolve) => runtime.server.close(resolve)));
  assert.equal(runtime.server.listening, true);
  assert.equal(process.env.CLIMIER_HOME, path.resolve(path.join(root, "state-home")));
  assert.equal(runtime.server.address().address, "127.0.0.1");
});

test("runtime requires password and service lock before listening", async (t) => {
  const root = await makeRoot(t);
  const file = await writeConfig(root, config(root));
  await assert.rejects(startServerRuntime(file, { password: "" }), { code: "SERVER_PASSWORD_REQUIRED" });

  const first = await startServerRuntime(file, { password: "password" });
  t.after(() => new Promise((resolve) => first.server.close(resolve)));
  await assert.rejects(startServerRuntime(file, { password: "password" }), { code: "SERVER_ALREADY_RUNNING" });
});

test("runtime releases the service lock when the operating system rejects the bind", async (t) => {
  const root = await makeRoot(t);
  const firstFile = await writeConfig(root, config(root));
  const first = await startServerRuntime(firstFile, { password: "password" });
  t.after(() => new Promise((resolve) => first.server.close(resolve)));

  const port = first.server.address().port;
  const secondStateHome = path.join(root, "second-state-home");
  const secondFile = await writeConfig(root, config(root, {
    listen: { host: "127.0.0.1", port },
    dataRoot: path.join(root, "second-catalog"),
    stateHome: secondStateHome,
  }));

  await assert.rejects(startServerRuntime(secondFile, { password: "password" }), { code: "EADDRINUSE" });
  await assert.rejects(fs.access(path.join(secondStateHome, ".server.lock")), { code: "ENOENT" });
});
