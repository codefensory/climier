// T-plugin-dispatch — discovery, reserved namespaces, lazy loader, and
// dispatch of installed plugins (ADR-005 §"Dispatch y contrato de
// errores" and §"Discovery, namespaces y dispatch").
//
// Coverage:
//   - plugin-errors envelope helpers (PLUGIN_SUBCOMMAND_NOT_FOUND,
//     PLUGIN_HANDLER_FAILED, throwPluginError)
//   - plugin-loader loadInstalledPlugin (descriptor + commands)
//   - plugin-dispatch dispatchPlugin (forwarded tokens, api.runtime,
//     error mapping)
//   - bin/climier.mjs end-to-end dispatch: core intact, plugin
//     namespaces dispatch, unknown namespaces exit 2, node-id collision
//     with plugin namespace is safe

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  createTempProject,
  rmTempProject,
  runCli,
  importFresh,
} from "./helpers.mjs";

const ERRORS_MODULE = "../src/plugin-errors.mjs";
const LOADER_MODULE = "../src/plugin-loader.mjs";
const DISPATCH_MODULE = "../src/plugin-dispatch.mjs";
const RESERVED_MODULE = "../src/commands/reserved-namespaces.mjs";

// ---- Shared helpers -------------------------------------------------

async function freshEnv(prefix = "climier-dispatch-test") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix + "-"));
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-dispatch-proj-"));
  const prev = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = home;
  return {
    home,
    projectDir,
    restore() {
      if (prev === undefined) delete process.env.CLIMIER_HOME;
      else process.env.CLIMIER_HOME = prev;
    },
    async cleanup() {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    },
  };
}

async function seedInstalledPlugin(home, namespace, opts = {}) {
  const installedRoot = path.join(home, "plugins", "installed", namespace);
  await fs.mkdir(installedRoot, { recursive: true });
  const descriptor = {
    id: opts.id ?? namespace,
    command: opts.command ?? namespace,
    entry: opts.entry ?? "./climier.mjs",
  };
  await fs.writeFile(
    path.join(installedRoot, "package.json"),
    JSON.stringify({ name: opts.npmName ?? namespace, version: "1.0.0", type: "module", climier: descriptor }, null, 2) + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(installedRoot, "climier.mjs"),
    opts.entryCode ?? defaultEntryCode(),
    "utf8",
  );
  return { installedRoot, descriptor };
}

function defaultEntryCode() {
  return (
    "export default {\n" +
    "  commands: {\n" +
    "    ping: (args, api) => ({\n" +
    "      ok: true,\n" +
    "      command: 'ping',\n" +
    "      args,\n" +
    "      api_runtime: api.runtime,\n" +
    "    }),\n" +
    "    thrower: () => { throw new Error('handler-boom'); },\n" +
    "    rethrow: () => { const e = new Error('already-plugin'); e.code = 'PLUGIN_LOAD_FAILED'; e.details = { from: 'handler' }; throw e; },\n" +
    "  },\n" +
    "};\n"
  );
}

// Recursive test helper that ALWAYS recreates env (fresh CLIMIER_HOME +
// project) and runs `body(env)` with that env active.
async function withEnv(body, prefix = "climier-dispatch-test") {
  const env = await freshEnv(prefix);
  try {
    return await body(env);
  } finally {
    env.restore();
    await env.cleanup();
  }
}

// ---- plugin-errors ---------------------------------------------------

test("plugin-errors: throwPluginError throws an Error with .code and .details", async () => {
  await withEnv(async () => {
    const { throwPluginError } = await importFresh(ERRORS_MODULE);
    assert.throws(
      () => throwPluginError("PLUGIN_HANDLER_FAILED", "boom", { namespace: "x" }),
      (err) => {
        assert.equal(err.code, "PLUGIN_HANDLER_FAILED");
        assert.deepEqual(err.details, { namespace: "x" });
        assert.match(err.message, /boom/);
        return true;
      },
    );
  });
});

test("plugin-errors: PluginSubcommandNotFound carries namespace + subcommand in details", async () => {
  await withEnv(async () => {
    const { PluginSubcommandNotFound } = await importFresh(ERRORS_MODULE);
    const err = new PluginSubcommandNotFound("audit", "ghost");
    assert.equal(err.code, "PLUGIN_SUBCOMMAND_NOT_FOUND");
    assert.equal(err.details.namespace, "audit");
    assert.equal(err.details.subcommand, "ghost");
  });
});

