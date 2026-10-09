/* eslint-disable max-statements */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateServerArtifacts } from "../src/server/setup-artifacts.ts";
import { renderSystemdUnit } from "../src/server/systemd-unit.ts";
import { parseServerRuntimeConfig } from "../src/server/runtime-config.ts";

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-artifacts-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function options(root, overrides = {}) {
  return {
    root,
    dataRoot: path.join(root, "data"),
    stateHome: path.join(root, "state"),
    ...overrides,
  };
}

test("renders a hardened systemd unit without an implicit service user", () => {
  const root = "/srv/climier";
  const unit = renderSystemdUnit({
    root,
    dataRoot: "/srv/climier/data",
    stateHome: "/srv/climier/state",
  });

  assert.match(unit, /^\[Unit\]/mu);
  assert.match(unit, /ExecStart=\/srv\/climier\/climier-server \/srv\/climier\/server\.json/u);
  assert.match(unit, /EnvironmentFile=\/srv\/climier\/server\.env/u);
  assert.match(unit, /Restart=on-failure/u);
  assert.match(unit, /NoNewPrivileges=true/u);
  assert.match(unit, /PrivateTmp=true/u);
  assert.match(unit, /ProtectSystem=strict/u);
  assert.match(unit, /ProtectHome=true/u);
  assert.match(unit, /ReadWritePaths=\/srv\/climier\/data \/srv\/climier\/state/u);
  assert.doesNotMatch(unit, /^User=/mu);

  assert.match(renderSystemdUnit({ ...options(root), serviceUser: "climier" }), /^User=climier$/mu);
});

test("generates private config, a 32-byte base64url secret, directories, and a unit", async (t) => {
  const root = await makeRoot(t);
  const result = await generateServerArtifacts(options(root));

  assert.equal(result.changed, true);
  assert.deepEqual(result.created, ["server.json", "server.env", "climier-server.service"]);
  const config = JSON.parse(await fs.readFile(path.join(root, "server.json"), "utf8"));
  assert.deepEqual(config, {
    listen: { host: "127.0.0.1", port: 43127 },
    dataRoot: path.join(root, "data"),
    stateHome: path.join(root, "state"),
  });
  const parsed = parseServerRuntimeConfig(config);
  assert.deepEqual({ ...parsed, uiRoot: undefined }, { ...config, uiRoot: undefined });
  const env = await fs.readFile(path.join(root, "server.env"), "utf8");
  const secret = /^CLIMIER_SERVER_PASSWORD=([^\n]+)$/mu.exec(env)?.[1];
  assert.ok(secret);
  assert.equal(Buffer.from(secret, "base64url").byteLength, 32);
  assert.match(await fs.readFile(path.join(root, "climier-server.service"), "utf8"), /EnvironmentFile=/u);

  for (const file of ["server.json", "server.env", "climier-server.service"]) {
    assert.equal((await fs.stat(path.join(root, file))).mode & 0o777, 0o600);
  }
  for (const directory of ["data", "state"]) {
    assert.equal((await fs.stat(path.join(root, directory))).mode & 0o777, 0o700);
  }
});

test("is idempotent, creates only a missing artifact, and rotates only the secret", async (t) => {
  const root = await makeRoot(t);
  const first = await generateServerArtifacts(options(root));
  const envPath = path.join(root, "server.env");
  const originalEnv = await fs.readFile(envPath, "utf8");
  const second = await generateServerArtifacts(options(root));
  assert.equal(second.changed, false);
  assert.equal(second.secret.written, false);
  assert.deepEqual(second.created, []);
  assert.equal((await fs.stat(path.join(root, "climier-server.service"))).mode & 0o777, 0o600);

  await fs.chmod(path.join(root, "climier-server.service"), 0o644);
  await assert.rejects(generateServerArtifacts(options(root)), { code: "SERVER_CONFIG_EXISTS" });
  const forcedModeRepair = await generateServerArtifacts(options(root, { force: true }));
  assert.equal(forcedModeRepair.changed, true);
  assert.deepEqual(forcedModeRepair.created, ["climier-server.service"]);
  assert.equal((await fs.stat(path.join(root, "climier-server.service"))).mode & 0o777, 0o600);

  await fs.rm(path.join(root, "climier-server.service"));
  const missing = await generateServerArtifacts(options(root));
  assert.equal(missing.changed, true);
  assert.deepEqual(missing.created, ["climier-server.service"]);
  assert.equal(await fs.readFile(envPath, "utf8"), originalEnv);

  const configPath = path.join(root, "server.json");
  const unitPath = path.join(root, "climier-server.service");
  const configBeforeRotation = await fs.readFile(configPath, "utf8");
  const unitBeforeRotation = await fs.readFile(unitPath, "utf8");
  await fs.appendFile(envPath, "CLIMIER_SERVER_MAX_BODY_BYTES=16777216\nCLIMIER_SERVER_EXTRA=keep-me\n");
  const envBeforeRotation = await fs.readFile(envPath, "utf8");
  const rotated = await generateServerArtifacts(options(root, { rotatePassword: true }));
  assert.equal(rotated.changed, true);
  const rotatedEnv = await fs.readFile(envPath, "utf8");
  assert.notEqual(rotatedEnv, envBeforeRotation);
  assert.match(rotatedEnv, /^CLIMIER_SERVER_MAX_BODY_BYTES=16777216$/mu);
  assert.match(rotatedEnv, /^CLIMIER_SERVER_EXTRA=keep-me$/mu);
  assert.equal(await fs.readFile(configPath, "utf8"), configBeforeRotation);
  assert.equal(await fs.readFile(unitPath, "utf8"), unitBeforeRotation);

  const forced = await generateServerArtifacts(options(root, { port: 43128, force: true }));
  assert.equal(forced.changed, true);
  assert.equal(await fs.readFile(envPath, "utf8"), rotatedEnv);
  assert.equal(first.secret.printed, false);
});

test("reports conflicts without writing and dry-run does not create paths", async (t) => {
  const root = await makeRoot(t);
  const dry = await generateServerArtifacts(options(root, { dryRun: true }));
  assert.equal(dry.changed, false);
  assert.ok(dry.actions!.every(({ action }) => action === "create"));
  await assert.rejects(fs.stat(path.join(root, "data")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(root, "server.json")), { code: "ENOENT" });

  await generateServerArtifacts(options(root));
  const before = await fs.readFile(path.join(root, "server.json"), "utf8");
  await assert.rejects(generateServerArtifacts(options(root, { port: 43128 })), { code: "SERVER_CONFIG_EXISTS" });
  assert.equal(await fs.readFile(path.join(root, "server.json"), "utf8"), before);

  const forced = await generateServerArtifacts(options(root, { port: 43128, force: true }));
  assert.equal(forced.changed, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "server.json"), "utf8")).listen.port, 43128);
});

test("reports ownership work without executing privileged commands", async (t) => {
  const root = await makeRoot(t);
  const result = await generateServerArtifacts(options(root, { serviceUser: "climier", invokerUser: "operator" }));
  assert.ok(result.pending.some((command) => command.startsWith("chown ")));
  assert.ok(result.pending.some((command) => command.startsWith("chmod ")));
  assert.ok(result.warnings.every((warning) => typeof warning === "string"));
});

test("warns when the recorded invoker is root", async (t) => {
  const root = await makeRoot(t);
  const result = await generateServerArtifacts(options(root, { invokerUser: "root" }));
  assert.ok(result.warnings.some((warning) => warning.includes("running as root")));
});
