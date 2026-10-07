// Contract: the CLI is JSON-only. Every command outputs valid JSON to stdout.
// Errors are JSON to stdout, not stderr. The --json flag is gone (it's the default).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTempProject, rmTempProject, runCli } from "./helpers.mjs";

const packageVersion = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")
).version;

async function seedV2Project(dir) {

  let r = await runCli(["--project", dir, "init"]);
  assert.equal(r.code, 0, r.stderr);
  r = await runCli(["--project", dir, "add-initiative", "migration", "--desc", "x"]);
  assert.equal(r.code, 0, r.stderr);
  r = await runCli(["--project", dir, "add-task", "--initiative", "migration", "--title", "seed", "--body", "b", "--acceptance", "a", "--blocked-by", ""]);
  assert.equal(r.code, 0, r.stderr);
}

test("contract: every read command outputs valid JSON to stdout", async () => {
  const dir = await createTempProject();
  try {
    await seedV2Project(dir);
    for (const cmd of [
      ["status"],
      ["context", "T-"],
      ["search", "seed"],
      ["initiatives"],
      ["log"],
      ["history", "T-"],
      ["show", "T-"],
    ]) {
      const r = await runCli(["--project", dir, ...cmd]);

      if (r.code !== 0) {

        assert.doesNotThrow(() => JSON.parse(r.stdout), `${cmd.join(" ")} stdout not JSON: ${r.stdout.slice(0, 100)}`);
      } else {
        assert.doesNotThrow(() => JSON.parse(r.stdout), `${cmd.join(" ")} stdout not JSON: ${r.stdout.slice(0, 100)}`);
      }
    }
  } finally {
    await rmTempProject(dir);
  }
});

async function assertCliJsonOutput(result, command) {
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotThrow(() => JSON.parse(result.stdout), `${command} stdout not JSON: ${result.stdout.slice(0, 100)}`);
}

async function assertSuccessfulWrite(dir, args, command) {
  const result = await runCli(["--project", dir, ...args]);
  await assertCliJsonOutput(result, command);
}

test("contract: every write command outputs valid JSON to stdout", async () => {
  const dir = await createTempProject();
  try {
    await seedV2Project(dir);
    await assertSuccessfulWrite(dir, ["add-initiative", "spike", "--desc", "x"], "add-initiative");
    await assertSuccessfulWrite(dir, ["add-task", "T-second", "--initiative", "migration", "--title", "x", "--body", "b", "--acceptance", "a", "--blocked-by", ""], "add-task");
    await assertSuccessfulWrite(dir, ["take", "T-second", "--as", "alice"], "take");
    await assertSuccessfulWrite(dir, ["submit", "T-second", "--note", "shipped", "--as", "alice"], "submit");
    await assertSuccessfulWrite(dir, ["accept", "T-second", "--as", "alice"], "accept");
    await assertSuccessfulWrite(dir, ["reopen", "T-second", "--reason", "recheck", "--as", "alice"], "reopen");
    await assertSuccessfulWrite(dir, ["add-gate", "G-x", "--initiative", "migration", "--title", "g", "--body", "b", "--purpose", "decision"], "add-gate");
    await assertSuccessfulWrite(dir, ["resolve", "G-x", "--choice", "raw", "--rationale", "yes", "--as", "alice"], "resolve-gate");
    await assertSuccessfulWrite(dir, ["add-knowledge", "K-x", "--initiative", "migration", "--title", "k", "--body", "b", "--scope-domains", "db"], "add-knowledge");
    await assertSuccessfulWrite(dir, ["deprecate-knowledge", "K-x", "--reason", "outdated", "--as", "alice"], "deprecate-knowledge");

    const dir2 = await createTempProject();
    try {
      await assertSuccessfulWrite(dir2, ["init"], "init");
    } finally {
      await rmTempProject(dir2);
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("contract: command errors are JSON to stdout, not stderr", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "show", "NOPE"]);
    assert.notEqual(r.code, 0);
    // JSON on stdout.
    const data = JSON.parse(r.stdout);
    assert.ok(data.code || data.error, "error must have a code or error field");
    // Stderr is empty for command errors.
    assert.equal(r.stderr.trim(), "");
  } finally {
    await rmTempProject(dir);
  }
});

test("contract: unknown command is JSON to stdout with ok:false", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "nosuchcmd"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.error.code, "CLI_USAGE_ERROR");
    assert.equal(data.error.details.command, "nosuchcmd");
    assert.equal(r.stderr.trim(), "");
  } finally {
    await rmTempProject(dir);
  }
});

test("contract: no command given is JSON to stdout with ok:false", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.error.code, "CLI_USAGE_ERROR");
    assert.equal(data.error.details.command, null);
    assert.equal(r.stderr.trim(), "");
  } finally {
    await rmTempProject(dir);
  }
});

test("contract: --json flag is gone (no longer a global flag)", async () => {
  const dir = await createTempProject();
  try {
    await seedV2Project(dir);
    // `--json` is not a known global flag; the parser eats the next arg as its
    // value, leaving no command. Either path (unknown flag at the per-command
    // level, or "no command given" at the dispatch level) is acceptable as
    // long as the contract — JSON error to stdout, nothing on stderr — holds.
    const r = await runCli(["--project", dir, "--json", "status"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.error.code, "CLI_USAGE_ERROR");
    assert.equal(data.error.details.command, null);
  } finally {
    await rmTempProject(dir);
  }
});

test("contract: unknown flag is JSON to stdout (not stderr)", async () => {
  const dir = await createTempProject();
  try {
    await seedV2Project(dir);
    const r = await runCli(["--project", dir, "take", "T-second", "--as", "alice", "--banana", "split"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.error.code, "CLI_USAGE_ERROR");
    assert.equal(data.error.details.command, "take");
    assert.equal(data.error.details.flag, "banana");
    assert.equal(r.stderr.trim(), "");
  } finally {
    await rmTempProject(dir);
  }
});

test("contract: --help still prints human-readable help to stdout", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "--help"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /climier/i);
    assert.match(r.stdout, /take/);
    // --help is plain text, not JSON.
    assert.throws(() => JSON.parse(r.stdout), "--help output should not be JSON");
  } finally {
    await rmTempProject(dir);
  }
});

test("contract: --version prints plain text to stdout", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "--version"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), packageVersion);
    assert.throws(() => JSON.parse(r.stdout), "--version output should not be JSON");
  } finally {
    await rmTempProject(dir);
  }
});

test("contract: storage errors have a stable structured code", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const projectId = JSON.parse(await fs.promises.readFile(path.join(dir, ".climier.json"), "utf8")).project_id;
    const stateFile = path.join(process.env.CLIMIER_HOME!, "projects", projectId, "tasks.json");
    await fs.promises.writeFile(stateFile, "{not-json}", "utf8");
    const r = await runCli(["--project", dir, "status"]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(data), ["ok", "error"]);
    assert.equal(data.ok, false);
    assert.equal(data.error.code, "STORAGE_ERROR");
    assert.equal(typeof data.error.message, "string");
    assert.equal(data.error.details.cause, "CLIMIER_CORRUPT_STATE");
  } finally {
    await rmTempProject(dir);
  }
});
