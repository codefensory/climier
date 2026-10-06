
//
// ADR-006 plan §4.5 ("T-plugin-core-e2e — Fixture V2, error smoke y
// child_process con CLIMIER_HOME compartido") defines the scope:
//
//   - test/fixtures/core-plugin/{package.json,climier.mjs} — self-

//     no runtime dependencies, offline-friendly.
//   - test/plugin-core-e2e.test.mjs (this file) — install the fixture
//     from a local path, exercise the happy subcommand against the

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

type LogEntry = {
  action: string;
  agent: string;
  node: string;
  plugin_id?: string;
  ts: string;
};

// installed dir name = descriptor.id; dispatch namespace = descriptor
// .command (the first non-flag token). The bin scans installed/<*> for
// descriptor.command === <first-token> at dispatch time.
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
    if (prev.CLIMIER_HOME === undefined) {
      delete process.env.CLIMIER_HOME;
    } else {
      process.env.CLIMIER_HOME = prev.CLIMIER_HOME;
    }
    if (prev.CLIMIER_AGENT === undefined) {
      delete process.env.CLIMIER_AGENT;
    } else {
      process.env.CLIMIER_AGENT = prev.CLIMIER_AGENT;
    }
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
  if (!result.stdout.trim()) {
    return null;
  }
  return JSON.parse(result.stdout);
}

async function setupPluginProject(projectDir, description?: string) {
  const init = await cli(["--project", projectDir, "init"]);
  assert.equal(init.ok, true);
  const initiativeArgs = [
    "--project", projectDir,
    "--as", "seed-agent",
    "add-initiative", "core-e2e",
  ];
  if (description !== undefined) {
    initiativeArgs.push("--desc", description);
  }
  const registered = await cli(initiativeArgs);
  assert.ok(registered.initiative || registered.node, "add-initiative returned an initiative");
  const installRes = await cli(["--project", projectDir, "install", FIXTURE_DIR]);
  assert.equal(installRes.plugin.id, FIXTURE_ID);
  assert.equal(installRes.plugin.command, FIXTURE_COMMAND);
  assert.equal(installRes.plugin.entry, "./climier.mjs");
  const climierHome = process.env.CLIMIER_HOME;
  assert.ok(climierHome);
  const installedDir = path.join(climierHome, "plugins", "installed", FIXTURE_ID);
  assert.ok((await fs.stat(installedDir)).isDirectory(), "installed/<id> exists");
  const installedPkg = JSON.parse(
    await fs.readFile(
      path.join(installedDir, "node_modules", FIXTURE_BASENAME, "package.json"),
      "utf8",
    ),
  );
  assert.equal(installedPkg.climier.id, FIXTURE_ID);
}

async function captureProjectCounts(projectDir) {
  const state = JSON.parse(await fs.readFile(stateFilePath(projectDir), "utf8"));
  return {
    nodes: Object.keys(state.nodes).length,
    edges: state.edges.length,
    logs: state.log.length,
  };
}

async function assertProjectCountsUnchanged(projectDir, before) {
  const after = JSON.parse(await fs.readFile(stateFilePath(projectDir), "utf8"));
  assert.equal(Object.keys(after.nodes).length, before.nodes, "no nodes added");
  assert.equal(after.edges.length, before.edges, "no edges added");
  assert.equal(after.log.length, before.logs, "no log entries added");
}

function pluginLogEntries(state: { log: LogEntry[] }): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const entry of state.log) {
    if (entry.plugin_id === FIXTURE_ID) {
      entries.push(entry);
    }
  }
  return entries;
}

function actionsFrom(entries: LogEntry[]): Set<string> {
  const actions = new Set<string>();
  for (const entry of entries) {
    actions.add(entry.action);
  }
  return actions;
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
    api: 1,
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
  for (const name of ["happy", "partial", "invalidop", "notfound", "multi", "batch"]) {
    assert.equal(typeof commands[name], "function", `missing command '${name}'`);
  }
});

function assertCreatedTask(result, id) {
  assert.ok(result && result.result && result.diff && result.log_entry);
  assert.equal(result.result.id, id);
  assert.equal(result.diff.created[0].node.id, id);
}

function assertHappyEdge(out) {
  assert.ok(out.edge && out.edge.result && out.edge.diff && out.edge.log_entry);
  assert.equal(out.edge.result.edge.type, "BLOCKS");
  assert.equal(out.edge.result.edge.from, "T-core-happy-1");
  assert.equal(out.edge.result.edge.to, "T-core-happy-2");
  assert.deepEqual(out.edge.diff.added_edges, [out.edge.result.edge]);
}

