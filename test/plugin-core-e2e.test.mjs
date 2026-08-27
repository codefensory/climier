// T-plugin-core-e2e — end-to-end smoke for the V2 plugin core surface.
//
// ADR-006 plan §4.5 ("T-plugin-core-e2e — Fixture V2, error smoke y
// child_process con CLIMIER_HOME compartido") defines the scope:
//
//   - test/fixtures/core-plugin/{package.json,climier.mjs} — self-
//     contained V2 plugin, climier.id="example.core", command="core",
//     no runtime dependencies, offline-friendly.
//   - test/plugin-core-e2e.test.mjs (this file) — install the fixture
//     from a local path, exercise the happy subcommand against the
//     real core handlers, and verify envelopes, state, history with
//     plugin_id, PLUGIN_CORE_INVALID_OPERATION, PLUGIN_CORE_ACTION_FAILED
//     with cause.code=NODE_NOT_FOUND, and partial sequences.
//   - test/plugin-core-concurrency.test.mjs — child_process fan-out
//     with a shared CLIMIER_HOME (see §3 there).
//
// All mutations run through helpers.mjs (auto-managed CLIMIER_HOME under
// os.tmpdir()). Each test installs a fresh fixture from the local path;
// nothing touches the real ~/.climier tree.

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

const FIXTURE_DIR = path.resolve("test/fixtures/core-plugin");
const FIXTURE_ID = "example.core";
const FIXTURE_COMMAND = "core";
const FIXTURE_BASENAME = "core-plugin";
// Dispatch namespace: the bin routes `climier <namespace> <sub>` through
// plugin-dispatch when the installed dir matches the namespace. T-plugin-
// command-namespace: the namespace / installed dir name is descriptor
// .command, NOT descriptor.id. The CLI invokes the plugin by command; the
// descriptor.id stays as the plugin identity for data, logs, and uninstall.
const FIXTURE_NAMESPACE = FIXTURE_COMMAND;

// ---- Per-test environment wrapper ----------------------------------

async function withFreshEnv(body) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-core-e2e-"));
  const projectDir = await createTempProject();
  const prev = {
    CLIMIER_HOME: process.env.CLIMIER_HOME,
    CLIMIER_AGENT: process.env.CLIMIER_AGENT,
  };
  process.env.CLIMIER_HOME = home;
  // Force every dispatch to pass --as explicitly so the agent identity
  // is reproducible across the plugin and CLI paths.
  delete process.env.CLIMIER_AGENT;
  try {
    return await body({ home, projectDir });
  } finally {
    if (prev.CLIMIER_HOME === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = prev.CLIMIER_HOME;
    if (prev.CLIMIER_AGENT === undefined) process.env.CLIMIER_AGENT = prev.CLIMIER_AGENT;
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

// cliExpectFailure: runs `climier` and expects a non-zero exit. Returns
// the parsed stdout JSON. Use this for error smokes that always fail
// (e.g. PLUGIN_CORE_INVALID_OPERATION surfaces as exit 1).
async function cliExpectFailure(args) {
  const result = await runCli(args);
  assert.notEqual(result.code, 0, `expected non-zero exit for ${JSON.stringify(args)}`);
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `could not parse stdout for ${JSON.stringify(args)}: ${result.stdout}\n${result.stderr}`,
    );
  }
}

// ---- Fixture contract (mirrors plugin-integration.test.mjs) -------

test("fixture: package.json declares descriptor, type module, and no runtime dependencies", async () => {
  const pkgRaw = await fs.readFile(path.join(FIXTURE_DIR, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw);
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.climier, {
    id: FIXTURE_ID,
    command: FIXTURE_COMMAND,
    entry: "./climier.mjs",
  });
  // ADR-006 plan §8 risk #4: the fixture must NOT declare any runtime
  // dependency so `npm install --prefix staging ./core-plugin` works
  // offline and never reaches the registry.
  for (const depKey of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    assert.ok(!(depKey in pkg), `fixture package.json must not declare ${depKey}`);
  }
});

test("fixture: climier.mjs default export exposes one dedicated command per e2e scenario", async () => {
  const mod = await import(path.join(FIXTURE_DIR, "climier.mjs"));
  assert.ok(mod && typeof mod.default === "object" && mod.default !== null);
  const commands = mod.default.commands;
  assert.ok(commands && typeof commands === "object" && !Array.isArray(commands));
  for (const name of ["happy", "partial", "invalidop", "notfound", "multi"]) {
    assert.equal(typeof commands[name], "function", `missing command '${name}'`);
  }
});

