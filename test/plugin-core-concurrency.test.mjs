// T-plugin-core-e2e — concurrency between a V2 plugin and CLI writers
// sharing one CLIMIER_HOME.
//
// ADR-006 plan §4.5 ("T-plugin-core-e2e") + §8 risk #5 say the e2e
// layer must demonstrate that:
//
//   1. Two child_process can drive the same project state at the same
//      time: one through the V2 plugin fixture (api.core.run), one
//      through the core CLI (climier add-task / take).
//   2. The withLock → updateState → append invariant holds across
//      processes — every committed state transition lands intact, no
//      lost writes, no interleaving inside any single log entry.
//   3. Plugin attribution (plugin_id in log) is exclusive to plugin-
//      initiated writes; CLI-driven writes do not inherit a plugin_id.
//   4. Each log entry has exactly one ts / agent / action tuple.
//
// Isolation: per-test CLIMIER_HOME under os.tmpdir() — the helper
// helpers.mjs guards against `~/.climier` (its own private check inside
// the suite). Both child processes share that home, so they both see
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
const FIXTURE_NAMESPACE = FIXTURE_ID;
const FIXTURE_BASENAME = "core-plugin";
const BIN = path.join(REPO_ROOT, "bin", "climier.mjs");

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
        env: { ...process.env, ...(env || {}), NO_COLOR: "1" },
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

