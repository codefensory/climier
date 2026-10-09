import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import setupCommand, { knownFlags } from "../src/cli/commands/server/setup.ts";
import { knownFlags as initFlags } from "../src/cli/commands/server/init.ts";
import { HELP_TEXT, runCli } from "../src/cli/dispatch.ts";

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-setup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function context(root, input, output = new Writable({ write(_chunk, _encoding, callback) { callback(); } })) {
  return {
    command: "server",
    originalArgv: [],
    flags: {},
    positional: [],
    projectDir: root,
    statePath: root,
    projectConfig: {},
    input,
    output,
  } as never;
}

test("server setup rejects non-TTY input before reading and enumerates init flags", async (t) => {
  const root = await makeRoot(t);
  let read = false;
  const input = { isTTY: false, on() { read = true; return this; } };

  await assert.rejects(setupCommand(context(root, input)), (error: any) => {
    assert.equal(error.code, "CLI_USAGE_ERROR");
    assert.deepEqual(error.details.valid_flags, [...initFlags]);
    for (const flag of initFlags) {assert.match(error.message, new RegExp(`--${flag}\\b`, "u"));}
    return true;
  });
  assert.equal(read, false);
  await assert.rejects(fs.stat(path.join(root, "server.json")), { code: "ENOENT" });
});

test("server setup is routed locally and rejects a real non-TTY invocation", async (t) => {
  const root = await makeRoot(t);
  const output: string[] = [];
  const result = await runCli({
    argv: ["--project", root, "server", "setup"],
    write: (value) => output.push(String(value)),
    exit: () => {},
  });
  assert.equal(result, 2);
  const envelope = JSON.parse(output[0]);
  assert.equal(envelope.error.code, "CLI_USAGE_ERROR");
  assert.match(envelope.error.message, /--root.*--host.*--port/u);
  await assert.rejects(fs.stat(path.join(root, "server.json")), { code: "ENOENT" });
});

test("server setup collects init options from a TTY and delegates artifact generation", async (t) => {
  const root = await makeRoot(t);
  const answers = [
    root,
    "0.0.0.0",
    "43210",
    path.join(root, "data-root"),
    path.join(root, "state-home"),
    path.join(root, "ui-root"),
    "climier",
    "custom.service",
    "none",
    "false",
    "false",
    "false",
    "false",
    "false",
    "false",
  ];
  const input = new PassThrough();
  Object.assign(input, { isTTY: true });
  process.nextTick(() => input.end(`${answers.join("\n")}\n`));

  const result = await setupCommand(context(root, input));
  assert.equal(result.ok, true);
  assert.deepEqual(result.listen, { host: "0.0.0.0", port: 43210 });
  assert.equal(result.files.unit, null);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "server.json"), "utf8")).dataRoot, path.join(root, "data-root"));
  assert.equal((await fs.readFile(path.join(root, "server.env"), "utf8")).startsWith("CLIMIER_SERVER_PASSWORD="), true);
});

test("server setup and init expose the same options in the command help", () => {
  assert.deepEqual(knownFlags, initFlags);
  for (const flag of initFlags) {assert.match(HELP_TEXT, new RegExp(`--${flag}\\b`, "u"));}
});
