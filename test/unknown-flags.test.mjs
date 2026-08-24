// Unknown flag rejection at the CLI level. Validation lives in bin/climier.mjs,
// so these tests run via the real CLI to exercise the dispatch path.
// Errors are JSON to stdout, not stderr.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, runCli } from "./helpers.mjs";

async function seedV2(dir) {
  let r = await runCli(["--project", dir, "init"]);
  assert.equal(r.code, 0, r.stderr);
  r = await runCli(["--project", dir, "add-initiative", "migration", "--desc", "x"]);
  assert.equal(r.code, 0, r.stderr);
  r = await runCli(["--project", dir, "add-task", "--initiative", "migration", "--title", "seed", "--body", "b", "--acceptance", "a", "--blocked-by", ""]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout).node.id;
}

test("CLI: take --banana exits non-zero with JSON error on stdout", async () => {
  const dir = await createTempProject();
  try {
    const id = await seedV2(dir);
    const r = await runCli(["--project", dir, "take", id, "--as", "alice", "--banana", "split"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error, /unknown flag --banana/);
    assert.equal(r.stderr.trim(), "");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: resolve --foo exits non-zero with JSON error on stdout", async () => {
  const dir = await createTempProject();
  try {
    const id = await seedV2(dir);
    const take = await runCli(["--project", dir, "take", id, "--as", "alice"]);
    assert.equal(take.code, 0, take.stderr);
    const r = await runCli(["--project", dir, "resolve", id, "--note", "shipped", "--as", "alice", "--foo", "bar"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error, /unknown flag --foo/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: status --watch exits non-zero with JSON error on stdout", async () => {
  const dir = await createTempProject();
  try {
    await seedV2(dir);
    const r = await runCli(["--project", dir, "status", "--watch"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error, /unknown flag --watch/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: update --color exits non-zero with JSON error on stdout", async () => {
  const dir = await createTempProject();
  try {
    const id = await seedV2(dir);
    const r = await runCli(["--project", dir, "update", id, "--title", "x", "--as", "alice", "--color", "blue"]);
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
    const id = await seedV2(dir);
    const r = await runCli(["--project", dir, "take", id, "--banana"]);
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
    const id = await seedV2(dir);
    const r = await runCli(["--project", dir, "take", id, "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.node.id.startsWith("T-"), true);
    assert.equal(data.node.status, "in_progress");
    assert.equal(data.node.claim.by, "alice");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: --project is the only global flag (--json is gone)", async () => {
  const dir = await createTempProject();
  try {
    await seedV2(dir);
    const r = await runCli(["--project", dir, "status"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.ok(data.summary);
  } finally {
    await rmTempProject(dir);
  }
});