// T-plugin-policy-seam-dag — ADR-008 §"Acciones canónicas" + plan §4.4.
//
// Scope (paths propios del plan §4.4):
//   - add-task.mjs, add-edge.mjs, add-node.mjs, add-gate.mjs,
//     add-knowledge.mjs, update.mjs, deprecate-knowledge.mjs,
//     commands/internal/create-node.mjs.
//   - addNodeInternal({ statePath, flags, positional, pluginId,
//     allowUnregisteredInitiative = false }).
//
// What this suite covers:
//   1. Each DAG action goes through the seam with the canonical action:
//        add-task  → task.create
//        add-gate  → gate.create
//        add-knowledge → knowledge.create
//        add-edge  → edge.add
//        update    → task.update / gate.update / knowledge.update (subkind)
//        deprecate-knowledge → knowledge.deprecate
//   2. The seam honours the authorize() response: allow mutates; deny
//      produces POLICY_DENIED without mutating; abstain applies the
//      core default; throw produces POLICY_ERROR without mutating.
//   3. With no policy installed the seam is inert (defaults core).
//   4. addNodeInternal({ allowUnregisteredInitiative: true }) bypasses
//      INITIATIVE_NOT_FOUND but the public CLI no longer accepts the
//      flag (bin's knownFlags check rejects it).
//   5. Snapshot/actor/target/projectConfig passed to authorize() match
//      the snapshot read under the lock and the frozen config from
//      loadApplicablePolicy.
//
// The fixture (T-plugin-policy-fixture) drives the policy via the
// .climier.json namespace `plugins["policy-fixture"].mode`. The
// `recorded` subcommand of the fixture namespace exposes the last
// authorize() invocation for assertions.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  createTempProject,
  rmTempProject,
  runCli,
  installPolicyFixture,
  uninstallPolicyFixture,
  importFresh,
} from "./helpers.mjs";

const FIXTURE_COMMAND = "policy";

// ---- Per-test environment wrapper ----------------------------------

async function withFreshEnv(body) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-seam-dag-"));
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

// runCliRaw: like runCli but returns raw {stdout, stderr, code} so tests
// can assert on failure envelopes without throwing.
function runCliRaw(args, { cwd } = {}) {
  return runCli(args, { cwd });
}

async function cli(args, { cwd } = {}) {
  const r = await runCliRaw(args, { cwd });
  if (r.code !== 0) {
    throw new Error(
      `climier exited ${r.code}\nargv: ${JSON.stringify(args)}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
  }
  if (!r.stdout.trim()) return null;
  return JSON.parse(r.stdout);
}

async function writeClimierJson(projectDir, value) {
  await fs.writeFile(
    path.join(projectDir, ".climier.json"),
    JSON.stringify(value, null, 2) + "\n",
    "utf8",
  );
}

async function baseClimierJson(projectDir, namespace) {
  // .climier.json with the policy-fixture namespace driving the seam.
  // The fixture applies() returns true unless `applies: false` is set.
  // CRITICAL: preserve the `project_id` that `climier init` set, since
  // `stateFile` reads .climier.json to locate the project's state file.
  // Overwriting it would silently redirect reads to a different path
  // and the next handler would see "state file missing".
  const metaRaw = await fs.readFile(path.join(projectDir, ".climier.json"), "utf8");
  const meta = JSON.parse(metaRaw);
  await writeClimierJson(projectDir, {
    ...meta,
    plugins: { "policy-fixture": namespace },
  });
}

async function initProject(projectDir) {
  const r = await runCliRaw(["init"], { cwd: projectDir });
  if (r.code !== 0) {
    throw new Error(
      `init failed (exit ${r.code})\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
  }
}

async function registerInitiative(projectDir, name) {
  await cli(
    ["add-initiative", name, "--desc", `desc-${name}`, "--as", "init-agent"],
    { cwd: projectDir },
  );
}

async function recorded(projectDir) {
  // Returns the last authorize() invocation recorded by the fixture.
  return cli(
    ["--project", projectDir, "--as", "init-agent", FIXTURE_COMMAND, "recorded"],
  );
}

function buildEnvNamespace(mode, extra = {}) {
  return { mode, ...extra };
}

// ---- add-task.mjs / add-node.mjs (task.create) --------------------

test("seam-dag: add-task with no policy installed mutates and logs (defaults core)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    // No policy fixture installed: loadApplicablePolicy returns null
    // → seam is inert → core mutation proceeds.
    const out = await cli([
      "--project", projectDir, "--as", "agent-a",
      "add-task", "T-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--acceptance", "acc-x",
      "--blocked-by", "",
    ]);
    assert.equal(out.node.id, "T-x");
    assert.equal(out.node.initiative, "alpha");
  });
});