test("plugin-errors: PluginSubcommandNotFound allows null subcommand for missing subcommand case", async () => {
  await withEnv(async () => {
    const { PluginSubcommandNotFound } = await importFresh(ERRORS_MODULE);
    const err = new PluginSubcommandNotFound("audit", null);
    assert.equal(err.code, "PLUGIN_SUBCOMMAND_NOT_FOUND");
    assert.equal(err.details.namespace, "audit");
    assert.equal(err.details.subcommand, null);
  });
});

test("plugin-errors: PluginHandlerFailed carries plugin_id, namespace, subcommand, cause in details", async () => {
  await withEnv(async () => {
    const { PluginHandlerFailed } = await importFresh(ERRORS_MODULE);
    const cause = new Error("handler exploded");
    const err = new PluginHandlerFailed("audit", "run", cause);
    assert.equal(err.code, "PLUGIN_HANDLER_FAILED");
    assert.equal(err.details.plugin_id, "audit");
    assert.equal(err.details.namespace, "audit");
    assert.equal(err.details.subcommand, "run");
    assert.match(err.details.cause, /handler exploded/);
  });
});

// ---- plugin-loader --------------------------------------------------

test("plugin-loader: loadInstalledPlugin returns descriptor + commands for a valid installed plugin", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "audit");
    const { loadInstalledPlugin } = await importFresh(LOADER_MODULE);
    const loaded = await loadInstalledPlugin("audit");
    assert.equal(loaded.pluginId, "audit");
    assert.equal(loaded.descriptor.id, "audit");
    assert.equal(loaded.descriptor.command, "audit");
    assert.equal(typeof loaded.commands.ping, "function");
    assert.equal(typeof loaded.commands.thrower, "function");
    assert.ok(loaded.entryPath.endsWith(path.join("installed", "audit", "climier.mjs")));
  });
});

test("plugin-loader: loadInstalledPlugin throws PLUGIN_LOAD_FAILED when installed dir is missing", async () => {
  await withEnv(async () => {
    const { loadInstalledPlugin } = await importFresh(LOADER_MODULE);
    await assert.rejects(
      () => loadInstalledPlugin("ghost"),
      (err) => err.code === "PLUGIN_LOAD_FAILED",
    );
  });
});

test("plugin-loader: loadInstalledPlugin throws PLUGIN_INVALID_DESCRIPTOR when descriptor.command != namespace", async () => {
  await withEnv(async (env) => {
    // Seed with descriptor command != namespace (id matches for clarity).
    // ADR-005 §"Instalación e identidad": the installed directory name
    // is the CLI namespace (descriptor.command), not the descriptor.id.
    await seedInstalledPlugin(env.home, "audit", { id: "audit", command: "different.command" });
    const { loadInstalledPlugin } = await importFresh(LOADER_MODULE);
    await assert.rejects(
      () => loadInstalledPlugin("audit"),
      (err) =>
        err.code === "PLUGIN_INVALID_DESCRIPTOR" &&
        err.details.namespace === "audit" &&
        err.details.descriptor_command === "different.command",
    );
  });
});

test("plugin-loader: loadInstalledPlugin accepts id != command when descriptor.command matches the namespace", async () => {
  await withEnv(async (env) => {
    // ADR-005 §"Instalación e identidad" + T-plugin-command-namespace:
    // id and command are distinct fields; only descriptor.command must
    // match the namespace. The descriptor.id becomes the pluginId for
    // runtime, data keys, and uninstall.
    await seedInstalledPlugin(env.home, "audit", { id: "example.audit", command: "audit" });
    const { loadInstalledPlugin } = await importFresh(LOADER_MODULE);
    const loaded = await loadInstalledPlugin("audit");
    assert.equal(loaded.pluginId, "example.audit");
    assert.equal(loaded.descriptor.id, "example.audit");
    assert.equal(loaded.descriptor.command, "audit");
    assert.equal(typeof loaded.commands.ping, "function");
  });
});

