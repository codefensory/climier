import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import batchCommand from "../src/cli/commands/batch.ts";
import { createBackendClient } from "../src/application/operations/index.ts";
import { createLocalOperationSource } from "../src/application/local-operation-source.ts";
import { getOperationSource } from "../src/operation-source.ts";
import { dispatchCommand as dispatchCommandImpl, runCli as runCliCommand } from "../src/cli/dispatch.ts";

import { createTempProject, rmTempProject } from "./helpers.mjs";
import fsSync from "node:fs";
import type { SourceInput } from "../src/application/types.ts";

const batch = (context: unknown) => batchCommand(context as Parameters<typeof batchCommand>[0]);
const dispatchCommand = (options: unknown) => dispatchCommandImpl(options as Parameters<typeof dispatchCommandImpl>[0]);
const runCliInProcess = (options: unknown) => runCliCommand(options as Parameters<typeof runCliCommand>[0]);

async function executeLocalBatch(projectDir, inputPath, writes, client) {
  return runCliInProcess({ argv: ["--project", projectDir, "batch", "--file", inputPath, "--as", "alice"], createBackendClient: () => client, write: (value) => writes.push(value), exit() {} });
}

test("local backend creates and shares one lazy operation source with batch", async () => {
  const projectDir = await createTempProject();
  const inputPath = path.join(projectDir, "operations.json");
  await fs.writeFile(inputPath, JSON.stringify({
    operations: [{ op: "initiative.create", input: { name: "shared-source" } }],
  }), "utf8");
  const calls: Array<[string, { batch: { registry: unknown }; request: { action: string } }]> = [];
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
    source: source as unknown as SourceInput,
  });
  const writes: string[] = [];
  try {
    const result = await executeLocalBatch(projectDir, inputPath, writes, client);

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
  const writes: string[] = [];
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
  const getSource = getOperationSource;
  const [first, second] = await Promise.all([getSource(), getSource()]);
  assert.equal(first, second);
  assert.ok(first.registry);
  assert.equal(typeof first.mutate, "function");
  assert.equal(typeof first.loadApplicablePolicy, "function");
  assert.equal(typeof first.authorizeAction, "function");
});

test("local source receives policy ports from composition instead of importing plugins", async () => {
  const loadApplicablePolicy = async () => null;
  const authorizeAction = async () => ({ decision: "abstain" as const });
  const getSource = createLocalOperationSource(undefined, { loadApplicablePolicy, authorizeAction });
  const source = await getSource();

  assert.equal(source.loadApplicablePolicy, loadApplicablePolicy);
  assert.equal(source.authorizeAction, authorizeAction);
});

test("CLI and HTTP adapters consume the injected source builder", async () => {
  const files = [
    "src/cli/commands/add-edge.ts",
    "src/cli/commands/resolve.ts",
    "src/cli/commands/add-note.ts",
    "src/cli/commands/cancel.ts",
    "src/cli/commands/reopen.ts",
    "src/cli/commands/deprecate-knowledge.ts",
    "src/cli/commands/remove-edge.ts",
    "src/cli/commands/add-initiative.ts",
    "src/cli/commands/take.ts",
    "src/cli/commands/update.ts",
    "src/server/http.ts",
  ];
  const sources = await Promise.all(files.map((file) => fs.readFile(path.join(path.dirname(new URL(import.meta.url).pathname), "..", file), "utf8")));
  for (const [index, source] of sources.entries()) {
    assert.doesNotMatch(source, /bootstrapBuiltins|createBuiltinOperationRegistry/,
      `${files[index]} must not construct a second built-in registry`);
    assert.doesNotMatch(source, /selectPolicy\s*:\s*async\s*\(\)\s*=>\s*policy/,
      `${files[index]} must not create a per-command policy selector`);
  }
  assert.match(sources[10], /createOperationSource\(/);
});

test("batch shares the already-selected local backend instead of rebuilding its source", async () => {
  const projectDir = await createTempProject();
  const inputPath = path.join(projectDir, "operations.json");
  const document = {
    operations: [{ op: "initiative.create", input: { name: "shared-source" } }],
  };
  const response = { ok: true, results: [] };
  const calls: unknown[] = [];
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




async function assertRemotePluginNotLoaded(dir, marker) {
  const context = { projectDir: dir, statePath: dir,
    projectConfig: { project_id: "remote-project", backend: { type: "remote", url: "https://climier.example.test" } },
    backendClient: { type: "remote" } };
  const command = { command: "audit", originalArgv: ["audit", "ping"], flags: {} };
  await assert.rejects(() => dispatchCommand({ ...context, ...command }), (error) => {
    const failure = error as { code?: string; details?: { command?: string } };
    return failure.code === "REMOTE_UNSUPPORTED_OPERATION" && failure.details?.command === "audit";
  });
  assert.equal(fsSync.existsSync(marker), false);
  await assert.rejects(() => dispatchCommand({ ...context, ...command, flags: undefined }), (error) => (error as { code?: string }).code === "REMOTE_UNSUPPORTED_OPERATION");
  assert.equal(fsSync.existsSync(marker), false, "plugin entry remains unloaded for direct dispatch");
}

async function createPluginFixture(pluginHome) {
  const installed = path.join(pluginHome, "plugins", "installed", "audit");
  fsSync.mkdirSync(installed, { recursive: true });
  const marker = path.join(pluginHome, "loaded");
  fsSync.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "audit", version: "1.0.0", type: "module", climier: { id: "audit", command: "audit", entry: "./climier.mjs", api: 1 } }));
  fsSync.writeFileSync(path.join(installed, "climier.mjs"), `import fs from "node:fs"; fsSync.writeFileSync(${JSON.stringify(marker)}, "loaded"); export default { commands: { ping: () => ({ ok: true }) } };`);
  return marker;
}