test("seam-dag: add-task with policy=allow mutates and sends action=task.create to seam", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));

    const out = await cli([
      "--project", projectDir, "--as", "agent-a",
      "add-task", "T-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--acceptance", "acc-x",
      "--blocked-by", "",
    ]);
    assert.equal(out.node.id, "T-x");

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.mode, "allow");
    assert.equal(rec.recorded.received.action, "task.create");
    assert.equal(rec.recorded.received.actor, "agent-a");
    assert.equal(rec.recorded.received.target.id, "T-x");
    assert.equal(rec.recorded.received.target.kind, "resolvable");
    assert.equal(rec.recorded.received.target.subkind, "task");
    assert.equal(rec.recorded.received.projectConfig_frozen, true);
  });
});

test("seam-dag: add-task with policy=deny returns POLICY_DENIED without mutating state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("deny", { reason: "denied task.create" }));

    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-task", "T-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--acceptance", "acc-x",
      "--blocked-by", "",
    ]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "POLICY_DENIED");
    assert.equal(body.error.details.plugin_id, "policy-fixture");
    assert.equal(body.error.details.action, "task.create");
    assert.equal(body.error.details.actor, "agent-a");
    assert.equal(body.error.details.reason, "denied task.create");

    // State must be intact: no node with id T-x.
    const status = await cli(["--project", projectDir, "status"]);
    const ids = Object.keys(status.nodes || {});
    assert.ok(!ids.includes("T-x"), `state must not contain T-x; ids=${JSON.stringify(ids)}`);
  });
});

test("seam-dag: add-task with policy=abstain applies core default (mutates)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("abstain"));

    const out = await cli([
      "--project", projectDir, "--as", "agent-a",
      "add-task", "T-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--acceptance", "acc-x",
      "--blocked-by", "",
    ]);
    assert.equal(out.node.id, "T-x");
  });
});

test("seam-dag: add-task with policy=throw returns POLICY_ERROR without mutating state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("throw"));

    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-task", "T-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--acceptance", "acc-x",
      "--blocked-by", "",
    ]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "POLICY_ERROR");
    assert.equal(body.error.details.plugin_id, "policy-fixture");
    assert.equal(body.error.details.action, "task.create");

    const status = await cli(["--project", projectDir, "status"]);
    const ids = Object.keys(status.nodes || {});
    assert.ok(!ids.includes("T-x"));
  });
});

// ---- add-gate.mjs / add-node.mjs (gate.create) ---------------------

test("seam-dag: add-gate with policy=allow sends action=gate.create to seam", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));

    const out = await cli([
      "--project", projectDir, "--as", "agent-a",
      "add-gate", "G-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--purpose", "decision",
    ]);
    assert.equal(out.node.id, "G-x");

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.mode, "allow");
    assert.equal(rec.recorded.received.action, "gate.create");
    assert.equal(rec.recorded.received.target.id, "G-x");
    assert.equal(rec.recorded.received.target.subkind, "gate");
  });
});

test("seam-dag: add-gate with policy=deny returns POLICY_DENIED without mutating state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("deny", { reason: "no gate.create" }));

    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-gate", "G-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--purpose", "decision",
    ]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "POLICY_DENIED");
    assert.equal(body.error.details.action, "gate.create");
  });
});

// ---- add-knowledge.mjs / add-node.mjs (knowledge.create) -----------

test("seam-dag: add-knowledge with policy=allow sends action=knowledge.create to seam", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));

    const out = await cli([
      "--project", projectDir, "--as", "agent-a",
      "add-knowledge", "K-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--scope-domains", "core",
    ]);
    assert.equal(out.node.id, "K-x");

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.mode, "allow");
    assert.equal(rec.recorded.received.action, "knowledge.create");
    assert.equal(rec.recorded.received.target.id, "K-x");
    assert.equal(rec.recorded.received.target.kind, "knowledge");
  });
});

test("seam-dag: add-knowledge with policy=deny returns POLICY_DENIED without mutating state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("deny", { reason: "no knowledge.create" }));

    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-knowledge", "K-x",
      "--initiative", "alpha",
      "--title", "title-x",
      "--body", "body-x",
      "--scope-domains", "core",
    ]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "POLICY_DENIED");
    assert.equal(body.error.details.action, "knowledge.create");
  });
});

// ---- add-edge.mjs (edge.add) ---------------------------------------

test("seam-dag: add-edge with no policy installed mutates", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-1",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-2",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    const out = await cli([
      "--project", projectDir, "--as", "agent-a",
      "add-edge", "T-1", "T-2", "--type", "BLOCKS",
    ]);
    assert.equal(out.edge.from, "T-1");
    assert.equal(out.edge.to, "T-2");
    assert.equal(out.edge.type, "BLOCKS");
  });
});