// ---- E2E: happy path -----------------------------------------------

test("e2e: install + happy — full first slice leaves intact state, plugin_id on every log entry, and history with plugin_id", async () => {
  await withFreshEnv(async ({ home, projectDir }) => {
    // T-plugin-command-namespace: installed dir name is descriptor.command.
    const installedDir = path.join(home, "plugins", "installed", FIXTURE_COMMAND);

    // 1. Initialize the project so plugin handlers can read/write state.
    const init = await cli(["--project", projectDir, "init"]);
    assert.equal(init.ok, true);

    // 1b. Register the initiative that hosts the seeded tasks.
    const registered = await cli([
      "--project", projectDir,
      "--as", "seed-agent",
      "add-initiative", "core-e2e",
      "--desc", "Core V2 E2E plugin initiative",
    ]);
    assert.ok(registered.initiative || registered.node, "add-initiative returned an initiative");

    // 2. Install the fixture from the local path. npm lays it under
    //    <installed>/<id>/node_modules/<basename>/package.json.
    const installRes = await cli(["--project", projectDir, "install", FIXTURE_DIR]);
    assert.equal(installRes.plugin.id, FIXTURE_ID);
    assert.equal(installRes.plugin.command, FIXTURE_COMMAND);
    assert.equal(installRes.plugin.entry, "./climier.mjs");
    assert.ok((await fs.stat(installedDir)).isDirectory(), "installed/<command> exists");
    const installedPkg = JSON.parse(
      await fs.readFile(
        path.join(installedDir, "node_modules", FIXTURE_BASENAME, "package.json"),
        "utf8",
      ),
    );
    assert.equal(installedPkg.climier.id, FIXTURE_ID);

    // 3. Dispatch the happy subcommand. The plugin is invoked through
    //    the real CLI bin (child process) so plugin-dispatch + core
    //    handlers behave like production.
    const out = await cli([
      "--project", projectDir,
      "--as", "core-agent",
      FIXTURE_NAMESPACE, "happy",
    ]);
    assert.equal(out.command, "happy");
    // Envelopes returned by the handlers — asserted on every shape the
    // first slice produces (ADR-006 plan §4.5 acceptance #1).
    assert.ok(out.create1 && out.create1.node && out.create1.node.id === "T-core-happy-1");
    assert.ok(out.create2 && out.create2.node && out.create2.node.id === "T-core-happy-2");
    assert.ok(out.edge && out.edge.edge && out.edge.edge.type === "BLOCKS");
    assert.equal(out.edge.edge.from, "T-core-happy-1");
    assert.equal(out.edge.edge.to, "T-core-happy-2");
    assert.ok(out.taken && out.taken.node && out.taken.node.claim && out.taken.node.claim.by === "core-agent");
    assert.equal(out.taken.freshly_claimed, true);
    assert.ok(out.resolved && out.resolved.node && out.resolved.node.status === "done");
    assert.equal(out.resolved.node.done_by, "core-agent");
    assert.equal(out.resolved.node.note, "happy: shipped via core.run");
    assert.ok(
      out.noted && out.noted.node &&
        Array.isArray(out.noted.node.notes) &&
        out.noted.node.notes.some((n) => n.text === "happy: ctx note via core.run"),
    );

    // 4. State assertions: both tasks exist with the right status; the
    //    BLOCKS edge is in place; the note thread is appended.
    const state = JSON.parse(await fs.readFile(stateFilePath(projectDir), "utf8"));
    assert.equal(state.nodes["T-core-happy-1"].status, "done");
    assert.equal(state.nodes["T-core-happy-2"].status, "open");
    const blocks = state.edges.find(
      (e) => e.from === "T-core-happy-1" && e.to === "T-core-happy-2" && e.type === "BLOCKS",
    );
    assert.ok(blocks, "BLOCKS edge between the two tasks exists");
    const noteOnTwo = (state.nodes["T-core-happy-2"].notes || []).find(
      (n) => n.text === "happy: ctx note via core.run",
    );
    assert.ok(noteOnTwo, "note thread on T-core-happy-2 has the appended note");
    assert.equal(noteOnTwo.agent, "core-agent");

    // 5. Log entries from plugin-initiated writes must carry plugin_id
    //    and the api.runtime.agent identity ("core-agent"). The handlers
    //    run inside withLock → updateState → appendWithContext, so a
    //    single ts/agent/action tuple lands per call.
    const pluginLogs = state.log.filter((e) => e.plugin_id === FIXTURE_ID);
    assert.ok(
      pluginLogs.length >= 5,
      `expected at least 5 plugin-tagged log entries, got ${pluginLogs.length}`,
    );
    const seenActions = new Set(pluginLogs.map((e) => e.action));
    for (const a of ["add-node", "add-edge", "take", "resolve", "add-note"]) {
      assert.ok(seenActions.has(a), `expected an action '${a}' in plugin logs`);
    }
    for (const e of pluginLogs) {
      assert.equal(e.agent, "core-agent", `plugin log agent must be core-agent: ${JSON.stringify(e)}`);
    }
    // No interleaving: each plugin entry has a single ts and a single
    // action string; a torn write would manifest as duplicate keys or
    // missing fields. The withLock invariant guarantees atomic writes.
    for (const e of pluginLogs) {
      assert.equal(typeof e.ts, "string", `plugin log missing ts: ${JSON.stringify(e)}`);
      assert.equal(typeof e.action, "string", `plugin log missing action: ${JSON.stringify(e)}`);
      assert.equal(typeof e.agent, "string", `plugin log missing agent: ${JSON.stringify(e)}`);
    }

    // 6. history <id> reports plugin_id on every entry that originated
    //    from the plugin. ADR-006 §"Secuencias parciales" says history
    //    identifies plugin_id, agent and action without leaking bodies.
    //    `history` does not accept --as (read-only), so the agent
    //    identity is not part of the flag set here.
    const hist = await cli([
      "--project", projectDir,
      "history", "T-core-happy-1",
    ]);
    assert.equal(hist.id, "T-core-happy-1");
    assert.ok(Array.isArray(hist.entries));
    assert.ok(hist.entries.length >= 3, `expected ≥3 history entries, got ${hist.entries.length}`);
    for (const entry of hist.entries) {
      assert.equal(
        entry.plugin_id,
        FIXTURE_ID,
        `history entry missing plugin_id: ${JSON.stringify(entry)}`,
      );
      assert.equal(entry.agent, "core-agent");
    }
  });
});