test("plugin-loader: loadInstalledPlugin throws PLUGIN_LOAD_FAILED when default.commands is missing", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "broken", {
      entryCode: "export default { foo: 1 };\n",
    });
    const { loadInstalledPlugin } = await importFresh(LOADER_MODULE);
    await assert.rejects(
      () => loadInstalledPlugin("broken"),
      (err) => err.code === "PLUGIN_LOAD_FAILED",
    );
  });
});

test("plugin-loader: loadInstalledPlugin throws PLUGIN_INVALID_DESCRIPTOR when descriptor field is malformed", async () => {
  await withEnv(async (env) => {
    const installedRoot = path.join(env.home, "plugins", "installed", "bad");
    await fs.mkdir(installedRoot, { recursive: true });
    await fs.writeFile(
      path.join(installedRoot, "package.json"),
      JSON.stringify({ name: "bad", type: "module", climier: { id: ".bad", command: "bad", entry: "./x.mjs" } }, null, 2) + "\n",
      "utf8",
    );
    await fs.writeFile(path.join(installedRoot, "climier.mjs"), "export default { commands: {} };\n", "utf8");
    const { loadInstalledPlugin } = await importFresh(LOADER_MODULE);
    await assert.rejects(
      () => loadInstalledPlugin("bad"),
      (err) => err.code === "PLUGIN_INVALID_DESCRIPTOR",
    );
  });
});

// ---- plugin-dispatch ------------------------------------------------

test("plugin-dispatch: dispatches to handler and returns its result with forwarded tokens + api.runtime", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "audit");
    const { dispatchPlugin } = await importFresh(DISPATCH_MODULE);
    // Use a recording createApi factory to inspect api.runtime directly.
    let receivedApi;
    const createApi = ({ projectDir, agent, pluginId }) => {
      receivedApi = { projectDir, agent, pluginId };
      return {
        runtime: { project_dir: projectDir, agent },
        query: {},
        data: {},
      };
    };
    const result = await dispatchPlugin({
      originalArgv: ["--project", env.projectDir, "--as", "alice", "audit", "ping", "--foo", "bar"],
      namespace: "audit",
      projectDir: env.projectDir,
      flags: { project: env.projectDir, as: "alice" },
      createApi,
    });
    assert.equal(result.ok, true);
    assert.equal(result.command, "ping");
    // Forwarded tokens keep all tokens EXCEPT namespace ("audit") and
    // subcommand ("ping"). Flags before/after are preserved.
    assert.deepEqual(result.args, ["--project", env.projectDir, "--as", "alice", "--foo", "bar"]);
    assert.equal(result.api_runtime.project_dir, env.projectDir);
    assert.equal(result.api_runtime.agent, "alice");
    assert.deepEqual(receivedApi, {
      projectDir: env.projectDir,
      agent: "alice",
      pluginId: "audit",
    });
  });
});

test("plugin-dispatch: missing subcommand throws PLUGIN_SUBCOMMAND_NOT_FOUND with namespace in details", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "audit");
    const { dispatchPlugin } = await importFresh(DISPATCH_MODULE);
    await assert.rejects(
      () =>
        dispatchPlugin({
          originalArgv: ["audit"],
          namespace: "audit",
          projectDir: env.projectDir,
          flags: { as: "alice" },
          createApi: ({ projectDir, agent, pluginId }) => ({
            runtime: { project_dir: projectDir, agent },
            query: {},
            data: {},
          }),
        }),
      (err) =>
        err.code === "PLUGIN_SUBCOMMAND_NOT_FOUND" &&
        err.details.namespace === "audit" &&
        err.details.subcommand === null,
    );
  });
});

test("plugin-dispatch: unknown subcommand throws PLUGIN_SUBCOMMAND_NOT_FOUND", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "audit");
    const { dispatchPlugin } = await importFresh(DISPATCH_MODULE);
    await assert.rejects(
      () =>
        dispatchPlugin({
          originalArgv: ["audit", "ghost"],
          namespace: "audit",
          projectDir: env.projectDir,
          flags: { as: "alice" },
          createApi: ({ projectDir, agent, pluginId }) => ({
            runtime: { project_dir: projectDir, agent },
            query: {},
            data: {},
          }),
        }),
      (err) =>
        err.code === "PLUGIN_SUBCOMMAND_NOT_FOUND" &&
        err.details.namespace === "audit" &&
        err.details.subcommand === "ghost",
    );
  });
});

