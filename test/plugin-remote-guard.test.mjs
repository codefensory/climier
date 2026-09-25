import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createTempProject,
  rmTempProject,
  importFresh,
} from "./helpers.mjs";

const remote = { type: "remote", marker: "resolved-by-cli" };

async function withPluginHome(run) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-remote-plugin-home-"));
  const previous = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
}

function assertRemoteUnsupported(error) {
  assert.equal(error?.code, "REMOTE_UNSUPPORTED_OPERATION");
  assert.equal(error?.details?.backend, "remote");
}

test("plugin factories reject remote backends before filesystem access", async () => {
  const projectDir = await createTempProject();
  const { createApi } = await importFresh("./plugins/api.mjs");
  const { createQuery } = await importFresh("./plugins/query.mjs");
  const { createData } = await importFresh("./plugins/data.mjs");
  const { createCore } = await importFresh("./plugins/core-adapter.mjs");
  const { createRuntime } = await importFresh("./plugins/runtime.mjs");
  const originalReadFileSync = fsSync.readFileSync;
  const originalMkdirSync = fsSync.mkdirSync;
  let readFileCalls = 0;
  let mkdirCalls = 0;
  fsSync.readFileSync = (...args) => {
    readFileCalls++;
    return originalReadFileSync(...args);
  };
  fsSync.mkdirSync = (...args) => {
    mkdirCalls++;
    return originalMkdirSync(...args);
  };

  try {
    const factories = [
      ["createApi", () => createApi({ projectDir, agent: "alice", pluginId: "example.audit", backendClient: remote })],
      ["createQuery", () => createQuery({ projectDir, agent: "alice", pluginId: "example.audit", backendClient: remote })],
      ["createData", () => createData({ projectDir, agent: "alice", pluginId: "example.audit", backendClient: remote })],
      ["createCore", () => createCore({ projectDir, agent: "alice", pluginId: "example.audit", backendClient: remote })],
      ["createRuntime", () => createRuntime({ projectDir, agent: "alice", pluginId: "example.audit", backendClient: remote })],
    ];

    for (const [name, factory] of factories) {
      assert.throws(factory, (error) => {
        assertRemoteUnsupported(error);
        assert.match(error.message, new RegExp(name));
        return true;
      }, `${name} must reject a remote backend`);
    }
    assert.equal(readFileCalls, 0, "remote factories must not read local metadata");
    assert.equal(mkdirCalls, 0, "remote factories must not provision local runtime data");
  } finally {
    fsSync.readFileSync = originalReadFileSync;
    fsSync.mkdirSync = originalMkdirSync;
    await rmTempProject(projectDir);
  }
});

test("plugin dispatch rejects remote backend before plugin loading", async () => {
  await withPluginHome(async (home) => {
    const { dispatchPlugin } = await importFresh("./plugins/dispatch.mjs");
    const installedRoot = path.join(home, "plugins", "installed");
    await assert.rejects(
      dispatchPlugin({
        originalArgv: ["missing-plugin", "run"],
        namespace: "missing-plugin",
        projectDir: "/tmp/remote-project",
        backendClient: remote,
      }),
      (error) => {
        assertRemoteUnsupported(error);
        return true;
      },
    );
    await assert.rejects(fs.access(installedRoot), (error) => error.code === "ENOENT");
  });
});

test("plugin dispatch forwards backend context into the API factory", async () => {
  await withPluginHome(async (home) => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-remote-dispatch-project-"));
    try {
      const installedRoot = path.join(home, "plugins", "installed", "fixture");
      await fs.mkdir(installedRoot, { recursive: true });
      await fs.writeFile(path.join(installedRoot, "package.json"), JSON.stringify({
        name: "fixture",
        type: "module",
        climier: { id: "fixture", command: "fixture", entry: "./climier.mjs", api: 3 },
      }));
      await fs.writeFile(path.join(installedRoot, "climier.mjs"), "export default { commands: { ping: () => ({ ok: true }) } };\n");
      const { dispatchPlugin } = await importFresh("./plugins/dispatch.mjs");
      const backendClient = { type: "local", marker: "dispatch-to-factory" };
      let received;
      await dispatchPlugin({
        originalArgv: ["fixture", "ping"],
        namespace: "fixture",
        projectDir,
        backendClient,
        createApi: (args) => {
          received = args;
          return { runtime: { agent: "" } };
        },
      });
      assert.equal(received.backendClient, backendClient);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });
});

test("plugin CLI dispatch forwards its resolved backend client into plugin dispatch", async () => {
  const projectDir = await createTempProject();
  const received = [];
  const { dispatchCommand } = await importFresh("./cli/dispatch.mjs");
  const dispatchPlugin = (args) => {
    received.push(args);
    return { ok: true };
  };
  try {
    const result = await dispatchCommand({
      command: "fixture-plugin",
      originalArgv: ["fixture-plugin", "ping"],
      flags: {},
      positional: [],
      projectDir,
      backendClient: { type: "local", marker: "from-cli" },
      dispatchPlugin,
      hasInstalledPlugin: async () => true,
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(received[0].backendClient.marker, "from-cli");
  } finally {
    await rmTempProject(projectDir);
  }
});

test("plugin factories keep direct local construction compatible when backend context is omitted", async () => {
  const projectDir = await createTempProject();
  try {
    const { createApi } = await importFresh("./plugins/api.mjs");
    const { createQuery } = await importFresh("./plugins/query.mjs");
    const { createData } = await importFresh("./plugins/data.mjs");
    const { createCore } = await importFresh("./plugins/core-adapter.mjs");
    const { createRuntime } = await importFresh("./plugins/runtime.mjs");
    assert.ok(createApi({ projectDir, agent: "alice", pluginId: "example.audit" }));
    assert.ok(createQuery({ projectDir, agent: "alice", pluginId: "example.audit" }));
    assert.ok(createData({ projectDir, agent: "alice", pluginId: "example.audit" }));
    assert.ok(createCore({ projectDir, agent: "alice", pluginId: "example.audit" }));
    assert.ok(createRuntime({ projectDir, agent: "alice", pluginId: "example.audit" }));
  } finally {
    await rmTempProject(projectDir);
  }
});