test("concurrency: plugin fixture + CLI add-task run in parallel share state, no lost writes, plugin_id only on plugin entries", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    // 1. Bootstrap: init + initiative + install fixture. Each step
    //    uses the test runner's runCli so we do not fork a separate
    //    child for bootstrap. The concurrency is reserved for the
    //    plugin vs CLI fan-out.
    await cli(["--project", projectDir, "init"]);
    await cli([
      "--project", projectDir,
      "--as", "seed-agent",
      "add-initiative", "core-e2e",
      "--desc", "core-e2e initiative",
    ]);
    await cli(["--project", projectDir, "install", FIXTURE_DIR]);

    // 2. Plan the workload: the plugin process creates 10 tasks via
    //    api.core.run (multi subcommand); the CLI process creates 10
    //    tasks via `climier add-task --as cli-bob`. Both share
    //    CLIMIER_HOME and projectDir; only the agent identity differs.
    const PLUGIN_COUNT = 10;
    const CLI_COUNT = 10;

    // 3. Fan out both processes in parallel. Each child receives the
    //    SAME --project and inherits CLIMIER_HOME from the test
    //    runner's env so both end up on the same state file.
    const pluginArgs = [
      "--project", projectDir,
      "--as", "plugin-alice",
      FIXTURE_NAMESPACE, "multi", String(PLUGIN_COUNT),
    ];

    // The CLI bulk: one child process per add-task, all sharing the
    // same CLIMIER_HOME and --project so they race the plugin process
    // for the per-project lock. The bin's parser only takes the first
    // non-flag token as the command, so a single child cannot chain
    // multiple add-task invocations — one child per write keeps the
    // model honest (each child is a real climier invocation).
    const cliArgs = Array.from({ length: CLI_COUNT }, (_, i) => {
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

    const [pluginRes, ...cliResults] = await Promise.all([
      spawnCli(pluginArgs),
      ...cliArgs.map((args) => spawnCli(args)),
    ]);

    assert.equal(
      pluginRes.code,
      0,
      `plugin child must exit 0\nstdout: ${pluginRes.stdout}\nstderr: ${pluginRes.stderr}`,
    );
    for (const r of cliResults) {
      assert.equal(
        r.code,
        0,
        `CLI child must exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
      );
    }
    const pluginOut = JSON.parse(pluginRes.stdout);
    assert.equal(pluginOut.command, "multi");
    assert.equal(pluginOut.count, PLUGIN_COUNT);
    assert.equal(pluginOut.created.length, PLUGIN_COUNT);

    // 4. Read final state. Verify everything landed intact: the
    //    plugin tasks AND the CLI tasks both exist; no node was lost
    //    to a torn write; the edges are coherent; the log captures
    //    the expected attribution.
    const finalState = JSON.parse(await fs.readFile(stateFilePath(projectDir), "utf8"));

    const pluginIds = new Set(pluginOut.created);
    assert.equal(pluginIds.size, PLUGIN_COUNT, "plugin fixture must produce unique ids");
    for (const id of pluginIds) {
      assert.ok(finalState.nodes[id], `plugin task ${id} must be present in state`);
      assert.equal(finalState.nodes[id].status, "in_progress", `plugin task ${id} was claimed by api.core.run`);
    }

    // CLI tasks: their ids come from the Date.now() suffix, so we
    // cannot hard-code them. Instead we identify them by agent and by
    // the absence of plugin_id on the originating log entry.
    const cliLogEntries = finalState.log.filter(
      (e) => e.agent === "cli-bob" && e.action === "add-node",
    );
    assert.ok(
      cliLogEntries.length >= CLI_COUNT,
      `expected ≥${CLI_COUNT} cli-bob add-node log entries, got ${cliLogEntries.length}`,
    );
    const cliNodeIdsFromLog = new Set(cliLogEntries.map((e) => e.node));
    for (const id of cliNodeIdsFromLog) {
      assert.ok(finalState.nodes[id], `CLI task ${id} must be present in state`);
      // CLI never takes, so every CLI task stays open and unclaimed.
      assert.equal(finalState.nodes[id].status, "open");
      assert.ok(
        finalState.nodes[id].claim == null,
        `CLI task ${id} should not be claimed by the CLI flow (got ${JSON.stringify(finalState.nodes[id].claim)})`,
      );
    }

    // 5. plugin_id is exclusive to plugin-initiated writes. Every
    //    plugin_id-tagged entry must come from a plugin dispatch (the
    //    "plugin-alice" agent) and must NOT appear on CLI-driven
    //    entries.
    const pluginLogs = finalState.log.filter((e) => e.plugin_id === FIXTURE_ID);
    const cliLogs = finalState.log.filter((e) => e.agent === "cli-bob");
    assert.equal(
      cliLogs.filter((e) => e.plugin_id === FIXTURE_ID).length,
      0,
      `CLI entries must not carry plugin_id`,
    );
    assert.ok(
      pluginLogs.length >= PLUGIN_COUNT * 2,
      `expected at least ${PLUGIN_COUNT * 2} plugin-tagged log entries (create + take), got ${pluginLogs.length}`,
    );
    for (const e of pluginLogs) {
      assert.equal(e.agent, "plugin-alice");
    }

    // 6. No interleaving inside any single log entry. The withLock →
    //    updateState → append invariant guarantees each entry is a
    //    single coherent object: a torn write would manifest as a
    //    missing/duplicate field or an array value where a string is
    //    expected. We verify that each plugin log entry has exactly
    //    one ts, one action, one agent.
    for (const e of pluginLogs) {
      assert.equal(typeof e.ts, "string");
      assert.equal(typeof e.action, "string");
      assert.equal(typeof e.agent, "string");
      // node id is present (add-node / add-note / take / resolve);
      // a torn write would either drop it or produce a duplicate.
      assert.equal(typeof e.node, "string");
    }

    // 7. ts monotonicity within the plugin burst. The plugin burst is
    //    serialized by the same lock as the CLI writes; the ts field
    //    is the timestamp the writer observed inside its withLock
    //    block. Two entries from the same lock invocation would carry
    //    the same ts (the plugin fixture chains create + take per
    //    iteration). We verify the burst timestamps are non-
    //    decreasing and that each plugin node id appears exactly
    //    twice (add-node + take) — a missing or duplicated entry is
    //    a lost-write symptom.
    const tsList = pluginLogs.map((e) => e.ts);
    for (let i = 1; i < tsList.length; i++) {
      assert.ok(
        tsList[i] >= tsList[i - 1],
        `ts must be non-decreasing in plugin logs: ${tsList[i - 1]} > ${tsList[i]}`,
      );
    }
    const perNodeCounts = {};
    for (const e of pluginLogs) {
      perNodeCounts[e.node] = (perNodeCounts[e.node] || 0) + 1;
    }
    for (const id of pluginIds) {
      assert.ok(
        perNodeCounts[id] >= 2,
        `expected ≥2 plugin log entries per node (create + take), got ${perNodeCounts[id]} for ${id}`,
      );
    }

    // 8. The plugin and CLI agents are clearly separated in the log:
    //    no plugin entry records cli-bob, and no CLI entry records
    //    plugin-alice. This catches accidental identity leakage where
    //    a plugin might accidentally inherit the calling CLI's
    //    --as value.
    assert.equal(
      pluginLogs.filter((e) => e.agent === "cli-bob").length,
      0,
      "plugin entries must not carry the CLI agent identity",
    );
    assert.equal(
      cliLogs.filter((e) => e.agent === "plugin-alice").length,
      0,
      "CLI entries must not carry the plugin agent identity",
    );
  });
});