function assertHappyTake(out) {
  assert.ok(out.taken && out.taken.result && out.taken.diff && out.taken.log_entry);
  assert.equal(out.taken.result.claim.by, "core-agent");
  assert.equal(out.taken.result.freshly_claimed, true);
}

function assertHappySubmitAccept(out) {
  assert.ok(out.submitted && out.submitted.result && out.submitted.diff && out.submitted.log_entry);
  assert.equal(out.submitted.result.status, "submitted");
  assert.equal(out.submitted.result.note, "happy: shipped via core.run");
  assert.ok(out.accepted && out.accepted.result && out.accepted.diff && out.accepted.log_entry);
  assert.equal(out.accepted.result.status, "done");
  assert.equal(out.accepted.result.done_by, "core-agent");
}

function assertHappyLifecycle(out) {
  assertHappyTake(out);
  assertHappySubmitAccept(out);
  assert.ok(out.noted && out.noted.result && out.noted.diff && out.noted.log_entry);
  assert.equal(out.noted.result.notes_count, 1);
}

function assertHappyMutationResults(out) {
  assert.equal(out.command, "happy");
  assertCreatedTask(out.create1, "T-core-happy-1");
  assertCreatedTask(out.create2, "T-core-happy-2");
  assertHappyEdge(out);
  assertHappyLifecycle(out);
}

function assertHappyState(state) {
  assert.equal(state.nodes["T-core-happy-1"].status, "done");
  assert.equal(state.nodes["T-core-happy-2"].status, "open");
  assert.ok(state.edges.find(
    (edge) => edge.from === "T-core-happy-1" && edge.to === "T-core-happy-2" && edge.type === "BLOCKS",
  ), "BLOCKS edge between the two tasks exists");
  const noteOnTwo = (state.nodes["T-core-happy-2"].notes || []).find(
    (note) => note.text === "happy: ctx note via core.run",
  );
  assert.ok(noteOnTwo, "note thread on T-core-happy-2 has the appended note");
  assert.equal(noteOnTwo.agent, "core-agent");
  const pluginLogs = pluginLogEntries(state);
  assert.ok(pluginLogs.length >= 5, `expected at least 5 plugin-tagged log entries, got ${pluginLogs.length}`);
  const seenActions = actionsFrom(pluginLogs);
  for (const action of ["task.create", "edge.add", "task.take", "task.submit", "task.accept", "note.add"]) {
    assert.ok(seenActions.has(action), `expected an action '${action}' in plugin logs`);
  }
  for (const entry of pluginLogs) {
    assert.equal(entry.agent, "core-agent", `plugin log agent must be core-agent: ${JSON.stringify(entry)}`);
    assert.equal(typeof entry.ts, "string", `plugin log missing ts: ${JSON.stringify(entry)}`);
    assert.equal(typeof entry.action, "string", `plugin log missing action: ${JSON.stringify(entry)}`);
    assert.equal(typeof entry.agent, "string", `plugin log missing agent: ${JSON.stringify(entry)}`);
  }
}

async function assertHappyHistory(projectDir) {
  const hist = await cli(["--project", projectDir, "history", "T-core-happy-1"]);
  assert.equal(hist.id, "T-core-happy-1");
  assert.ok(Array.isArray(hist.entries));
  assert.ok(hist.entries.length >= 3, `expected ≥3 history entries, got ${hist.entries.length}`);
  for (const entry of hist.entries) {
    assert.equal(entry.plugin_id, FIXTURE_ID, `history entry missing plugin_id: ${JSON.stringify(entry)}`);
    assert.equal(entry.agent, "core-agent");
  }
}

// ---- E2E: happy path -----------------------------------------------

test("e2e: install + happy — full first slice leaves intact state, plugin_id on every log entry, and history with plugin_id", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await setupPluginProject(projectDir, "Core V2 E2E plugin initiative");
    const out = await cli([
      "--project", projectDir,
      "--as", "core-agent",
      FIXTURE_NAMESPACE, "happy",
    ]);
    assertHappyMutationResults(out);
    const state = JSON.parse(await fs.readFile(stateFilePath(projectDir), "utf8"));
    assertHappyState(state);
    await assertHappyHistory(projectDir);
  });
});

// ---- E2E: PLUGIN_CORE_INVALID_OPERATION smoke -----------------------

test("e2e: invalidop — PLUGIN_CORE_INVALID_OPERATION without mutation", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await setupPluginProject(projectDir);
    const before = await captureProjectCounts(projectDir);
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
    await assertProjectCountsUnchanged(projectDir, before);
  });
});

// ---- E2E: PLUGIN_CORE_ACTION_FAILED with NODE_NOT_FOUND -------------

