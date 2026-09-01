import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createTempProject, rmTempProject, runCli, stateFilePath } from "./helpers.mjs";
import { HELP_TEXT } from "../src/cli/dispatch.mjs";
import { RESERVED_NAMESPACES } from "../src/cli/commands/reserved-namespaces.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "bin", "climier.mjs");

async function runCliWithInput(args, input, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const proc = spawn("node", [BIN, ...args], {
      cwd,
      env: { ...process.env, ...(env || {}), NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
    proc.stdin.end(input);
  });
}

test("batch is a reserved command and appears in CLI help", () => {
  assert.ok(RESERVED_NAMESPACES.includes("batch"));
  assert.match(HELP_TEXT, /batch --file/);
  assert.match(HELP_TEXT, /batch --stdin/);
});

const batchDocument = {
  operations: [
    { op: "initiative.create", input: { name: "batch-cli" } },
    {
      op: "task.create",
      input: {
        id: "T-batch-cli",
        initiative: "batch-cli",
        title: "created by batch",
        body: "body",
        acceptance: "accepted",
      },
    },
  ],
};

test("batch CLI reads a JSON document from --file and returns the structured batch result", async () => {
  const dir = await createTempProject();
  const inputPath = path.join(dir, "batch.json");
  try {
    await runCli(["--project", dir, "init"]);
    await fs.writeFile(inputPath, JSON.stringify(batchDocument), "utf8");
    const result = await runCli(["--project", dir, "batch", "--file", inputPath, "--as", "alice"]);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.results.length, 2);
    assert.equal(output.results[0].op, "initiative.create");
    assert.equal(output.results[1].op, "task.create");

    const state = JSON.parse(await fs.readFile(stateFilePath(dir), "utf8"));
    assert.ok(state.nodes["T-batch-cli"]);
    assert.equal(state.log.at(-1).action, "core.batch");
  } finally {
    await rmTempProject(dir);
  }
});

test("batch CLI reads the same JSON contract from --stdin", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const result = await runCliWithInput(
      ["--project", dir, "batch", "--stdin", "--as", "alice"],
      JSON.stringify(batchDocument),
    );
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.results[1].result.id, "T-batch-cli");
  } finally {
    await rmTempProject(dir);
  }
});

test("batch CLI rejects malformed JSON and does not mutate state", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const before = await fs.readFile(stateFilePath(dir), "utf8");
    const result = await runCliWithInput(
      ["--project", dir, "batch", "--stdin", "--as", "alice"],
      "{not-json}",
    );
    assert.equal(result.code, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.code, "INVALID_EXECUTION_CONTRACT");
    assert.equal(await fs.readFile(stateFilePath(dir), "utf8"), before);
  } finally {
    await rmTempProject(dir);
  }
});

test("batch CLI keeps the state unchanged when a later operation fails", async () => {
  const dir = await createTempProject();
  const inputPath = path.join(dir, "batch-fails.json");
  try {
    await runCli(["--project", dir, "init"]);
    const before = await fs.readFile(stateFilePath(dir), "utf8");
    await fs.writeFile(inputPath, JSON.stringify({
      operations: [
        { op: "initiative.create", input: { name: "transient" } },
        { op: "initiative.create", input: { name: "transient" } },
      ],
    }), "utf8");
    const result = await runCli(["--project", dir, "batch", "--file", inputPath, "--as", "alice"]);
    assert.equal(result.code, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error.code, "BATCH_OPERATION_FAILED");
    assert.equal(output.error.details.operation_index, 1);
    assert.equal(output.error.details.op, "initiative.create");
    assert.equal(await fs.readFile(stateFilePath(dir), "utf8"), before);
  } finally {
    await rmTempProject(dir);
  }
});

test("batch CLI requires exactly one input source", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const result = await runCli(["--project", dir, "batch", "--as", "alice"]);
    assert.equal(result.code, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.code, "MISSING_FIELD");
  } finally {
    await rmTempProject(dir);
  }
});
