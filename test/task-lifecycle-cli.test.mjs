import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTempProject,
  rmTempProject,
  runCli,
} from "./helpers.mjs";
import { HELP_TEXT } from "../src/cli/dispatch.mjs";
import { RESERVED_NAMESPACES } from "../src/cli/commands/reserved-namespaces.mjs";

async function seedTask(dir, id = "T-lifecycle") {
  let result = await runCli(["--project", dir, "init"]);
  assert.equal(result.code, 0, result.stderr);
  result = await runCli(["--project", dir, "add-initiative", "workflow", "--desc", "Workflow"]);
  assert.equal(result.code, 0, result.stderr);
  result = await runCli([
    "--project", dir, "add-task", id,
    "--initiative", "workflow", "--title", "Lifecycle task",
    "--body", "body", "--acceptance", "acceptance", "--blocked-by", "",
  ]);
  assert.equal(result.code, 0, result.stderr);
}

async function jsonCommand(dir, ...args) {
  const result = await runCli(["--project", dir, ...args]);
  return { result, data: JSON.parse(result.stdout) };
}

test("CLI lifecycle commands are reserved and documented", () => {
  for (const command of ["submit", "accept", "reject"]) {
    assert.ok(RESERVED_NAMESPACES.includes(command), `${command} must be reserved`);
    assert.match(HELP_TEXT, new RegExp(`\\b${command}\\b`));
  }
});

test("CLI submit accepts --note and returns the node plus empty newly_ready", async () => {
  const dir = await createTempProject();
  try {
    await seedTask(dir);
    let out = await jsonCommand(dir, "take", "T-lifecycle", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    out = await jsonCommand(dir, "submit", "T-lifecycle", "--note", "ready for review", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.equal(out.data.node.id, "T-lifecycle");
    assert.equal(out.data.node.status, "submitted");
    assert.equal(out.data.node.note, "ready for review");
    assert.deepEqual(out.data.newly_ready, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI accept and reject validate required fields and preserve JSON errors", async () => {
  const dir = await createTempProject();
  try {
    await seedTask(dir, "T-accept");
    let out = await jsonCommand(dir, "take", "T-accept", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    out = await jsonCommand(dir, "submit", "T-accept", "--note", "handoff", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    out = await jsonCommand(dir, "accept", "T-accept", "--as", "validator");
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.equal(out.data.node.status, "done");
    assert.ok(Array.isArray(out.data.newly_ready));

    out = await jsonCommand(dir, "add-task", "T-reject",
      "--initiative", "workflow", "--title", "Reject task", "--body", "body",
      "--acceptance", "acceptance", "--blocked-by", "");
    assert.equal(out.result.code, 0, out.result.stderr);
    out = await jsonCommand(dir, "take", "T-reject", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    out = await jsonCommand(dir, "submit", "T-reject", "--note", "handoff", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    out = await jsonCommand(dir, "reject", "T-reject", "--as", "validator");
    assert.equal(out.result.code, 1);
    assert.equal(out.data.ok, false);
    assert.equal(out.data.error.code, "MISSING_FIELD");
    assert.match(out.data.error.message, /reject/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI resolve rejects tasks without mutating them; accept is the done transition", async () => {
  const dir = await createTempProject();
  try {
    await seedTask(dir, "T-resolve");
    let out = await jsonCommand(dir, "take", "T-resolve", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    out = await jsonCommand(dir, "resolve", "T-resolve", "--note", "done", "--as", "worker");
    assert.equal(out.result.code, 1);
    assert.equal(out.data.ok, false);
    assert.equal(out.data.error.code, "INVALID_EXECUTION_CONTRACT");

    out = await jsonCommand(dir, "submit", "T-resolve", "--note", "ready for validation", "--as", "worker");
    assert.equal(out.result.code, 0, out.result.stderr);
    out = await jsonCommand(dir, "accept", "T-resolve", "--as", "validator");
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.equal(out.data.node.status, "done");
  } finally {
    await rmTempProject(dir);
  }
});
