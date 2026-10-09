import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { checkServerConfig } from "../src/server/preflight.ts";

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-preflight-"));
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

async function writeConfig(root, value, name = "server.json") {
  const file = path.join(root, name);
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

function statuses(result) {
  return result.checks.map(({ id, status }) => ({ id, status }));
}

type PreflightResult = Awaited<ReturnType<typeof checkServerConfig>>;

function checkById(result: PreflightResult, id: string) {
  const found = result.checks.find((check) => check.id === id);
  assert.ok(found, `missing preflight check: ${id}`);
  return found;
}

test("checkServerConfig reports unsafe config files and config shape failures", async (t) => {
  const root = await makeRoot(t);
  const valid = config(root);
  const missing = await checkServerConfig({ configPath: path.join(root, "missing.json"), env: { CLIMIER_SERVER_PASSWORD: "password" } });
  assert.equal(missing.ok, false);
  assert.ok(missing.checks.some((check) => check.status === "fail"));

  const malformedPath = path.join(root, "malformed.json");
  await fs.writeFile(malformedPath, "{", { mode: 0o600 });
  const malformed = await checkServerConfig({ configPath: malformedPath, env: { CLIMIER_SERVER_PASSWORD: "password" } });
  assert.equal(malformed.ok, false);

  const legacy = await writeConfig(root, { ...valid, credentials: [], projectIds: [] }, "legacy.json");
  const legacyResult = await checkServerConfig({ configPath: legacy, env: { CLIMIER_SERVER_PASSWORD: "password" } });
  assert.equal(legacyResult.ok, false);
  assert.match(checkById(legacyResult, "config-keys").detail, /SERVER_LEGACY_CONFIG/u);

  const relative = await writeConfig(root, { ...valid, stateHome: "relative" }, "relative.json");
  const relativeResult = await checkServerConfig({ configPath: relative, env: { CLIMIER_SERVER_PASSWORD: "password" } });
  assert.equal(relativeResult.ok, false);

  if (process.platform !== "win32") {
    const exposed = await writeConfig(root, valid, "exposed.json");
    await fs.chmod(exposed, 0o640);
    const exposedResult = await checkServerConfig({ configPath: exposed, env: { CLIMIER_SERVER_PASSWORD: "password" } });
    assert.equal(exposedResult.ok, false);

    const symlink = path.join(root, "symlink.json");
    await fs.symlink(exposed, symlink);
    const symlinkResult = await checkServerConfig({ configPath: symlink, env: { CLIMIER_SERVER_PASSWORD: "password" } });
    assert.equal(symlinkResult.ok, false);
  }
});

test("checkServerConfig validates the secret, max body, UI build, and strict warnings", async (t) => {
  const root = await makeRoot(t);
  const file = await writeConfig(root, config(root, { uiRoot: path.join(root, "missing-ui") }));

  const missingSecret = await checkServerConfig({ configPath: file, env: {} });
  assert.equal(missingSecret.ok, false);
  assert.match(checkById(missingSecret, "secret").detail, /SERVER_SECRET_MISSING/u);

  const invalidBody = await checkServerConfig({
    configPath: file,
    env: { CLIMIER_SERVER_PASSWORD: "password", CLIMIER_SERVER_MAX_BODY_BYTES: "0" },
  });
  assert.equal(invalidBody.ok, false);

  const warning = await checkServerConfig({ configPath: file, env: { CLIMIER_SERVER_PASSWORD: "password" } });
  assert.equal(warning.ok, true);
  assert.equal(checkById(warning, "ui-root").status, "warn");

  const strict = await checkServerConfig({ configPath: file, env: { CLIMIER_SERVER_PASSWORD: "password" }, strict: true });
  assert.equal(strict.ok, false);
  assert.equal(checkById(strict, "ui-root").status, "fail");
});

test("checkServerConfig parses strict env files and ignores the process environment", async (t) => {
  const root = await makeRoot(t);
  const file = await writeConfig(root, config(root));
  const envFile = path.join(root, "server.env");
  await fs.writeFile(envFile, "CLIMIER_SERVER_PASSWORD=from-file\nCLIMIER_SERVER_MAX_BODY_BYTES=2048\n", { mode: 0o600 });

  const result = await checkServerConfig({ configPath: file, envFile, env: {} });
  assert.equal(result.ok, true);

  for (const contents of [
    "export CLIMIER_SERVER_PASSWORD=bad\n",
    "CLIMIER_SERVER_PASSWORD bad\n",
    "UNKNOWN=value\n",
    "CLIMIER_SERVER_PASSWORD='quoted'\n",
  ]) {
    await fs.writeFile(envFile, contents, { mode: 0o600 });
    const invalid = await checkServerConfig({ configPath: file, envFile, env: {} });
    assert.equal(invalid.ok, false, contents);
    assert.equal(checkById(invalid, "env-file").status, "fail");
  }
});

test("probe-bind is opt-in and reports an occupied port as a warning or strict failure", async (t) => {
  const root = await makeRoot(t);
  const occupied = net.createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => occupied.close());
  const port = (occupied.address() as net.AddressInfo).port;
  const file = await writeConfig(root, config(root, { listen: { host: "127.0.0.1", port } }));
  const env = { CLIMIER_SERVER_PASSWORD: "password" };

  const withoutProbe = await checkServerConfig({ configPath: file, env });
  assert.equal(withoutProbe.checks.some((check) => check.id === "bind"), false);

  const probe = await checkServerConfig({ configPath: file, env, probeBind: true });
  assert.equal(probe.ok, true);
  assert.equal(checkById(probe, "bind").status, "warn");

  const strict = await checkServerConfig({ configPath: file, env, probeBind: true, strict: true });
  assert.equal(strict.ok, false);
  assert.equal(checkById(strict, "bind").status, "fail");
});

test("climier-server --check exits without creating runtime directories", async (t) => {
  const root = await makeRoot(t);
  const dataRoot = path.join(root, "catalog");
  const stateHome = path.join(root, "state-home");
  const file = await writeConfig(root, config(root, { dataRoot, stateHome }));
  const launcher = new URL("../bin/climier-server.ts", import.meta.url);
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("bun", [launcher.pathname, "--check", file], {
      env: { ...process.env, CLIMIER_SERVER_PASSWORD: "password" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  await assert.rejects(fs.access(dataRoot));
  await assert.rejects(fs.access(stateHome));
});
