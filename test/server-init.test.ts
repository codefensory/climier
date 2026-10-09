import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli/dispatch.ts";

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-init-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function runServer(root, args: string[]) {
  const output: string[] = [];
  const exitCodes: number[] = [];
  const result = await runCli({
    argv: ["--project", root, "server", "init", "--root", root, ...args],
    write: (value) => output.push(String(value)),
    exit: (code) => exitCodes.push(code),
  });
  return { result, output: JSON.parse(output[0]), exitCode: exitCodes.at(-1) };
}

test("server init dry-run reports actions without writing and real init is private", async (t) => {
  const root = await makeRoot(t);
  const dry = await runServer(root, ["--dry-run"]);
  assert.equal(dry.result, 0);
  assert.equal(dry.exitCode, undefined);
  assert.ok(dry.output.actions.every(({ action }) => action === "create"));
  await assert.rejects(fs.stat(path.join(root, "server.json")), { code: "ENOENT" });

  const created = await runServer(root, []);
  assert.equal(created.output.changed, true);
  assert.deepEqual(created.output.secret, { written: true, printed: false });
  assert.ok(created.output.next.some((value) => value.includes("systemctl")));
  assert.ok(created.output.next.some((value) => value.includes("climier link")));
  assert.ok(created.output.next.some((value) => value.includes("climier login")));
  assert.ok(created.output.next.includes("climier init"));
  for (const file of ["server.json", "server.env", "climier-server.service"]) {
    assert.equal((await fs.stat(path.join(root, file))).mode & 0o777, 0o600);
  }
});

// eslint-disable-next-line max-statements -- Keep the complete idempotency and secret-preservation contract together.
test("server init is idempotent, protects the secret, and supports force and rotation", async (t) => {
  const root = await makeRoot(t);
  const first = await runServer(root, []);
  const envPath = path.join(root, "server.env");
  const initialEnv = await fs.readFile(envPath, "utf8");
  const second = await runServer(root, []);
  assert.equal(second.output.changed, false);
  assert.deepEqual(second.output.created, []);
  assert.equal(second.output.secret.written, false);
  assert.equal(JSON.stringify(second.output).includes(initialEnv.split("=")[1].trim()), false);

  const conflict = await runServer(root, ["--port", "43128"]);
  assert.equal(conflict.result, 1);
  assert.equal(conflict.output.error.code, "SERVER_CONFIG_EXISTS");
  assert.equal(await fs.readFile(envPath, "utf8"), initialEnv);

  const forced = await runServer(root, ["--port", "43128", "--force"]);
  assert.equal(forced.output.changed, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "server.json"), "utf8")).listen.port, 43128);
  assert.equal(await fs.readFile(envPath, "utf8"), initialEnv);

  const rotated = await runServer(root, ["--port", "43128", "--rotate-password"]);
  assert.equal(rotated.output.changed, true);
  assert.notEqual(await fs.readFile(envPath, "utf8"), initialEnv);
  assert.equal(JSON.stringify(rotated.output).includes((await fs.readFile(envPath, "utf8")).split("=")[1].trim()), false);
  assert.equal(first.output.secret.printed, false);
});

test("server init can print the secret only when explicitly requested", async (t) => {
  const root = await makeRoot(t);
  const result = await runServer(root, ["--print-secret"]);
  assert.equal(result.output.secret.printed, true);
  assert.equal(typeof result.output.secret.value, "string");
  assert.equal(result.output.secret.value.length, 43);
});

test("server init remains local for a remote checkout", async (t) => {
  const root = await makeRoot(t);
  await fs.writeFile(path.join(root, ".climier.json"), JSON.stringify({
    version: 1,
    project_id: "remote-project",
    backend: { type: "remote", url: "https://server.example.test" },
  }));
  const result = await runServer(root, []);
  assert.equal(result.result, 0);
  assert.equal(result.output.ok, true);
  assert.notEqual(result.output.error?.code, "REMOTE_UNSUPPORTED_OPERATION");
});