// ---- E2E: PLUGIN_CORE_INVALID_OPERATION smoke -----------------------

test("e2e: invalidop — PLUGIN_CORE_INVALID_OPERATION without mutation", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    // Project + initiative are still empty before the invalid-op call.
    const init = await cli(["--project", projectDir, "init"]);
    assert.equal(init.ok, true);
    await cli([
      "--project", projectDir,
      "--as", "seed-agent",
      "add-initiative", "core-e2e",
    ]);
    await cli(["--project", projectDir, "install", FIXTURE_DIR]);

    // Capture state baseline before dispatching the bad op.
    const before = JSON.parse(await fs.readFile(stateFilePath(projectDir), "utf8"));
    const beforeNodes = Object.keys(before.nodes).length;
    const beforeEdges = before.edges.length;
    const beforeLogs = before.log.length;

    // The fixture's invalidop subcommand catches the rejection and
    // returns it as an envelope; the CLI exits 0 because the plugin
    // returned a value (the rejection envelope).
    const out = await cli([
      "--project", projectDir,
      "--as", "core-agent",
      FIXTURE_NAMESPACE, "invalidop",
    ]);
    assert.equal(out.command, "invalidop");
    assert.ok(out.rejected, "fixture must surface the rejection");
    assert.equal(out.rejected.code, "PLUGIN_CORE_INVALID_OPERATION");
    assert.equal(out.rejected.details.op, "edge.unknown");
    assert.equal(out.rejected.details.reason, "unknown operation");
    assert.equal(out.rejected.details.plugin_id, FIXTURE_ID);
    assert.ok(Array.isArray(out.rejected.details.supported));
    assert.ok(out.rejected.details.supported.includes("edge.add"));

    // No mutation: state baseline is unchanged.
    const after = JSON.parse(await fs.readFile(stateFilePath(projectDir), "utf8"));
    assert.equal(Object.keys(after.nodes).length, beforeNodes, "no nodes added");
    assert.equal(after.edges.length, beforeEdges, "no edges added");
    assert.equal(after.log.length, beforeLogs, "no log entries added");
  });
});

// ---- E2E: PLUGIN_CORE_ACTION_FAILED with NODE_NOT_FOUND -------------

