// Unknown flag rejection at the CLI level. Validation lives in bin/climier.mjs,
// so these tests run via the real CLI to exercise the dispatch path.
// Errors are JSON to stdout, not stderr.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, runCli, initExampleProject} from "./helpers.mjs";

test("CLI: claim --banana exits non-zero with JSON error on stdout", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
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

test("CLI: done --foo exits non-zero with JSON error on stdout", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    await runCli(["--project", dir, "claim", "F0.T1", "--as", "alice"]);
    const r = await runCli(["--project", dir, "done", "F0.T1", "shipped", "--as", "alice", "--foo", "bar"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error, /unknown flag --foo/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: pre-claim --verbose exits non-zero with JSON error on stdout", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    const r = await runCli(["--project", dir, "pre-claim", "F0.T1", "--verbose"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error, /unknown flag --verbose/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: status --watch exits non-zero with JSON error on stdout", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    const r = await runCli(["--project", dir, "status", "--watch"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error, /unknown flag --watch/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: add-decision --color exits non-zero with JSON error on stdout", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    const r = await runCli(["--project", dir, "add-decision", "D9", "--title", "x", "--color", "blue"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error, /unknown flag --color/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: error message lists the valid flags for the command", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    const r = await runCli(["--project", dir, "claim", "F0.T1", "--banana"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.match(data.error, /valid flags: --as/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: known flags still work and return JSON to stdout (no regression)", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    const r = await runCli(["--project", dir, "claim", "F0.T1", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.task.id, "F0.T1");
    assert.equal(data.task.status, "in_progress");
    assert.equal(data.task.claimed_by, "alice");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: --project is the only global flag (--json is gone)", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    // --project works for any command.
    const r = await runCli(["--project", dir, "ready"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.ok(Array.isArray(data));
  } finally {
    await rmTempProject(dir);
  }
});