test("dispatch: remote unsupported operation is denied before plugin loading", async () => {
  const dir = await createTempProject();
  const previousHome = process.env.CLIMIER_HOME;
  const pluginHome = fsSync.mkdtempSync(path.join(path.dirname(dir), "climier-remote-plugin-home-"));
  try {
    process.env.CLIMIER_HOME = pluginHome;
    const marker = await createPluginFixture(pluginHome);
    await assertRemotePluginNotLoaded(dir, marker);
  } finally {
    if (previousHome === undefined) { delete process.env.CLIMIER_HOME; }
    else { process.env.CLIMIER_HOME = previousHome; }
    await fsSync.promises.rm(pluginHome, { recursive: true, force: true });
    await rmTempProject(dir);
  }
});

async function rejectRemoteLocalOnlyCommands(context, source) {
  for (const [command, flags] of [["snapshots", {}], ["restore", {}], ["ui", {}], ["init", { force: true }]]) {
    await assert.rejects(() => dispatchCommand({ command, flags, ...context, source }),
      (error) => {
        const failure = error as { code?: string; details?: { command?: string } };
        return failure.code === "REMOTE_UNSUPPORTED_OPERATION" && failure.details?.command === command;
      });
  }
}

async function preserveInitAndStateDispatch(dir, client) {
  for (const command of ["state", "init"]) {
    let selected;
    const result = await runCliInProcess({ argv: ["--project", dir, command], createBackendClient: () => client,
      dispatch: async ({ command: name }) => { selected = name; return { ok: true }; }, write() {}, exit() {} });
    assert.equal(result, 0);
    assert.equal(selected, command);
  }
}

test("dispatch: remote unsupported snapshots command fails before local handler I/O", async () => {
  const dir = await createTempProject();
  try {
    const projectConfig = { project_id: "remote-project", backend: { type: "remote", url: "https://climier.example.test" } };
    const client = { type: "remote" };
    const sourceCalls: unknown[] = [];
    const source = {
      registry: { lookup(...args) { sourceCalls.push(["lookup", ...args]); } },
      mutate(...args) { sourceCalls.push(["mutate", ...args]); },
    };
    fsSync.writeFileSync(path.join(dir, ".climier.json"), JSON.stringify(projectConfig));
    await rejectRemoteLocalOnlyCommands({ projectDir: dir, statePath: dir, projectConfig, backendClient: client }, source);
    await preserveInitAndStateDispatch(dir, client);
    assert.deepEqual(sourceCalls, []);
    assert.equal(fsSync.existsSync(path.join(dir, ".climier.json")), true);
  } finally {
    await rmTempProject(dir);
  }
});

test("dispatch: absent or local project config selects the local backend without state I/O", async () => {
  for (const metadata of [null, { version: 1, project_id: "local-project", backend: { type: "local" } }]) {
    const dir = await createTempProject();
    try {
      if (metadata) { fsSync.writeFileSync(path.join(dir, ".climier.json"), JSON.stringify(metadata)); }
      let received;
      const result = await runCliInProcess({
        argv: ["--project", dir, "status", "--as", "alice"],
        write() {},
        exit() {},
        dispatch: async (context) => {
          received = context;
          return { ok: true };
        },
      });
      assert.equal(result, 0);
      assert.equal(received.projectDir, dir);
      assert.deepEqual(received.projectConfig, metadata || {});
      assert.equal(received.backendClient.type, "local");
      assert.equal(received.flags.as, "alice");
      assert.equal(fsSync.existsSync(path.join(dir, ".climier.json")), Boolean(metadata));
    } finally {
      await rmTempProject(dir);
    }
  }
});
