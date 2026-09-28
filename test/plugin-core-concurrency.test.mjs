
// sharing one CLIMIER_HOME.
//

// layer must demonstrate that:
//
//   1. Two child_process can drive the same project state at the same
//      time: one through the V2 plugin fixture (api.core.run), one

//   2. The withLock → updateState → append invariant holds across
//      processes — every committed state transition lands intact, no
//      lost writes, no interleaving inside any single log entry.
//   3. Plugin attribution (plugin_id in log) is exclusive to plugin-
//      initiated writes; CLI-driven writes do not inherit a plugin_id.
//   4. Each log entry has exactly one ts / agent / action tuple.
//
// Isolation: per-test CLIMIER_HOME under os.tmpdir() — the helper
// helpers.mjs guards against `~/.climier` (its own private check inside

// the same installed fixture and the same project state file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  createTempProject,
  rmTempProject,
  runCli,
  stateFilePath,
} from "./helpers.mjs";

const REPO_ROOT = path.resolve(".");
const FIXTURE_DIR = path.join(REPO_ROOT, "test/fixtures/core-plugin");
const FIXTURE_ID = "example.core";

// installed dir name = descriptor.command, uninstall arg = descriptor.id.
const FIXTURE_NAMESPACE = "core";
const BIN = path.join(REPO_ROOT, "bin", "climier.mjs");
const PLUGIN_COUNT = 10;
const CLI_COUNT = 10;

// ---- Per-test environment -------------------------------------------

