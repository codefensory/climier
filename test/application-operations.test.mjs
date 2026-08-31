import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { importFresh } from "./helpers.mjs";

const OPERATIONS = "../src/application/operations/index.mjs";

function provider() {
  return {
    prepare() {},
    apply() {},
  };
}

test("application operations: exports executeOperation without importing the kernel", async () => {
  const { executeOperation } = await importFresh(OPERATIONS);
  assert.equal(typeof executeOperation, "function");

  const source = await fs.readFile(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src/application/operations/execute.mjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /from [\"'].*kernel\/mutate\.mjs[\"']/);
});

test("executeOperation: looks up once and delegates exactly once with an explicit request", async () => {
  const { executeOperation } = await importFresh(OPERATIONS);
  const calls = { lookup: 0, mutate: 0 };
  const entry = { id: "task.create", kind: "task", provider: provider() };
  const result = { result: { id: "T1" } };
  const source = {
    registry: {
      lookup(operation) {
        calls.lookup += 1;
        assert.equal(operation, "task.create");
        return entry;
      },
    },
    mutate(args) {
      calls.mutate += 1;
      assert.equal(args.projectDir, "/project");
      assert.deepEqual(args.request, {
        action: "task.create",
        actor: "alice",
        input: { id: "T1" },
      });
      assert.equal(args.provider, entry.provider);
      return result;
    },
  };

  const actual = await executeOperation({
    projectDir: "/project",
    actor: "alice",
    operation: "task.create",
    input: { id: "T1" },
    source,
  });

  assert.equal(actual, result);
  assert.equal(calls.lookup, 1);
  assert.equal(calls.mutate, 1);
});

test("executeOperation: preserves structured lookup and kernel errors", async () => {
  const { executeOperation } = await importFresh(OPERATIONS);
  const lookupError = Object.assign(new Error("unknown operation"), {
    code: "OPERATION_NOT_FOUND",
    details: { operation: "task.missing" },
  });
  await assert.rejects(
    executeOperation({
      projectDir: "/project",
      actor: "alice",
      operation: "task.missing",
      input: {},
      source: {
        registry: { lookup() { throw lookupError; } },
        mutate() { throw new Error("must not run"); },
      },
    }),
    (error) => error === lookupError && error.code === "OPERATION_NOT_FOUND" && error.details.operation === "task.missing",
  );

  const kernelError = Object.assign(new Error("revision changed"), {
    code: "REVISION_CONFLICT",
    details: { id: "T1", expected: 1, current: 2 },
  });
  await assert.rejects(
    executeOperation({
      projectDir: "/project",
      actor: "alice",
      operation: "task.update",
      input: { id: "T1", if_revision: 1 },
      source: {
        registry: { lookup() { return { provider: provider() }; } },
        mutate() { throw kernelError; },
      },
    }),
    (error) => error === kernelError && error.code === "REVISION_CONFLICT" && error.details.current === 2,
  );
});

test("executeOperation: rejects malformed calls with structured contract errors", async () => {
  const { executeOperation } = await importFresh(OPERATIONS);
  const source = {
    registry: { lookup() { return { provider: provider() }; } },
    mutate() {},
  };
  await assert.rejects(
    executeOperation(null),
    (error) => error.code === "INVALID_EXECUTION_CONTRACT" && error.details.field === "arguments",
  );

  for (const [field, args] of [
    ["projectDir", { actor: "alice", operation: "task.create", input: {}, source }],
    ["actor", { projectDir: "/project", operation: "task.create", input: {}, source }],
    ["operation", { projectDir: "/project", actor: "alice", input: {}, source }],
    ["source", { projectDir: "/project", actor: "alice", operation: "task.create", input: {} }],
  ]) {
    await assert.rejects(
      executeOperation(args),
      (error) => error.code === "INVALID_EXECUTION_CONTRACT" && error.details.field === field,
      `${field} should be a structured contract error`,
    );
  }
});
