import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTempProject,
  rmTempProject,
  runCli,
} from "./helpers.ts";
import { HELP_TEXT } from "../src/cli/dispatch.ts";
import { RESERVED_NAMESPACES } from "../src/cli/commands/reserved-namespaces.ts";
import resolve from "../src/cli/commands/resolve.ts";
import reopen from "../src/cli/commands/reopen.ts";
import cancel from "../src/cli/commands/cancel.ts";
import { bootstrapBuiltins } from "../src/application/operations/index.ts";
import { mutate as kernelMutate } from "../src/kernel/mutate.ts";

const testContext = { command: "test", originalArgv: [], projectConfig: {} };

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

async function submitAndAccept(dir, id) {
  let out = await jsonCommand(dir, "take", id, "--as", "worker");
  assert.equal(out.result.code, 0, out.result.stderr);
  out = await jsonCommand(dir, "submit", id, "--note", "handoff", "--as", "worker");
  assert.equal(out.result.code, 0, out.result.stderr);
  out = await jsonCommand(dir, "accept", id, "--as", "validator");
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.equal(out.data.node.status, "done");
  assert.ok(Array.isArray(out.data.newly_ready));
}

async function addAndSubmitRejectTask(dir) {
  let out = await jsonCommand(dir, "add-task", "T-reject",
    "--initiative", "workflow", "--title", "Reject task", "--body", "body",
    "--acceptance", "acceptance", "--blocked-by", "");
  assert.equal(out.result.code, 0, out.result.stderr);
  out = await jsonCommand(dir, "take", "T-reject", "--as", "worker");
  assert.equal(out.result.code, 0, out.result.stderr);
  out = await jsonCommand(dir, "submit", "T-reject", "--note", "handoff", "--as", "worker");
  assert.equal(out.result.code, 0, out.result.stderr);
  return jsonCommand(dir, "reject", "T-reject", "--as", "validator");
}

function createLifecycleOperationSource(operations) {
  return {
    registry: bootstrapBuiltins(),
    mutate(args) {
      operations.push(args.request.action);
      return kernelMutate(args);
    },
    selectPolicy: async () => null,
  };
}

async function prepareReopenCancelProject(dir) {
  let result = await runCli(["--project", dir, "init"]);
  assert.equal(result.code, 0, result.stderr);
  result = await runCli(["--project", dir, "add-initiative", "workflow", "--desc", "Workflow"]);
  assert.equal(result.code, 0, result.stderr);
  for (const [id, title] of [["T-reopen", "Reopen"], ["T-cancel", "Cancel"]]) {
    result = await runCli(["--project", dir, "add-task", id, "--initiative", "workflow", "--title", title, "--body", "body", "--acceptance", "accepted", "--blocked-by", ""]);
    assert.equal(result.code, 0, result.stderr);
  }
  for (const id of ["G-reopen", "G-cancel"]) {
    result = await runCli(["--project", dir, "add-gate", id, "--initiative", "workflow", "--title", id, "--body", "body", "--purpose", "decision"]);
    assert.equal(result.code, 0, result.stderr);
  }
}

async function seedReopenCancelStates(dir) {
  for (const args of [
    ["resolve", "G-reopen", "--choice", "yes", "--rationale", "accepted", "--as", "validator"],
    ["take", "T-reopen", "--as", "worker"],
    ["submit", "T-reopen", "--note", "handoff", "--as", "worker"],
    ["accept", "T-reopen", "--as", "validator"],
    ["take", "T-cancel", "--as", "worker"],
  ]) {
    await runCli(["--project", dir, ...args]);
  }
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
    await submitAndAccept(dir, "T-accept");
    const out = await addAndSubmitRejectTask(dir);
    assert.equal(out.result.code, 1);
    assert.equal(out.data.ok, false);
    assert.equal(out.data.error.code, "MISSING_FIELD");
    assert.match(out.data.error.message, /reject/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI resolve delegates its gate operation through Application Operations", async () => {
  const dir = await createTempProject();
  const operations = [];
  const source = createLifecycleOperationSource(operations);
  try {
    let result = await runCli(["--project", dir, "init"]);
    assert.equal(result.code, 0, result.stderr);
    result = await runCli(["--project", dir, "add-initiative", "workflow", "--desc", "Workflow"]);
    assert.equal(result.code, 0, result.stderr);
    result = await runCli(["--project", dir, "add-gate", "G-resolve", "--initiative", "workflow", "--title", "Decision", "--body", "body", "--purpose", "decision"]);
    assert.equal(result.code, 0, result.stderr);

    const out = await resolve({
      ...testContext,
      projectDir: dir,
      statePath: dir,
      source,
      positional: ["G-resolve"],
      flags: { choice: "yes", rationale: "accepted", as: "operator" },
    });
    assert.equal(out.node.status, "resolved");
    await assert.rejects(
      resolve({
        ...testContext,
        projectDir: dir,
        statePath: dir,
        source,
        positional: ["G-resolve"],
        flags: { choice: "yes", rationale: "accepted", as: "operator" },
      }),
      (error: unknown) => error instanceof Error && error.code === "INVALID_STATUS",
    );
    assert.deepEqual(operations, ["gate.resolve", "gate.resolve"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI reopen and cancel delegate task and gate lifecycle through Application Operations", async () => {
  const dir = await createTempProject();
  const operations = [];
  const source = createLifecycleOperationSource(operations);
  try {
    await prepareReopenCancelProject(dir);
    await seedReopenCancelStates(dir);

    const reopenedTask = await reopen({ ...testContext, projectDir: dir, statePath: dir, source, positional: ["T-reopen"], flags: { reason: "retry", as: "operator" } });
    const reopenedGate = await reopen({ ...testContext, projectDir: dir, statePath: dir, source, positional: ["G-reopen"], flags: { reason: "retry", as: "operator" } });
    const canceledTask = await cancel({ ...testContext, projectDir: dir, statePath: dir, source, positional: ["T-cancel"], flags: { reason: "stop", as: "operator" }, backendClient: undefined, pluginId: undefined } as unknown as Parameters<typeof cancel>[0]);
    const canceledGate = await cancel({ ...testContext, projectDir: dir, statePath: dir, source, positional: ["G-cancel"], flags: { reason: "stop", as: "operator" }, backendClient: undefined, pluginId: undefined } as unknown as Parameters<typeof cancel>[0]);
    assert.ok(reopenedTask.node);
    assert.equal(reopenedTask.node.status, "open");
    assert.ok(reopenedGate.node);
    assert.equal(reopenedGate.node.status, "open");
    assert.equal(canceledTask.node.status, "canceled");
    assert.equal(canceledGate.node.status, "canceled");
    assert.deepEqual(operations, ["task.reopen", "task.reopen", "task.cancel", "task.cancel"]);
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
    out = await jsonCommand(dir, "resolve", "T-resolve", "--choice", "done", "--rationale", "not a gate", "--as", "worker");
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
