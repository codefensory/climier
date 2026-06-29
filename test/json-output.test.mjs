// Contract: the CLI is JSON-only. Every command outputs valid JSON to stdout.
// Errors are JSON to stdout, not stderr. The --json flag is gone (it's the default).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, runCli } from "./helpers.mjs";

async function seeded(dir) {
  const r = await runCli(["--project", dir, "init", "--seed", "migration"]);
  assert.equal(r.code, 0, r.stderr);
}

test("contract: every read command outputs valid JSON to stdout", async () => {
  const dir = await createTempProject();
  try {
    await seeded(dir);
    for (const cmd of [
      ["status"],
      ["ready"],
      ["tasks"],
      ["graph"],
      ["gotchas"],
      ["decisions"],
      ["log"],
      ["next", "F0.T1"],
      ["show", "F0.T1"],
      ["pre-claim", "F0.T1"],
    ]) {
      const r = await runCli(["--project", dir, ...cmd]);
      assert.equal(r.code, 0, `${cmd.join(" ")}: ${r.stderr}`);
      // Must be valid JSON.
      let data;
      try { data = JSON.parse(r.stdout); }
      catch (e) { assert.fail(`${cmd.join(" ")}: stdout is not JSON: ${r.stdout.slice(0, 100)}`); }
      assert.notEqual(data, undefined, `${cmd.join(" ")}: parsed to undefined`);
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("contract: every write command outputs valid JSON to stdout", async () => {
  const dir = await createTempProject();
  try {
    await seeded(dir);
    // claim
    let r = await runCli(["--project", dir, "claim", "F0.T1", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `claim stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // done
    r = await runCli(["--project", dir, "done", "F0.T1", "shipped", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `done stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // release (on a freshly-claimed task)
    r = await runCli(["--project", dir, "claim", "F0.T2", "--as", "bob"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "release", "F0.T2", "--as", "bob"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `release stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // reopen
    r = await runCli(["--project", dir, "reopen", "F0.T1", "recheck", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `reopen stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // decide
    r = await runCli(["--project", dir, "decide", "D1", "raw-postgres", "--because", "r"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `decide stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // add-task
    r = await runCli(["--project", dir, "add-task", "F9.T1", "--initiative", "migration", "--title", "x"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `add-task stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // add-decision
    r = await runCli(["--project", dir, "add-decision", "D9", "--title", "x"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `add-decision stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // add-gotcha
    r = await runCli(["--project", dir, "add-gotcha", "G9", "--title", "x", "--applies-to", "domain:db"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `add-gotcha stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // add-initiative
    r = await runCli(["--project", dir, "add-initiative", "z", "--desc", "x"]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `add-initiative stdout not JSON: ${r.stdout.slice(0, 100)}`);
    // init (re-init in a new dir)
    const dir2 = await createTempProject();
    try {
      r = await runCli(["--project", dir2, "init", "--seed", "migration"]);
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
    await seeded(dir);
    const r = await runCli(["--project", dir, "claim", "NOPE", "--as", "alice"]);
    assert.notEqual(r.code, 0);
    // The error is JSON on stdout, with { ok: false, error: <message> }.
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error, /not found/i);
    // Stderr is empty for command errors.
    assert.equal(r.stderr.trim(), "");
  } finally {
    await rmTempProject(dir);
  }
});

test("contract: unknown command is JSON to stdout with ok:false", async () => {
  const dir = await createTempProject();
  try {
    await seeded(dir);
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
    await seeded(dir);
    const r = await runCli(["--project", dir, "--json", "ready"]);
    // --json is not a recognized flag anymore → unknown flag error.
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error, /unknown flag --json/);
  } finally {
    await rmTempProject(dir);
  }
});

test("contract: unknown flag is JSON to stdout (not stderr)", async () => {
  const dir = await createTempProject();
  try {
    await seeded(dir);
    const r = await runCli(["--project", dir, "claim", "F0.T1", "--as", "alice", "--banana", "split"]);
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
    assert.match(r.stdout, /claim/);
    // --help is plain text, not JSON.
    assert.throws(() => JSON.parse(r.stdout), "--help output should not be JSON");
  } finally {
    await rmTempProject(dir);
  }
});