async function withFreshEnv(body) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-core-conc-"));
  const projectDir = await createTempProject();
  const prev = {
    CLIMIER_HOME: process.env.CLIMIER_HOME,
    CLIMIER_AGENT: process.env.CLIMIER_AGENT,
  };
  process.env.CLIMIER_HOME = home;
  delete process.env.CLIMIER_AGENT;
  try {
    return await body({ home, projectDir });
  } finally {
    if (prev.CLIMIER_HOME === undefined) {
      delete process.env.CLIMIER_HOME;
    }
    else {
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
  if (!result.stdout.trim()) {return null;}
  return JSON.parse(result.stdout);
}

// spawnCli — fork a real bin child_process with the SAME CLIMIER_HOME
// and --project as the calling test. Returns { stdout, stderr, code }
// once the child exits. Errors here are propagated loudly because any
// failure in either child is a regression for the contract.
function spawnCli(args, { env } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let proc;
    try {
      proc = spawn("node", [BIN, ...args], {
        env: { ...process.env, ...env, NO_COLOR: "1" },
      });
    } catch (err) {
      reject(err);
      return;
    }
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

// ---- Concurrency contract ------------------------------------------

async function setupConcurrencyProject(projectDir) {
  await cli(["--project", projectDir, "init"]);
  await cli([
    "--project", projectDir,
    "--as", "seed-agent",
    "add-initiative", "core-e2e",
    "--desc", "core-e2e initiative",
  ]);
  await cli([
    "--project", projectDir,
    "--as", "seed-agent",
    "add-task", "T-concurrency-fixture",
    "--initiative", "core-e2e",
    "--title", "seed",
    "--body", "seed",
    "--acceptance", "seed",
    "--blocked-by", "",
  ]);
  await cli(["--project", projectDir, "install", FIXTURE_DIR]);
}

function makeCliArgs(projectDir) {
  return Array.from({ length: CLI_COUNT }, (_, i) => {
    const id = `T-cli-${i}-${Date.now().toString(36)}`;
    return [
      "--project", projectDir,
      "--as", "cli-bob",
      "add-task", id,
      "--initiative", "core-e2e",
      "--title", `cli ${i}`,
      "--body", "b",
      "--acceptance", "a",
      "--blocked-by", "",
    ];
  });
}

async function runConcurrentWriters(projectDir) {
  const pluginArgs = [
    "--project", projectDir,
    "--as", "plugin-alice",
    FIXTURE_NAMESPACE, "multi", String(PLUGIN_COUNT),
  ];
  return Promise.all([
    spawnCli(pluginArgs),
    ...makeCliArgs(projectDir).map((args) => spawnCli(args)),
  ]);
}

function assertSuccessfulWriters(pluginRes, cliResults) {
  assert.equal(
    pluginRes.code,
    0,
    `plugin child must exit 0\nstdout: ${pluginRes.stdout}\nstderr: ${pluginRes.stderr}`,
  );
  for (const result of cliResults) {
    assert.equal(
      result.code,
      0,
      `CLI child must exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  const pluginOut = JSON.parse(pluginRes.stdout);
  assert.equal(pluginOut.command, "multi");
  assert.equal(pluginOut.count, PLUGIN_COUNT);
  assert.equal(pluginOut.created.length, PLUGIN_COUNT);
  return pluginOut;
}

function assertPluginNodes(finalState, pluginIds) {
  assert.equal(pluginIds.size, PLUGIN_COUNT, "plugin fixture must produce unique ids");
  for (const id of pluginIds) {
    assert.ok(finalState.nodes[id], `plugin task ${id} must be present in state`);
    assert.equal(finalState.nodes[id].status, "in_progress", `plugin task ${id} was claimed by api.core.run`);
  }
}

function assertCliNodes(finalState, cliLogEntries, cliLogs) {
  assert.ok(
    cliLogEntries.length >= CLI_COUNT,
    `expected ≥${CLI_COUNT} cli-bob add-task log entries, got ${cliLogEntries.length}`,
  );
  assert.equal(
    cliLogs.filter((entry) => entry.action === "add-task").length,
    CLI_COUNT,
    "exactly one CLI task log exists per concurrent CLI writer",
  );
  const ids = new Set(cliLogEntries.map((entry) => entry.node));
  for (const id of ids) {
    assert.ok(finalState.nodes[id], `CLI task ${id} must be present in state`);
    assert.equal(finalState.nodes[id].status, "open");
    assert.ok(
      finalState.nodes[id].claim === null || finalState.nodes[id].claim === undefined,
      `CLI task ${id} should not be claimed by the CLI flow (got ${JSON.stringify(finalState.nodes[id].claim)})`,
    );
  }
}

function assertPluginLogEntries(pluginLogs) {
  assert.ok(
    pluginLogs.length >= PLUGIN_COUNT * 2,
    `expected at least ${PLUGIN_COUNT * 2} plugin-tagged log entries (create + take), got ${pluginLogs.length}`,
  );
  assert.equal(
    pluginLogs.length,
    PLUGIN_COUNT * 2,
    "each plugin task records one create and one take entry",
  );
  for (const entry of pluginLogs) {
    assert.equal(entry.agent, "plugin-alice");
    assert.equal(typeof entry.ts, "string");
    assert.equal(typeof entry.action, "string");
    assert.equal(typeof entry.node, "string");
  }
}

function assertPluginLogOrder(pluginLogs, pluginIds) {
  const timestamps = pluginLogs.map((entry) => entry.ts);
  for (let index = 1; index < timestamps.length; index++) {
    assert.ok(
      timestamps[index] >= timestamps[index - 1],
      `ts must be non-decreasing in plugin logs: ${timestamps[index - 1]} > ${timestamps[index]}`,
    );
  }
  const perNodeCounts = {};
  for (const entry of pluginLogs) {
    perNodeCounts[entry.node] = (perNodeCounts[entry.node] ?? 0) + 1;
  }
  for (const id of pluginIds) {
    assert.ok(
      perNodeCounts[id] >= 2,
      `expected ≥2 plugin log entries per node (create + take), got ${perNodeCounts[id]} for ${id}`,
    );
    assert.equal(perNodeCounts[id], 2, `plugin task ${id} has exactly one create and take log`);
  }
}

function assertLogAttribution(pluginLogs, cliLogs) {
  assert.equal(
    cliLogs.filter((entry) => entry.plugin_id === FIXTURE_ID).length,
    0,
    "CLI entries must not carry plugin_id",
  );
  assert.equal(
    pluginLogs.filter((entry) => entry.agent === "cli-bob").length,
    0,
    "plugin entries must not carry the CLI agent identity",
  );
  assert.equal(
    cliLogs.filter((entry) => entry.agent === "plugin-alice").length,
    0,
    "CLI entries must not carry the plugin agent identity",
  );
  assert.equal(
    cliLogs.filter((entry) => entry.action === "add-task").length,
    CLI_COUNT,
    "all CLI writers committed their add-task log entries",
  );
  assert.equal(
    pluginLogs.filter((entry) => entry.agent === "plugin-alice").length,
    pluginLogs.length,
    "every plugin-attributed entry belongs to its dispatch agent",
  );
}

async function runConcurrency({ projectDir }) {
  await setupConcurrencyProject(projectDir);
  const [pluginResult, ...cliResults] = await runConcurrentWriters(projectDir);
  const pluginOut = assertSuccessfulWriters(pluginResult, cliResults);
  const finalState = JSON.parse(await fs.readFile(stateFilePath(projectDir), "utf8"));
  const pluginIds = new Set(pluginOut.created);
  assertPluginNodes(finalState, pluginIds);
  const cliLogs = finalState.log.filter((entry) => entry.agent === "cli-bob");
  const cliLogEntries = cliLogs.filter((entry) => entry.action === "add-task");
  assertCliNodes(finalState, cliLogEntries, cliLogs);
  const pluginLogs = finalState.log.filter((entry) => entry.plugin_id === FIXTURE_ID);
  assertPluginLogEntries(pluginLogs);
  assertPluginLogOrder(pluginLogs, pluginIds);
  assertLogAttribution(pluginLogs, cliLogs);
}

test("concurrency: plugin fixture + CLI add-task run in parallel share state, no lost writes, plugin_id only on plugin entries", () => withFreshEnv(runConcurrency));
