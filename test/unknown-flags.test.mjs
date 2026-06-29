// Unknown flag rejection at the CLI level. Validation lives in bin/climier.mjs,
// so these tests run via the real CLI to exercise the dispatch path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, runCli } from "./helpers.mjs";

test("CLI: claim --banana exits non-zero with clear error", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "claim", "F0.T1", "--as", "alice", "--banana", "split"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unknown flag --banana/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: done --foo exits non-zero with clear error", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    await runCli(["--project", dir, "claim", "F0.T1", "--as", "alice"]);
    const r = await runCli(["--project", dir, "done", "F0.T1", "shipped", "--as", "alice", "--foo", "bar"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unknown flag --foo/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: pre-claim --verbose exits non-zero with clear error", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "pre-claim", "F0.T1", "--verbose"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unknown flag --verbose/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: status --watch exits non-zero with clear error", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "status", "--watch"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unknown flag --watch/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: add-decision --color exits non-zero with clear error", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "add-decision", "D9", "--title", "x", "--color", "blue"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unknown flag --color/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: error message lists the valid flags for the command", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "claim", "F0.T1", "--banana"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /valid flags: --as/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: known flags still work (no regression)", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "claim", "F0.T1", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /claimed F0\.T1/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: --project and --json are always allowed (global flags)", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "--json", "ready"]);
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await rmTempProject(dir);
  }
});
