// T-plugin-fixture — end-to-end smoke for the V1 plugin host.
//
// What this covers:
//   1. Fixture package.json declares the descriptor (climier.id, command,
//      entry), declares type: "module", and does NOT declare any runtime
//      dependency (ADR-005 + plan §8 risk #6).
//   2. Fixture entrypoint exposes one dedicated subcommand per V1 API
//      method: runtime, query.{node,context,status,history},
//      data.{node,project}.{get,set}.
//   3. The full ADR-005 smoke flow against a real project:
//        install fixture (local path)
//        exercise each V1 method via its dedicated subcommand
//        verify --project/--as forwarded in original order
//        check `plugins[<id>].data` (root) and
//              `nodes[<id>].plugins[<id>].data` (per-node)
//        verify log redaction
//              (action=plugin-data-set, plugin_id, scope, node_id?/key,
//               no `value` field, no secret leakage)
//        uninstall fixture
//        reinstall the same id
//        data persists across uninstall/reinstall
//
// Isolation: per-test temp CLIMIER_HOME under os.tmpdir() + temp project
// dir (mirrors .agents/skills/climier/smoke-sandbox.sh). The bin runs in
// a fresh child process for each runCli call, so plugin dispatch and
// ESM module caching behave like production.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  createTempProject,
  rmTempProject,
  runCli,
  stateFilePath,
} from "./helpers.mjs";

const FIXTURE_DIR = path.resolve("test/fixtures/sample-plugin");
const FIXTURE_ID = "sample";
const FIXTURE_COMMAND = "sample";

// ---- Per-test environment wrapper ------------------------------------