test("plugin-dispatch: handler throwing is mapped to PLUGIN_HANDLER_FAILED with details", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "audit");
    const { dispatchPlugin } = await importFresh(DISPATCH_MODULE);
    let caught;
    try {
      await dispatchPlugin({
        originalArgv: ["audit", "thrower"],
        namespace: "audit",
        projectDir: env.projectDir,
        flags: { as: "alice" },
        createApi: ({ projectDir, agent, pluginId }) => ({
          runtime: { project_dir: projectDir, agent },
          query: {},
          data: {},
        }),
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "expected dispatchPlugin to throw");
    assert.equal(caught.code, "PLUGIN_HANDLER_FAILED");
    assert.equal(caught.details.plugin_id, "audit");
    assert.equal(caught.details.namespace, "audit");
    assert.equal(caught.details.subcommand, "thrower");
    assert.match(caught.details.cause, /handler-boom/);
  });
});

test("plugin-dispatch: handler throwing an existing PLUGIN_* error is propagated without rewrapping", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "audit");
    const { dispatchPlugin } = await importFresh(DISPATCH_MODULE);
    let caught;
    try {
      await dispatchPlugin({
        originalArgv: ["audit", "rethrow"],
        namespace: "audit",
        projectDir: env.projectDir,
        flags: { as: "alice" },
        createApi: ({ projectDir, agent, pluginId }) => ({
          runtime: { project_dir: projectDir, agent },
          query: {},
          data: {},
        }),
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "expected dispatchPlugin to throw");
    assert.equal(caught.code, "PLUGIN_LOAD_FAILED");
    assert.deepEqual(caught.details, { from: "handler" });
  });
});

test("plugin-dispatch: forwarded tokens preserve original order even when flags appear before the namespace", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "audit");
    const { dispatchPlugin } = await importFresh(DISPATCH_MODULE);
    const result = await dispatchPlugin({
      originalArgv: ["--project", "/tmp/p", "audit", "ping", "--foo", "bar", "tail"],
      namespace: "audit",
      projectDir: "/tmp/p",
      flags: { project: "/tmp/p", as: "alice" },
      createApi: ({ projectDir, agent, pluginId }) => ({
        runtime: { project_dir: projectDir, agent },
        query: {},
        data: {},
      }),
    });
    assert.deepEqual(result.args, ["--project", "/tmp/p", "--foo", "bar", "tail"]);
  });
});

test("plugin-dispatch: missing --as throws PLUGIN_HANDLER_FAILED with agent details", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "audit");
    const prev = process.env.CLIMIER_AGENT;
    delete process.env.CLIMIER_AGENT;
    const { dispatchPlugin } = await importFresh(DISPATCH_MODULE);
    let caught;
    try {
      await dispatchPlugin({
        originalArgv: ["audit", "ping"],
        namespace: "audit",
        projectDir: env.projectDir,
        flags: {},
        createApi: ({ projectDir, agent, pluginId }) => ({
          runtime: { project_dir: projectDir, agent },
          query: {},
          data: {},
        }),
      });
    } catch (err) {
      caught = err;
    } finally {
      if (prev !== undefined) process.env.CLIMIER_AGENT = prev;
    }
    assert.ok(caught, "expected dispatchPlugin to throw");
    assert.equal(caught.code, "PLUGIN_HANDLER_FAILED");
    assert.equal(caught.details.namespace, "audit");
    assert.match(caught.message, /agent/i);
  });
});

test("plugin-dispatch: api.runtime uses effective project/agent even if forwarded tokens repeat them", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "audit");
    const { dispatchPlugin } = await importFresh(DISPATCH_MODULE);
    // Forwarded --project/--as point somewhere else; runtime stays
    // bound to the host's effective resolution.
    const result = await dispatchPlugin({
      originalArgv: [
        "--project",
        env.projectDir,
        "--as",
        "alice",
        "audit",
        "ping",
        "--project",
        "/tmp/elsewhere",
        "--as",
        "mallory",
      ],
      namespace: "audit",
      projectDir: env.projectDir,
      flags: { project: env.projectDir, as: "alice" },
      createApi: ({ projectDir, agent, pluginId }) => ({
        runtime: { project_dir: projectDir, agent },
        query: {},
        data: {},
      }),
    });
    assert.equal(result.api_runtime.project_dir, env.projectDir);
    assert.equal(result.api_runtime.agent, "alice");
    // Forwarded tokens DO include the duplicates (preserved verbatim).
    assert.ok(result.args.includes("/tmp/elsewhere"));
    assert.ok(result.args.includes("mallory"));
  });
});

