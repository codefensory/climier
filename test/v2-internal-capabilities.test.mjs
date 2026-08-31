// T-plugin-policy-migration-tests — ADR-008 §"Capacidad interna":
// the internal capability `addNodeInternal({ allowUnregisteredInitiative: true })`
// in src/commands/internal/create-node.mjs is the ONLY sanctioned caller of the
// `--allow-unregistered-initiative` flag. The flag is not in the
// public CLI knownFlags set for add-task / add-node / add-gate /
// add-knowledge / add-edge, so the bin rejects it before reaching
// the handler. Without the internal capability, an unregistered
// initiative must surface INITIATIVE_NOT_FOUND.
//
// Coverage:
//   1. addNodeInternal({ allowUnregisteredInitiative: true }) succeeds
//      with an unregistered initiative AND with no initiative at all.
//   2. addNodeInternal without the flag still enforces
//      INITIATIVE_NOT_FOUND on an unregistered initiative.
//   3. The public CLI rejects --allow-unregistered-initiative on
//      add-task, add-node, add-gate, add-knowledge, add-edge (bin's
//      knownFlags guard).
//   4. Without the flag, an unregistered initiative on the public
//      CLI surfaces INITIATIVE_NOT_FOUND with details.initiative.
//
// The tests run against an isolated CLIMIER_HOME per test (helpers.mjs
// guards the real ~/.climier) and never touch production code.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  createTempProject,
  rmTempProject,
  importFresh,
  runCli,
  readState,
} from "./helpers.mjs";

async function withFreshHome(body) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-internal-caps-"));
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

async function runCliRaw(args, { cwd } = {}) {
  return runCli(args, { cwd });
}

async function initProject(projectDir) {
  const r = await runCliRaw(["init"], { cwd: projectDir });
  if (r.code !== 0) {
    throw new Error(`init failed (exit ${r.code})\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
}

async function registerInitiative(projectDir, name) {
  const r = await runCliRaw(
    ["--project", projectDir, "--as", "setup",
      "add-initiative", name, "--desc", `desc-${name}`],
    { cwd: projectDir },
  );
  assert.equal(r.code, 0, `add-initiative failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
}

// ===========================================================================
// Internal capability: addNodeInternal({ allowUnregisteredInitiative: true })
// ===========================================================================

test("internal-caps: addNodeInternal with allowUnregisteredInitiative=true accepts an unregistered initiative", async () => {
  await withFreshHome(async ({ projectDir }) => {
    await initProject(projectDir);
    const { addNodeInternal } = await importFresh("../src/cli/commands/internal/create-node.mjs");
    const out = await addNodeInternal({
      statePath: projectDir,
      projectDir,
      positional: ["T-ghost"],
      flags: {
        kind: "resolvable",
        subkind: "task",
        title: "ghost task",
        body: "b",
        acceptance: "a",
        initiative: "ghost",
        "blocked-by": "",
        as: "internal",
      },
      pluginId: null,
      allowUnregisteredInitiative: true,
    });
    assert.equal(out.node.id, "T-ghost");
    assert.equal(out.node.initiative, "ghost");
    // Log entry recorded with the caller-provided agent.
    const s = await readState(projectDir);
    const last = s.log.at(-1);
    assert.equal(last.action, "add-node");
    assert.equal(last.agent, "internal");
    assert.equal(last.node, "T-ghost");
  });
});

test("internal-caps: addNodeInternal with allowUnregisteredInitiative=true also accepts NO initiative at all", async () => {
  await withFreshHome(async ({ projectDir }) => {
    await initProject(projectDir);
    const { addNodeInternal } = await importFresh("../src/cli/commands/internal/create-node.mjs");
    const out = await addNodeInternal({
      statePath: projectDir,
      projectDir,
      positional: ["T-no-init"],
      flags: {
        kind: "resolvable",
        subkind: "task",
        title: "no initiative",
        body: "b",
        acceptance: "a",
        "blocked-by": "",
        as: "internal",
      },
      pluginId: null,
      allowUnregisteredInitiative: true,
    });
    assert.equal(out.node.id, "T-no-init");
    // No initiative recorded (the public surface would have rejected
    // the missing --initiative with MISSING_FIELD).
    assert.equal(out.node.initiative, undefined);
  });
});

test("internal-caps: addNodeInternal without the flag still enforces INITIATIVE_NOT_FOUND", async () => {
  await withFreshHome(async ({ projectDir }) => {
    await initProject(projectDir);
    const { addNodeInternal } = await importFresh("../src/cli/commands/internal/create-node.mjs");
    await assert.rejects(
      () => addNodeInternal({
        statePath: projectDir,
        projectDir,
        positional: ["T-ghost"],
        flags: {
          kind: "resolvable",
          subkind: "task",
          title: "ghost",
          body: "b",
          acceptance: "a",
          initiative: "ghost",
          "blocked-by": "",
          as: "internal",
        },
        pluginId: null,
      }),
      (err) =>
        err &&
        err.code === "INITIATIVE_NOT_FOUND" &&
        err.details &&
        err.details.initiative === "ghost",
    );
  });
});

// ===========================================================================
// Public CLI surface: --allow-unregistered-initiative is unknown everywhere
// ===========================================================================

test("internal-caps: CLI add-task rejects --allow-unregistered-initiative as unknown flag", async () => {
  await withFreshHome(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "auth");
    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-task", "T-z",
      "--initiative", "auth", "--title", "t", "--body", "b",
      "--acceptance", "a", "--blocked-by", "",
      "--allow-unregistered-initiative",
    ], { cwd: projectDir });
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, /unknown flag --allow-unregistered-initiative/);
  });
});

