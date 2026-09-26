import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import batch from "../src/cli/commands/batch.mjs";
import { createBackendClient } from "../src/application/operations/index.mjs";
import { createLocalOperationSource } from "../src/application/local-operation-source.mjs";
import { runCli as runCliInProcess } from "../src/cli/dispatch.mjs";
import { createTempProject, rmTempProject } from "./helpers.mjs";

test("local backend creates and shares one lazy operation source with batch", async () => {
  const projectDir = await createTempProject();
  const inputPath = path.join(projectDir, "operations.json");
  await fs.writeFile(inputPath, JSON.stringify({
    operations: [{ op: "initiative.create", input: { name: "shared-source" } }],
  }), "utf8");
  const calls = [];
  const registry = {
    lookup(operation) {
      calls.push(["lookup", operation]);
      return { provider: { prepare() {}, apply() {} } };
    },
  };
  const source = {
    registry,
    mutate(mutation) {
      calls.push(["mutate", mutation]);
      return { ok: true, results: [] };
    },
    loadApplicablePolicy: async () => null,
    authorizeAction() { assert.fail("no policy should be selected"); },
  };
  const client = createBackendClient({
    projectDir,
    projectConfig: { backend: { type: "local" } },
    source,
  });
  const writes = [];
  try {
    const result = await runCliInProcess({
      argv: ["--project", projectDir, "batch", "--file", inputPath, "--as", "alice"],
      createBackendClient: () => client,
      write: (value) => writes.push(value),
      exit() {},
    });

    assert.equal(result, 0);
    assert.deepEqual(JSON.parse(writes[0]), { ok: true, results: [] });
    assert.deepEqual(calls.map(([kind]) => kind), ["mutate"]);
    assert.equal(calls[0][1].batch.registry, registry);
    assert.equal(calls[0][1].request.action, "core.batch");
  } finally {
    await rmTempProject(projectDir);
  }
});

test("remote dispatch does not load a local source", async () => {
  const projectDir = await createTempProject();
  const projectConfig = {
    version: 1,
    project_id: "remote-project",
    backend: { type: "remote", url: "https://climier.example.test" },
  };
  const client = { type: "remote" };
  const source = {
    registry: { lookup() { assert.fail("remote dispatch must not load local source"); } },
    mutate() { assert.fail("remote dispatch must not mutate local state"); },
  };
  const writes = [];
  try {
    await fs.writeFile(path.join(projectDir, ".climier.json"), JSON.stringify(projectConfig));
    const result = await runCliInProcess({
      argv: ["--project", projectDir, "take", "T1", "--as", "alice"],
      source,
      createBackendClient: () => client,
      dispatch: async (context) => {
        assert.equal(context.backendClient, client);
        assert.equal(context.source, source);
        return { ok: true };
      },
      write: (value) => writes.push(value),
      exit() {},
    });

    assert.equal(result, 0);
    assert.deepEqual(JSON.parse(writes[0]), { ok: true });
  } finally {
    await rmTempProject(projectDir);
  }
});

test("local source getter memoizes the complete source across concurrent requests", async () => {
  const getSource = createLocalOperationSource();
  const [first, second] = await Promise.all([getSource(), getSource()]);
  assert.equal(first, second);
  assert.ok(first.registry);
  assert.equal(typeof first.mutate, "function");
  assert.equal(typeof first.loadApplicablePolicy, "function");
  assert.equal(typeof first.authorizeAction, "function");
});

test("batch shares the already-selected local backend instead of rebuilding its source", async () => {
  const projectDir = await createTempProject();
  const inputPath = path.join(projectDir, "operations.json");
  const document = {
    operations: [{ op: "initiative.create", input: { name: "shared-source" } }],
  };
  const response = { ok: true, results: [] };
  const calls = [];
  const backendClient = {
    type: "local",
    executeOperation() { assert.fail("batch must not execute individual operations"); },
    executeBatch(args) {
      calls.push(args);
      return response;
    },
  };
  const source = {
    registry: { lookup() { assert.fail("batch must not build or execute a separate local source"); } },
    mutate() { assert.fail("batch must use the selected backend's shared source"); },
  };

  try {
    await fs.writeFile(inputPath, JSON.stringify(document), "utf8");
    const result = await batch({
      statePath: projectDir,
      projectDir,
      projectConfig: { backend: { type: "local" } },
      backendClient,
      source,
      flags: { file: inputPath, as: "alice" },
      positional: [],
    });

    assert.equal(result, response);
    assert.deepEqual(calls, [{ actor: "alice", operations: document.operations, if_state_revision: undefined }]);
  } finally {
    await rmTempProject(projectDir);
  }
});