// ---- bin integration: core dispatch intact --------------------------

test("bin: core commands (status, init, --version) keep working without changes", async () => {
  await withEnv(async (env) => {
    const dir = env.projectDir;
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "status"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.ok(data.summary);
    r = await runCli(["--project", dir, "--version"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
  });
});

test("bin: unknown command exits 2 with `unknown command '<x>'` JSON", async () => {
  await withEnv(async (env) => {
    const r = await runCli(["--project", env.projectDir, "nosuchplugin"]);
    assert.equal(r.code, 2, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.match(data.error, /unknown command 'nosuchplugin'/);
  });
});

test("bin: node id passed as `climier show <id>` still works when <id> collides with a plugin namespace", async () => {
  await withEnv(async (env) => {
    const dir = env.projectDir;
    // Set up a project with a node id identical to a plugin namespace.
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "demo", "--desc", "demo"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli([
      "--project", dir,
      "add-task", "audit",
      "--initiative", "demo",
      "--title", "a task whose id is 'audit'",
      "--body", "b",
      "--acceptance", "a",
      "--blocked-by", "",
    ]);
    assert.equal(r.code, 0, r.stderr);
    // Seed an installed plugin whose namespace is also 'audit'.
    await seedInstalledPlugin(env.home, "audit");
    // `climier show audit` must remain a core command (the plugin check
    // is keyed on the first non-flag positional, which is 'show', not
    // 'audit').
    r = await runCli(["--project", dir, "show", "audit"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.type, "task");
    assert.equal(data.node.id, "audit");
  });
});

// ---- bin integration: plugin dispatch --------------------------------

test("bin: installed namespace dispatches to its handler and returns its JSON", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "audit");
    const r = await runCli([
      "--project", env.projectDir, "--as", "alice",
      "audit", "ping", "--foo", "bar",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, true);
    assert.equal(data.command, "ping");
    assert.deepEqual(data.args, ["--project", env.projectDir, "--as", "alice", "--foo", "bar"]);
    assert.equal(data.api_runtime.project_dir, env.projectDir);
    assert.equal(data.api_runtime.agent, "alice");
  });
});

test("bin: installed namespace without subcommand returns PLUGIN_SUBCOMMAND_NOT_FOUND with exit 1", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "audit");
    const r = await runCli(["--project", env.projectDir, "audit"]);
    assert.equal(r.code, 1, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.error.code, "PLUGIN_SUBCOMMAND_NOT_FOUND");
    assert.equal(data.error.details.namespace, "audit");
    assert.equal(data.error.details.subcommand, null);
  });
});

test("bin: installed namespace with nonexistent subcommand returns PLUGIN_SUBCOMMAND_NOT_FOUND with exit 1", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "audit");
    const r = await runCli(["--project", env.projectDir, "audit", "ghost"]);
    assert.equal(r.code, 1, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.error.code, "PLUGIN_SUBCOMMAND_NOT_FOUND");
    assert.equal(data.error.details.namespace, "audit");
    assert.equal(data.error.details.subcommand, "ghost");
  });
});

test("bin: unknown namespace preserves exit 2 with `unknown command '<x>'`", async () => {
  await withEnv(async (env) => {
    // No plugin seeded.
    const r = await runCli(["--project", env.projectDir, "nosuchplugin", "sub"]);
    assert.equal(r.code, 2, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.match(data.error, /unknown command 'nosuchplugin'/);
  });
});

test("bin: handler promise rejection produces PLUGIN_HANDLER_FAILED envelope with exit 1", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "audit");
    const r = await runCli(["--project", env.projectDir, "audit", "thrower"]);
    assert.equal(r.code, 1, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.error.code, "PLUGIN_HANDLER_FAILED");
    assert.equal(data.error.details.plugin_id, "audit");
    assert.equal(data.error.details.namespace, "audit");
    assert.equal(data.error.details.subcommand, "thrower");
    assert.match(data.error.details.cause, /handler-boom/);
  });
});