test("internal-caps: CLI add-node rejects --allow-unregistered-initiative as unknown flag", async () => {
  await withFreshHome(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "auth");
    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-node", "T-z",
      "--kind", "resolvable", "--subkind", "task", "--title", "t",
      "--initiative", "auth",
      "--allow-unregistered-initiative",
    ], { cwd: projectDir });
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, /unknown flag --allow-unregistered-initiative/);
  });
});

test("internal-caps: CLI add-gate rejects --allow-unregistered-initiative as unknown flag", async () => {
  await withFreshHome(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "auth");
    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-gate", "G-z",
      "--initiative", "auth", "--title", "g", "--body", "b",
      "--purpose", "decision",
      "--allow-unregistered-initiative",
    ], { cwd: projectDir });
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, /unknown flag --allow-unregistered-initiative/);
  });
});

test("internal-caps: CLI add-knowledge rejects --allow-unregistered-initiative as unknown flag", async () => {
  await withFreshHome(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "auth");
    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-knowledge", "K-z",
      "--initiative", "auth", "--title", "k", "--body", "b",
      "--scope-domains", "core",
      "--allow-unregistered-initiative",
    ], { cwd: projectDir });
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, /unknown flag --allow-unregistered-initiative/);
  });
});

test("internal-caps: CLI add-edge rejects --allow-unregistered-initiative as unknown flag", async () => {
  await withFreshHome(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "auth");
    // Bootstrap two tasks so add-edge has valid endpoints.
    await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-task", "T-1",
      "--initiative", "auth", "--title", "t1", "--body", "b",
      "--acceptance", "a", "--blocked-by", "",
    ], { cwd: projectDir });
    await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-task", "T-2",
      "--initiative", "auth", "--title", "t2", "--body", "b",
      "--acceptance", "a", "--blocked-by", "",
    ], { cwd: projectDir });
    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-edge", "T-1", "T-2", "--type", "BLOCKS",
      "--allow-unregistered-initiative",
    ], { cwd: projectDir });
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, /unknown flag --allow-unregistered-initiative/);
  });
});

// ===========================================================================
// Without the internal capability, the public surface must surface
// INITIATIVE_NOT_FOUND for unregistered initiatives.
// ===========================================================================

test("internal-caps: CLI add-task without the internal capability returns INITIATIVE_NOT_FOUND for unregistered initiatives", async () => {
  await withFreshHome(async ({ projectDir }) => {
    await initProject(projectDir);
    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-task", "T-z",
      "--initiative", "ghost", "--title", "t", "--body", "b",
      "--acceptance", "a", "--blocked-by", "",
    ], { cwd: projectDir });
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "INITIATIVE_NOT_FOUND");
    assert.equal(body.error.details.initiative, "ghost");
  });
});

test("internal-caps: CLI add-gate without the internal capability returns INITIATIVE_NOT_FOUND for unregistered initiatives", async () => {
  await withFreshHome(async ({ projectDir }) => {
    await initProject(projectDir);
    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-gate", "G-z",
      "--initiative", "ghost", "--title", "g", "--body", "b",
      "--purpose", "decision",
    ], { cwd: projectDir });
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "INITIATIVE_NOT_FOUND");
    assert.equal(body.error.details.initiative, "ghost");
  });
});

test("internal-caps: CLI add-knowledge without the internal capability returns INITIATIVE_NOT_FOUND for unregistered initiatives", async () => {
  await withFreshHome(async ({ projectDir }) => {
    await initProject(projectDir);
    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-knowledge", "K-z",
      "--initiative", "ghost", "--title", "k", "--body", "b",
      "--scope-domains", "core",
    ], { cwd: projectDir });
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "INITIATIVE_NOT_FOUND");
    assert.equal(body.error.details.initiative, "ghost");
  });
});