test("e2e: notfound — PLUGIN_CORE_ACTION_FAILED with cause.code=NODE_NOT_FOUND without mutation", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    const init = await cli(["--project", projectDir, "init"]);
    assert.equal(init.ok, true);
    await cli([
      "--project", projectDir,
      "--as", "seed-agent",
      "add-initiative", "core-e2e",
    ]);
    await cli(["--project", projectDir, "install", FIXTURE_DIR]);

    const before = JSON.parse(await fs.readFile(stateFilePath(projectDir), "utf8"));
    const beforeNodes = Object.keys(before.nodes).length;
    const beforeEdges = before.edges.length;
    const beforeLogs = before.log.length;

    const out = await cli([
      "--project", projectDir,
      "--as", "core-agent",
      FIXTURE_NAMESPACE, "notfound",
    ]);
    assert.equal(out.command, "notfound");
    assert.ok(out.rejected, "fixture must surface the rejection");
    assert.equal(out.rejected.code, "PLUGIN_CORE_ACTION_FAILED");
    assert.equal(out.rejected.details.op, "task.take");
    assert.equal(out.rejected.details.plugin_id, FIXTURE_ID);
    assert.ok(out.rejected.details.cause, "PLUGIN_CORE_ACTION_FAILED carries a structured cause");
    assert.equal(out.rejected.details.cause.code, "NODE_NOT_FOUND");
    // Sanity: the cause surfaces the bad id so the orchestrator can
    // diagnose without re-reading the state file.
    assert.ok(
      out.rejected.details.cause.details && out.rejected.details.cause.details.id === "T-core-bogus-not-found",
      `cause.details.id must be 'T-core-bogus-not-found', got ${JSON.stringify(out.rejected.details.cause.details)}`,
    );

    // No mutation.
    const after = JSON.parse(await fs.readFile(stateFilePath(projectDir), "utf8"));
    assert.equal(Object.keys(after.nodes).length, beforeNodes, "no nodes added");
    assert.equal(after.edges.length, beforeEdges, "no edges added");
    assert.equal(after.log.length, beforeLogs, "no log entries added");
  });
});

// ---- E2E: partial sequence preserves the successful step -----------

test("e2e: partial — successful task.create is preserved; subsequent failed edge.add is reported", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    const init = await cli(["--project", projectDir, "init"]);
    assert.equal(init.ok, true);
    await cli([
      "--project", projectDir,
      "--as", "seed-agent",
      "add-initiative", "core-e2e",
    ]);
    await cli(["--project", projectDir, "install", FIXTURE_DIR]);

    const out = await cli([
      "--project", projectDir,
      "--as", "core-agent",
      FIXTURE_NAMESPACE, "partial",
    ]);
    assert.equal(out.command, "partial");
    assert.ok(out.create && out.create.node && out.create.node.id === "T-core-partial-1");
    // The plugin returns the rejection envelope captured from the
    // edge.add call; the cause is wrapped by the adapter.
    assert.ok(out.rejected, "partial subcommand must surface the rejection");
    assert.equal(out.rejected.code, "PLUGIN_CORE_ACTION_FAILED");
    assert.equal(out.rejected.details.op, "edge.add");
    assert.equal(out.rejected.details.plugin_id, FIXTURE_ID);
    assert.ok(out.rejected.details.cause, "PLUGIN_CORE_ACTION_FAILED carries a structured cause");
    // add-edge validates both endpoints before mutating, so the cause
    // code is INVALID_EDGE_TARGET (add-edge throws that); the adapter
    // wraps it as PLUGIN_CORE_ACTION_FAILED.
    assert.ok(
      ["INVALID_EDGE_TARGET", "NODE_NOT_FOUND"].includes(out.rejected.details.cause.code),
      `unexpected cause.code: ${out.rejected.details.cause.code}`,
    );

    // The successful task.create is preserved; the failed edge.add
    // did not roll anything back (ADR-006 §"Secuencias parciales").
    const after = JSON.parse(await fs.readFile(stateFilePath(projectDir), "utf8"));
    assert.ok(after.nodes["T-core-partial-1"], "T-core-partial-1 survives the failed edge.add");
    assert.equal(after.nodes["T-core-partial-1"].status, "open");
    // No edge was added because edge.add rejected before any mutation.
    assert.equal(after.edges.length, 0, "no BLOCKS edge added because edge.add failed");
    // Log only reflects the successful task.create (no torn write,
    // no orphan edge entry, no edge.add entry).
    const pluginLogs = after.log.filter((e) => e.plugin_id === FIXTURE_ID);
    assert.equal(pluginLogs.length, 1, `expected exactly 1 plugin log entry, got ${pluginLogs.length}`);
    assert.equal(pluginLogs[0].action, "add-node");
    assert.equal(pluginLogs[0].node, "T-core-partial-1");
  });
});