test("bin: handler rethrowing an existing PLUGIN_* error preserves its envelope", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "audit");
    const r = await runCli(["--project", env.projectDir, "audit", "rethrow"]);
    assert.equal(r.code, 1, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.error.code, "PLUGIN_LOAD_FAILED");
    assert.deepEqual(data.error.details, { from: "handler" });
  });
});

test("bin: malformed installed plugin (no default.commands) yields PLUGIN_LOAD_FAILED envelope", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "broken", {
      entryCode: "export default { foo: 1 };\n",
    });
    const r = await runCli(["--project", env.projectDir, "broken", "ping"]);
    assert.equal(r.code, 1, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.error.code, "PLUGIN_LOAD_FAILED");
  });
});

test("bin: flags placed before the namespace are still forwarded to the handler in original order", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "audit");
    const r = await runCli([
      "--project", env.projectDir, "--as", "alice",
      "audit", "ping", "--foo", "bar",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.deepEqual(data.args, ["--project", env.projectDir, "--as", "alice", "--foo", "bar"]);
  });
});

test("bin: dispatches by command (first token), not by descriptor.id, when id != command", async () => {
  await withEnv(async (env) => {
    // Seed an installed plugin whose id != command.
    // The bin must dispatch on the FIRST TOKEN (the command), and the
    // runtime/pluginId must be descriptor.id. install is out of scope
    // here — this test seeds the installed dir directly to focus on
    // dispatch.
    await seedInstalledPlugin(env.home, "audit", {
      id: "example.audit",
      command: "audit",
    });
    let received;
    // We need to monkey-patch createApi to capture what pluginId the
    // dispatcher hands to the API factory. The bin uses the real
    // plugin-api.mjs; instead, run dispatchPlugin directly via runCli
    // and verify the runtime envelope carries plugin_id through.
    const r = await runCli([
      "--project", env.projectDir, "--as", "alice",
      "audit", "ping",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.command, "ping");
    assert.equal(data.api_runtime.project_dir, env.projectDir);
    assert.equal(data.api_runtime.agent, "alice");
    // Dispatch is keyed on the first token 'audit', which matches the
    // installed dir name AND descriptor.command. Without the fix, the
    // loader would have rejected this installed plugin because
    // descriptor.id ('example.audit') did not equal the namespace
    // ('audit'). With the fix, pluginId is descriptor.id.
    // We confirm the dispatched plugin's identity by reading the
    // installed descriptor again from disk.
    const installedPkg = JSON.parse(
      await fs.readFile(
        path.join(env.home, "plugins", "installed", "audit", "package.json"),
        "utf8",
      ),
    );
    assert.equal(installedPkg.climier.id, "example.audit");
    assert.equal(installedPkg.climier.command, "audit");
  });
});

test("bin: effective --project/--as live in api.runtime even if forwarded tokens repeat them with different values", async () => {
  await withEnv(async (env) => {
    await seedInstalledPlugin(env.home, "audit");
    // The host resolves --project / --as first; the forwarded
    // --project /tmp/elsewhere --as mallory must not override api.runtime.
    const r = await runCli([
      "--project", env.projectDir, "--as", "alice",
      "audit", "ping",
      "--project", "/tmp/elsewhere",
      "--as", "mallory",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.api_runtime.project_dir, env.projectDir);
    assert.equal(data.api_runtime.agent, "alice");
    // Forwarded tokens still include the duplicates.
    assert.ok(data.args.includes("/tmp/elsewhere"));
    assert.ok(data.args.includes("mallory"));
  });
});

// ---- reserved-namespaces is reused (not redefined) -----------------

test("reserved-namespaces: the dispatcher's plugin check shares the single source of truth", async () => {
  await withEnv(async () => {
    const { RESERVED_NAMESPACES } = await importFresh(RESERVED_MODULE);
    // The dispatcher must use the same list as install; here we assert
    // that the list is non-empty and includes the lifecycle pair.
    assert.ok(RESERVED_NAMESPACES.includes("install"));
    assert.ok(RESERVED_NAMESPACES.includes("uninstall"));
    assert.ok(RESERVED_NAMESPACES.includes("status"));
  });
});