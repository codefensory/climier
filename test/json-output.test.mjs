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
  // Seed a v2 project with one initiative and one ready task.
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
      // Some reads may legitimately 0-out (history might be empty if id is wrong); only fail on parse error.
      if (r.code !== 0) {
        // Allow JSON-shaped errors.
        assert.doesNotThrow(() => JSON.parse(r.stdout), `${cmd.join(" ")} stdout not JSON: ${r.stdout.slice(0, 100)}`);
      } else {
        assert.doesNotThrow(() => JSON.parse(r.stdout), `${cmd.join(" ")} stdout not JSON: ${r.stdout.slice(0, 100)}`);
      }
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("contract: every write command outputs valid JSON to stdout", async () => {
  const dir = await createTempProject();
  try {
    await seedV2Project(dir);
    // add-initiative (idempotent re-run on a different name)
    let r = await runCli(["--project", dir, "add-initiative", "spike", "--desc", "x"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `add-initiative stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // add-task with explicit id
    r = await runCli(["--project", dir, "add-task", "T-second", "--initiative", "migration", "--title", "x", "--body", "b", "--acceptance", "a", "--blocked-by", ""]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `add-task stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // take (claim-like)
    r = await runCli(["--project", dir, "take", "T-second", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `take stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // resolve (done-like)
    r = await runCli(["--project", dir, "resolve", "T-second", "--note", "shipped", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `resolve stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // reopen
    r = await runCli(["--project", dir, "reopen", "T-second", "--reason", "recheck", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `reopen stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // add-gate
    r = await runCli(["--project", dir, "add-gate", "G-x", "--initiative", "migration", "--title", "g", "--body", "b", "--purpose", "decision"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `add-gate stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // resolve a gate
    r = await runCli(["--project", dir, "resolve", "G-x", "--choice", "raw", "--rationale", "yes", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `resolve-gate stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // add-knowledge
    r = await runCli(["--project", dir, "add-knowledge", "K-x", "--initiative", "migration", "--title", "k", "--body", "b", "--scope-domains", "db"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `add-knowledge stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // deprecate-knowledge
    r = await runCli(["--project", dir, "deprecate-knowledge", "K-x", "--reason", "outdated", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `deprecate-knowledge stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // init (re-init a fresh dir)
    const dir2 = await createTempProject();
    try {
      r = await runCli(["--project", dir2, "init"]);
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotThrow(() => JSON.parse(r.stdout), `init stdout not JSON: ${r.stdout.slice(0, 100)}`);
    } finally { await rmTempProject(dir2); }
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
    assert.match(data.error, /unknown command/i);
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
    assert.match(data.error, /no command/i);
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
    assert.match(data.error, /unknown flag --json|no command given/i);
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
    assert.match(data.error, /unknown flag --banana/);
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