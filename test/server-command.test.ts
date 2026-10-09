import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { COMMANDS, HELP_TEXT, KNOWN_COMMANDS, runCli } from "../src/cli/dispatch.ts";
import { RESERVED_NAMESPACES, assertNoReservedCollision } from "../src/cli/commands/reserved-namespaces.ts";

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-command-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeServerFiles(root, { password = "a sufficiently random password" } = {}) {
  await fs.writeFile(path.join(root, "server.json"), JSON.stringify({
    listen: { host: "127.0.0.1", port: 0 },
    dataRoot: path.join(root, "catalog"),
    stateHome: path.join(root, "state-home"),
  }), { mode: 0o600 });
  await fs.writeFile(path.join(root, "server.env"), `CLIMIER_SERVER_PASSWORD=${password}\n`, { mode: 0o600 });
}

function runServer(root, args, options = {}) {
  return runCli({
    argv: ["--project", root, "server", ...args],
    write: (value) => options.output?.push(String(value)),
    exit: (code) => { options.exitCode = code; },
    createBackendClient: options.createBackendClient,
  });
}

test("server is a reserved built-in namespace and is advertised", () => {
  assert.ok(RESERVED_NAMESPACES.includes("server"));
  assert.ok(KNOWN_COMMANDS.includes("server"));
  assert.ok(COMMANDS.server);
  assert.throws(() => assertNoReservedCollision("server"), (error) => error.code === "PLUGIN_INVALID_DESCRIPTOR");
  assert.match(HELP_TEXT, /server/);
  assert.match(HELP_TEXT, /server doctor/);
});

test("server rejects unknown subcommands with its valid subcommand list", async (t) => {
  const root = await makeRoot(t);
  const output = [];
  const result = await runServer(root, ["unknown"], { output });
  assert.equal(result, 2);
  const envelope = JSON.parse(output[0]);
  assert.equal(envelope.error.code, "CLI_USAGE_ERROR");
  assert.match(envelope.error.message, /init.*doctor.*setup/u);
});

test("server doctor uses root server artifacts and returns preflight JSON", async (t) => {
  const root = await makeRoot(t);
  await writeServerFiles(root);
  const output = [];
  const result = await runServer(root, ["doctor"], { output });
  assert.equal(result, 0, output.join("\n"));
  const report = JSON.parse(output[0]);
  assert.equal(report.ok, true);
  assert.ok(Array.isArray(report.checks));
});

test("server doctor exits one when a preflight check fails", async (t) => {
  const root = await makeRoot(t);
  await writeServerFiles(root, { password: "" });
  const output = [];
  const result = await runServer(root, ["doctor"], { output });
  assert.equal(result, 1);
  const report = JSON.parse(output[0]);
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((check) => check.status === "fail"));
});

test("server doctor is local even for a remote checkout", async (t) => {
  const root = await makeRoot(t);
  await writeServerFiles(root);
  await fs.writeFile(path.join(root, ".climier.json"), JSON.stringify({
    version: 1,
    project_id: "remote-project",
    backend: { type: "remote", url: "https://server.example.test" },
  }));
  const output = [];
  const result = await runServer(root, ["doctor"], {
    output,
    createBackendClient() {
      throw new Error("server namespace must not select a backend");
    },
  });
  assert.equal(result, 0);
  assert.equal(JSON.parse(output[0]).ok, true);
});