test("seam-dag: add-edge with policy=allow sends action=edge.add to seam", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-1",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-2",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    await cli([
      "--project", projectDir, "--as", "agent-a",
      "add-edge", "T-1", "T-2", "--type", "BLOCKS",
    ]);

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.mode, "allow");
    assert.equal(rec.recorded.received.action, "edge.add");
    assert.equal(rec.recorded.received.actor, "agent-a");
    // Snapshot under the lock must expose the live DAG so the policy
    // can make an informed decision.
    assert.deepEqual(rec.recorded.received.snapshot_keys.sort(), [
      "edges",
      "initiatives",
      "log",
      "nodes",
      "revision",
      "version",
    ]);
  });
});

test("seam-dag: add-edge with policy=deny returns POLICY_DENIED without mutating state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    // Seed the project with mode=allow so the bootstrap add-task calls
    // are not denied, then switch to mode=deny for the add-edge under test.
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-1",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-2",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    await baseClimierJson(projectDir, buildEnvNamespace("deny", { reason: "no edge.add" }));

    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-edge", "T-1", "T-2", "--type", "BLOCKS",
    ]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "POLICY_DENIED");
    assert.equal(body.error.details.action, "edge.add");

    // No BLOCKS edge should exist between T-1 and T-2.
    const status = await cli(["--project", projectDir, "status"]);
    const blocksEdge = (status.edges || []).some(
      (e) => e.from === "T-1" && e.to === "T-2" && e.type === "BLOCKS",
    );
    assert.equal(blocksEdge, false);
  });
});

test("seam-dag: add-edge with policy=throw returns POLICY_ERROR without mutating state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    // Seed the project with mode=allow so the bootstrap add-task calls
    // are not thrown on, then switch to mode=throw for the add-edge.
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-1",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-2",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    await baseClimierJson(projectDir, buildEnvNamespace("throw"));

    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-edge", "T-1", "T-2", "--type", "BLOCKS",
    ]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "POLICY_ERROR");
    assert.equal(body.error.details.action, "edge.add");
  });
});

// ---- update.mjs (task.update / gate.update / knowledge.update) -----

test("seam-dag: update on a task with policy=allow sends action=task.update", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-1",
       "--initiative", "alpha", "--title", "orig", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );

    await cli([
      "--project", projectDir, "--as", "agent-a",
      "update", "T-1", "--title", "updated",
    ]);

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.mode, "allow");
    assert.equal(rec.recorded.received.action, "task.update");
    assert.equal(rec.recorded.received.target.id, "T-1");
    assert.equal(rec.recorded.received.target.subkind, "task");
  });
});

test("seam-dag: update on a gate with policy=allow sends action=gate.update", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-gate", "G-1",
       "--initiative", "alpha", "--title", "orig", "--body", "b",
       "--purpose", "decision"],
    );

    await cli([
      "--project", projectDir, "--as", "agent-a",
      "update", "G-1", "--title", "updated",
    ]);

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.mode, "allow");
    assert.equal(rec.recorded.received.action, "gate.update");
    assert.equal(rec.recorded.received.target.id, "G-1");
    assert.equal(rec.recorded.received.target.subkind, "gate");
  });
});

test("seam-dag: update on a knowledge node with policy=allow sends action=knowledge.update", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-knowledge", "K-1",
       "--initiative", "alpha", "--title", "orig", "--body", "b",
       "--scope-domains", "core"],
    );

    await cli([
      "--project", projectDir, "--as", "agent-a",
      "update", "K-1", "--title", "updated",
    ]);

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.mode, "allow");
    assert.equal(rec.recorded.received.action, "knowledge.update");
    assert.equal(rec.recorded.received.target.id, "K-1");
    assert.equal(rec.recorded.received.target.kind, "knowledge");
  });
});

test("seam-dag: update with policy=deny returns POLICY_DENIED without mutating state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    // Seed the project with mode=allow so the bootstrap add-task is
    // not denied, then switch to mode=deny for the update under test.
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-1",
       "--initiative", "alpha", "--title", "orig", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );
    await baseClimierJson(projectDir, buildEnvNamespace("deny", { reason: "no update" }));

    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "update", "T-1", "--title", "updated",
    ]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "POLICY_DENIED");
    assert.equal(body.error.details.action, "task.update");

    // State must be intact: title is still "orig" and revision is 1.
    const show = await cli(["--project", projectDir, "show", "T-1"]);
    assert.equal(show.node.title, "orig");
    assert.equal(show.node.revision, 1);
  });
});

// ---- deprecate-knowledge.mjs (knowledge.deprecate) -----------------