async function withFreshEnv(body, prefix = "climier-integration-test") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix + "-"));
  const projectDir = await createTempProject();
  const prev = {
    CLIMIER_HOME: process.env.CLIMIER_HOME,
    CLIMIER_AGENT: process.env.CLIMIER_AGENT,
  };
  process.env.CLIMIER_HOME = home;
  // Force the test to pass --as explicitly per invocation so the dispatch
  // path's --as/CLIMIER_AGENT resolution is exercised end-to-end.
  delete process.env.CLIMIER_AGENT;
  try {
    return await body({ home, projectDir });
  } finally {
    if (prev.CLIMIER_HOME === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = prev.CLIMIER_HOME;
    if (prev.CLIMIER_AGENT === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prev.CLIMIER_AGENT;
    await fs.rm(home, { recursive: true, force: true });
    await rmTempProject(projectDir);
  }
}

async function cli(args) {
  const result = await runCli(args);
  if (result.code !== 0) {
    throw new Error(
      `climier exited ${result.code}\n` +
        `argv: ${JSON.stringify(args)}\n` +
        `stdout: ${result.stdout}\n` +
        `stderr: ${result.stderr}`,
    );
  }
  if (!result.stdout.trim()) return null;
  return JSON.parse(result.stdout);
}

// ---- Fixture package.json contract ---------------------------------

test("fixture: package.json declares descriptor, type module, and no runtime dependencies", async () => {
  const pkgRaw = await fs.readFile(path.join(FIXTURE_DIR, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw);
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.climier, {
    id: FIXTURE_ID,
    command: FIXTURE_COMMAND,
    entry: "./climier.mjs",
  });
  // ADR-005 + plan §8 risk #6: the fixture must be self-contained so
  // `npm install --prefix staging ./sample-plugin` does not pull
  // anything from the registry and tests stay offline-friendly.
  for (const depKey of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    assert.ok(!(depKey in pkg), `fixture package.json must not declare ${depKey}`);
  }
});

// ---- Fixture entrypoint exports default.commands --------------------

test("fixture: climier.mjs default export exposes one dedicated command per V1 method", async () => {
  const mod = await import(path.join(FIXTURE_DIR, "climier.mjs"));
  assert.ok(mod && typeof mod.default === "object" && mod.default !== null);
  const commands = mod.default.commands;
  assert.ok(commands && typeof commands === "object" && !Array.isArray(commands));
  // One dedicated subcommand per V1 API method (ADR-005 §"API y
  // persistencia"). Each command maps 1:1 to a method on api.*
  const expected = [
    "runtime",
    "query-node",
    "query-context",
    "query-status",
    "query-history",
    "data-node-get",
    "data-node-set",
    "data-project-get",
    "data-project-set",
  ];
  for (const name of expected) {
    assert.ok(typeof commands[name] === "function", `missing command '${name}'`);
  }
});

// ---- End-to-end smoke -----------------------------------------------

test("smoke: install + per-method commands + uninstall + reinstall + data persists; flags forwarded in original order; log redacted", async () => {
  await withFreshEnv(async ({ home, projectDir }) => {
    // T-plugin-command-namespace: installed dir name = descriptor.command.
    const installedDir = path.join(home, "plugins", "installed", FIXTURE_COMMAND);

    // 1. Initialize the project so plugin handlers can read/write state.
    const init = await cli(["--project", projectDir, "init"]);
    assert.equal(init.ok, true);

    // 1b. Register the initiative that hosts the seeded task.
    const registered = await cli([
      "--project", projectDir,
      "--as", "seed-agent",
      "add-initiative", "plugin-platform",
      "--desc", "Plugin platform V1 host",
    ]);
    assert.ok(registered.initiative || registered.node, "add-initiative returned an initiative");

    // 2. Seed a task so data.node.* has a real target. add-task requires
    //    --blocked-by; "" is the documented "no blockers" escape hatch.
    const added = await cli([
      "--project", projectDir,
      "--as", "seed-agent",
      "add-task", "T-fixture-target",
      "--initiative", "plugin-platform",
      "--title", "Fixture target node",
      "--body", "Smoke target for data.node set/get.",
      "--acceptance", "data round-trip succeeds.",
      "--blocked-by", "",
    ]);
    const seededNode = added.task || added.node;
    assert.ok(seededNode, "add-task returned a node envelope");
    assert.equal(seededNode.id, "T-fixture-target");

    // 3. Install the fixture from the local path.
    const installRes = await cli(["--project", projectDir, "install", FIXTURE_DIR]);
    assert.equal(installRes.plugin.id, FIXTURE_ID);
    assert.equal(installRes.plugin.command, FIXTURE_COMMAND);
    assert.equal(installRes.plugin.entry, "./climier.mjs");
    assert.ok((await fs.stat(installedDir)).isDirectory(), "installed/<command> exists");
    // npm puts the package under node_modules/<basename>/package.json.
    const installedPkg = JSON.parse(
      await fs.readFile(
        path.join(installedDir, "node_modules", "sample-plugin", "package.json"),
        "utf8",
      ),
    );
    assert.equal(installedPkg.climier.id, FIXTURE_ID);

    // 4. runtime: --as placed BEFORE --project to assert order-
    //    independence. The host resolves them from originalArgv
    //    (first-wins), so api.runtime carries the effective values
    //    regardless of position, and the forwarded argv preserves the
    //    original token order with the namespace + subcommand stripped.
    const runtime = await cli([
      "--as", "fixture-agent",
      "--project", projectDir,
      FIXTURE_COMMAND, "runtime",
      "--trailing-flag", "trailing-value",
    ]);
    assert.equal(runtime.command, "runtime");
    assert.equal(runtime.runtime.agent, "fixture-agent");
    assert.equal(
      path.resolve(runtime.runtime.project_dir),
      path.resolve(projectDir),
    );
    assert.deepEqual(runtime.forwarded_args, [
      "--as", "fixture-agent",
      "--project", projectDir,
      "--trailing-flag", "trailing-value",
    ]);

    // 5. query.node
    const qn = await cli([
      "--project", projectDir, "--as", "fixture-agent",
      FIXTURE_COMMAND, "query-node", "T-fixture-target",
    ]);
    assert.equal(qn.command, "query-node");
    assert.equal(qn.id, "T-fixture-target");
    // api.query.node returns the { type, node } envelope produced by
    // `climier show`; the fixture forwards it verbatim.
    assert.equal(qn.node.type, "task");
    assert.equal(qn.node.node.id, "T-fixture-target");

    // 6. query.context: allowed_actions is scoped to api.runtime.agent
    //    (the host passes --as=runtime.agent to context); the array
    //    shape is enough — the test does not pin agent-specific actions.
    const qc = await cli([
      "--project", projectDir, "--as", "fixture-agent",
      FIXTURE_COMMAND, "query-context", "T-fixture-target",
    ]);
    assert.equal(qc.command, "query-context");
    assert.ok(Array.isArray(qc.allowed_actions));

    // 7. query.status
    const qs = await cli([
      "--project", projectDir, "--as", "fixture-agent",
      FIXTURE_COMMAND, "query-status",
    ]);
    assert.equal(qs.command, "query-status");
    assert.ok(qs.summary && typeof qs.summary === "object");

    // 8. query.history
    const qh = await cli([
      "--project", projectDir, "--as", "fixture-agent",
      FIXTURE_COMMAND, "query-history", "T-fixture-target",
    ]);
    assert.equal(qh.command, "query-history");
    assert.equal(qh.id, "T-fixture-target");
    assert.ok(Array.isArray(qh.entries));

    // 9. data.node.set then data.node.get
    const nodeSecret = "ULTRA-SECRET-NODE-DO-NOT-LOG";
    const nodeValue = { secret: nodeSecret, tag: "node-1", count: 7 };
    await cli([
      "--project", projectDir, "--as", "fixture-agent",
      FIXTURE_COMMAND, "data-node-set",
      "T-fixture-target",
      JSON.stringify(nodeValue),
    ]);
    const dng = await cli([
      "--project", projectDir, "--as", "fixture-agent",
      FIXTURE_COMMAND, "data-node-get", "T-fixture-target",
    ]);
    assert.equal(dng.command, "data-node-get");
    assert.deepEqual(dng.data, nodeValue);

    // 10. data.project.set then data.project.get
    const projectSecret = "PROJECT-SECRET-DO-NOT-LOG";
    await cli([
      "--project", projectDir, "--as", "fixture-agent",
      FIXTURE_COMMAND, "data-project-set", "greeting",
      JSON.stringify(projectSecret),
    ]);
    const dpg = await cli([
      "--project", projectDir, "--as", "fixture-agent",
      FIXTURE_COMMAND, "data-project-get", "greeting",
    ]);
    assert.equal(dpg.command, "data-project-get");
    assert.equal(dpg.data, projectSecret);

    // 11. Persisted shape: root `plugins[<id>].data` AND
    //     `nodes[<id>].plugins[<id>].data` are both populated.
    const state = JSON.parse(await fs.readFile(stateFilePath(projectDir), "utf8"));
    assert.ok(state.plugins && state.plugins[FIXTURE_ID], "root plugins[sample.plugin] exists");
    assert.deepEqual(state.plugins[FIXTURE_ID].data, { greeting: projectSecret });
    assert.ok(
      state.nodes["T-fixture-target"].plugins &&
        state.nodes["T-fixture-target"].plugins[FIXTURE_ID],
      "node.plugins[sample.plugin] exists",
    );
    assert.deepEqual(
      state.nodes["T-fixture-target"].plugins[FIXTURE_ID].data,
      nodeValue,
    );

    // 12. Log redaction: every plugin-data-set entry carries
    //     plugin_id/scope/agent without the value. No `value` field, and
    //     the secret strings must not appear anywhere in the serialized
    //     entry (so an attacker tailing the log cannot recover them).
    const pluginDataLogs = (state.log || []).filter((e) => e.action === "plugin-data-set");
    assert.equal(
      pluginDataLogs.length,
      2,
      "expected exactly two plugin-data-set entries (node + project)",
    );
    for (const entry of pluginDataLogs) {
      assert.equal(entry.plugin_id, FIXTURE_ID);
      assert.ok(entry.scope === "node" || entry.scope === "project");
      assert.ok(!("value" in entry), "log entry must not contain a `value` field");
      const serialized = JSON.stringify(entry);
      assert.ok(
        !serialized.includes(nodeSecret),
        `log entry leaked node secret: ${serialized}`,
      );
      assert.ok(
        !serialized.includes(projectSecret),
        `log entry leaked project secret: ${serialized}`,
      );
    }
    // Shape: node entry carries node_id (no usable key — plugin-data.mjs
    // sets key: null to keep the envelope shape stable); project entry
    // carries key (no node_id).
    const nodeEntry = pluginDataLogs.find((e) => e.scope === "node");
    const projectEntry = pluginDataLogs.find((e) => e.scope === "project");
    assert.ok(nodeEntry && nodeEntry.node_id === "T-fixture-target");
    assert.ok(
      nodeEntry.key === null || nodeEntry.key === undefined,
      "node-scoped log entry must not carry a usable `key`",
    );
    assert.ok(projectEntry && projectEntry.key === "greeting");
    assert.ok(
      projectEntry.node_id === undefined || projectEntry.node_id === null,
      "project-scoped log entry must not carry `node_id`",
    );

    // 13. Uninstall: removes installed/<command> but does NOT purge data
    //     (ADR-005 §"Instalación e identidad": `uninstall <id>` elimina
    //     ese directorio y no purga datos de proyectos).
    const uninstallRes = await cli([
      "--project", projectDir, "uninstall", FIXTURE_ID,
    ]);
    assert.equal(uninstallRes.plugin.id, FIXTURE_ID);
    assert.equal(uninstallRes.plugin.uninstalled, true);
    await assert.rejects(fs.access(installedDir));
    const stateAfterUninstall = JSON.parse(
      await fs.readFile(stateFilePath(projectDir), "utf8"),
    );
    assert.ok(stateAfterUninstall.plugins[FIXTURE_ID]);
    assert.ok(stateAfterUninstall.nodes["T-fixture-target"].plugins[FIXTURE_ID]);

    // 14. Reinstall: data is still readable through the new install.
    const reinstall = await cli(["--project", projectDir, "install", FIXTURE_DIR]);
    assert.equal(reinstall.plugin.id, FIXTURE_ID);
    assert.ok((await fs.stat(installedDir)).isDirectory());

    const persistedNode = await cli([
      "--project", projectDir, "--as", "fixture-agent",
      FIXTURE_COMMAND, "data-node-get", "T-fixture-target",
    ]);
    assert.deepEqual(persistedNode.data, nodeValue);
    const persistedProject = await cli([
      "--project", projectDir, "--as", "fixture-agent",
      FIXTURE_COMMAND, "data-project-get", "greeting",
    ]);
    assert.equal(persistedProject.data, projectSecret);
  });
});