test("e2e: notfound — PLUGIN_CORE_ACTION_FAILED with cause.code=NODE_NOT_FOUND without mutation", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await setupPluginProject(projectDir);
    const before = await captureProjectCounts(projectDir);
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
    assert.ok(
      out.rejected.details.cause.details && out.rejected.details.cause.details.id === "T-core-bogus-not-found",
      `cause.details.id must be 'T-core-bogus-not-found', got ${JSON.stringify(out.rejected.details.cause.details)}`,
    );
    await assertProjectCountsUnchanged(projectDir, before);
  });
});

// ---- E2E: partial sequence preserves the successful step -----------

function assertBatchResult(out) {
  assert.equal(out.command, "batch");
  assert.equal(out.repair.ok, true);
  assert.equal(out.repair.results.length, 3);
  assert.equal(out.repair.revision_after, out.repair.revision_before + 1);
  assert.equal(out.rollback.code, "PLUGIN_CORE_ACTION_FAILED");
  assert.equal(out.rollback.details.op, "core.batch");
  assert.equal(out.rollback.details.cause.code, "BATCH_OPERATION_FAILED");
  assert.equal(out.rollback.details.cause.details.operation_index, 1);
  assert.equal(out.cas.code, "PLUGIN_CORE_ACTION_FAILED");
  assert.equal(out.cas.details.op, "core.batch");
  assert.equal(out.cas.details.cause.code, "STATE_REVISION_CONFLICT");
}

function assertBatchState(state) {
  assert.ok(state.nodes["T-core-batch-3"], "repair node must be persisted");
  assert.equal(state.nodes["T-core-batch-rollback"], undefined, "failed batch must roll back its create");
  assert.equal(state.nodes["T-core-batch-cas"], undefined, "stale CAS must not create a node");
  assert.deepEqual(state.edges.filter((edge) => edge.from.startsWith("T-core-batch-")), [
    { from: "T-core-batch-1", to: "T-core-batch-3", type: "BLOCKS" },
    { from: "T-core-batch-3", to: "T-core-batch-2", type: "BLOCKS" },
  ]);
  const batchLogs = state.log.filter((entry) => entry.action === "core.batch");
  assert.equal(batchLogs.length, 1, "only the successful repair persists a batch log");
  assert.equal(batchLogs[0].agent, "core-agent");
  assert.equal(batchLogs[0].plugin_id, FIXTURE_ID);
}

test("e2e: batch — fixture demonstrates repair, rollback, and stale CAS through api.core.batch", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await setupPluginProject(projectDir);
    const out = await cli([
      "--project", projectDir,
      "--as", "core-agent",
      FIXTURE_NAMESPACE, "batch",
    ]);
    assertBatchResult(out);
    const state = JSON.parse(await fs.readFile(stateFilePath(projectDir), "utf8"));
    assertBatchState(state);
  });
});

function assertPartialResult(out) {
  assert.equal(out.command, "partial");
  assert.ok(out.create && out.create.result && out.create.diff && out.create.log_entry);
  assert.equal(out.create.result.id, "T-core-partial-1");
  assert.equal(out.create.diff.created[0].node.id, "T-core-partial-1");
  assert.ok(out.rejected, "partial subcommand must surface the rejection");
  assert.equal(out.rejected.code, "PLUGIN_CORE_ACTION_FAILED");
  assert.equal(out.rejected.details.op, "edge.add");
  assert.equal(out.rejected.details.plugin_id, FIXTURE_ID);
  assert.ok(out.rejected.details.cause, "PLUGIN_CORE_ACTION_FAILED carries a structured cause");
  assert.ok(
    ["INVALID_EDGE_TARGET", "NODE_NOT_FOUND"].includes(out.rejected.details.cause.code),
    `unexpected cause.code: ${out.rejected.details.cause.code}`,
  );
}

function assertPartialState(state) {
  assert.ok(state.nodes["T-core-partial-1"], "T-core-partial-1 survives the failed edge.add");
  assert.equal(state.nodes["T-core-partial-1"].status, "open");
  assert.equal(state.edges.length, 0, "no BLOCKS edge added because edge.add failed");
  const logs = pluginLogEntries(state);
  assert.equal(logs.length, 1, `expected exactly 1 plugin log entry, got ${logs.length}`);
  assert.equal(logs[0].action, "task.create");
  assert.equal(logs[0].node, "T-core-partial-1");
}

test("e2e: partial — successful task.create is preserved; subsequent failed edge.add is reported", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await setupPluginProject(projectDir);
    const out = await cli([
      "--project", projectDir,
      "--as", "core-agent",
      FIXTURE_NAMESPACE, "partial",
    ]);
    assertPartialResult(out);
    const state = JSON.parse(await fs.readFile(stateFilePath(projectDir), "utf8"));
    assertPartialState(state);
  });
});