test("seam-dag: deprecate-knowledge with policy=allow mutates and logs", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-knowledge", "K-1",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--scope-domains", "core"],
    );

    const out = await cli([
      "--project", projectDir, "--as", "agent-a",
      "deprecate-knowledge", "K-1", "--reason", "obsolete",
    ]);
    assert.equal(out.node.status, "deprecated");

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.mode, "allow");
    assert.equal(rec.recorded.received.action, "knowledge.deprecate");
    assert.equal(rec.recorded.received.target.id, "K-1");
  });
});

test("seam-dag: deprecate-knowledge with policy=deny returns POLICY_DENIED without mutating state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    // Seed the project with mode=allow so the bootstrap add-knowledge
    // is not denied, then switch to mode=deny for the deprecate under test.
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-knowledge", "K-1",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--scope-domains", "core"],
    );
    await baseClimierJson(projectDir, buildEnvNamespace("deny", { reason: "no deprecate" }));

    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "deprecate-knowledge", "K-1", "--reason", "obsolete",
    ]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "POLICY_DENIED");
    assert.equal(body.error.details.action, "knowledge.deprecate");

    const show = await cli(["--project", projectDir, "show", "K-1"]);
    assert.equal(show.node.status, "active");
  });
});

test("seam-dag: deprecate-knowledge adapter uses the kernel knowledge provider frontier", async () => {
  const source = await fs.readFile(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "src", "cli", "commands", "deprecate-knowledge.mjs"),
    "utf8",
  );
  assert.match(source, /from [\"']\.\.\/\.\.\/kernel\/mutate\.mjs[\"']/);
  assert.match(source, /from [\"']\.\.\/\.\.\/providers\/knowledge\/deprecate\.mjs[\"']/);
  assert.match(source, /\bmutate\(/);
  for (const forbidden of ["../state.mjs", "../storage/lock.mjs", "../storage/log.mjs"]) {
    assert.doesNotMatch(source, new RegExp(`from [\\\"']${forbidden.replaceAll("/", "\\\\/")}[\\\"']`));
  }
});

// ---- addNodeInternal (capacity, plan §3.7) -------------------------

test("seam-dag: addNodeInternal({ allowUnregisteredInitiative: true }) bypasses INITIATIVE_NOT_FOUND", async () => {
  await withFreshEnv(async ({ projectDir }) => {
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
        body: "body",
        acceptance: "acc",
        "blocked-by": "",
        as: "internal",
      },
      pluginId: null,
      allowUnregisteredInitiative: true,
    });
    assert.equal(out.node.id, "T-ghost");
    assert.equal(out.node.initiative, undefined);
  });
});

test("seam-dag: addNodeInternal without the flag still enforces INITIATIVE_NOT_FOUND", async () => {
  await withFreshEnv(async ({ projectDir }) => {
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
          "blocked-by": "",
          as: "internal",
        },
        pluginId: null,
      }),
      (err) => err.code === "MISSING_FIELD" || err.code === "INITIATIVE_NOT_FOUND",
    );
  });
});

// ---- public CLI flag removal (ADR-008 §"Capacidad interna") --------

test("seam-dag: CLI add-task rejects --allow-unregistered-initiative as unknown flag", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-task", "T-z",
      "--initiative", "alpha",
      "--title", "t", "--body", "b",
      "--acceptance", "a", "--blocked-by", "",
      "--allow-unregistered-initiative",
    ]);
    assert.equal(r.code, 1);
    // The bin's unknown-flag guard raises a generic Error (no .code),
    // so the envelope is the message-only shape.
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, /unknown flag --allow-unregistered-initiative/);
  });
});

test("seam-dag: CLI add-node rejects --allow-unregistered-initiative as unknown flag", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-node", "T-z",
      "--kind", "resolvable", "--subkind", "task",
      "--title", "t",
      "--allow-unregistered-initiative",
    ]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, /unknown flag --allow-unregistered-initiative/);
  });
});

// ---- snapshot/projectConfig contract under the seam ----------------

test("seam-dag: snapshot passed to authorize reflects the live state under the lock", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    // Pre-seed another task so the snapshot under the lock is not empty.
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-pre",
       "--initiative", "alpha", "--title", "pre", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );

    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-post",
       "--initiative", "alpha", "--title", "post", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.received.action, "task.create");
    // projectConfig was frozen before being passed.
    assert.equal(rec.recorded.received.projectConfig_frozen, true);
    assert.deepEqual(rec.recorded.received.snapshot_keys.sort(), [
      "edges", "initiatives", "log", "nodes", "revision", "version",
    ]);
    // The recorded payload exposes a target fingerprint (id/kind/subkind)
    // so the policy can branch on what's being created.
    assert.equal(rec.recorded.received.target.id, "T-post");
    assert.equal(rec.recorded.received.target.subkind, "task");
  });
});
