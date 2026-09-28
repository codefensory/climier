
//
// Every lifecycle action must reach the policy with the SAME canonical
// action name regardless of whether the call came from the public CLI
// (`climier <command>`) or from the plugin API core (api.core.run).
// The actor recorded in the log entry must also be identical for both
// paths, since the seam uses the actor to scope its decision.
//
// This test file installs the policy-fixture in mode=allow and records

// submit/accept, release, reopen, cancel, add-note, add-initiative) it runs

//   - the CLI bin (`node bin/climier.mjs ...`)
//   - the plugin API core (`api.core.run({ op, input })`)
// and asserts both paths produced the SAME canonical action and
// recorded the SAME actor. A divergence here would mean the adapter
// has drifted from the bin.
//

// api.runtime.agent field (the adapter sets `flags.as` from
// api.runtime.agent automatically; see src/plugin-core-adapter.mjs).
//
// Isolation: per-test CLIMIER_HOME under os.tmpdir() and per-test
// project dir. helpers.mjs guards the real ~/.climier.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createTempProject,
  rmTempProject,
  importFresh,
  runCli,
  installPolicyFixture,
  uninstallPolicyFixture,
} from "./helpers.mjs";

const FIXTURE_COMMAND = "policy";

async function withFreshEnv(body) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-parity-"));
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
      `climier exited ${result.code}\nargv: ${JSON.stringify(args)}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  if (!result.stdout.trim()) {
    return null;
  }
  return JSON.parse(result.stdout);
}

async function writeClimierJson(projectDir, value) {
  await fs.writeFile(
    path.join(projectDir, ".climier.json"),
    JSON.stringify(value, null, 2) + "\n",
    "utf8",
  );
}

async function baseClimierJson(projectDir, mode = "allow") {
  // .climier.json MUST be written before `climier init` so the
  // state path is pinned to the test's project_id.
  await writeClimierJson(projectDir, {
    version: 1,
    project_id: "parity-cli-api-project",
    plugins: { "policy-fixture": { mode } },
  });
}

async function initAndSeed(projectDir) {
  await baseClimierJson(projectDir, "allow");
  await cli(["--project", projectDir, "init"]);
  await cli([
    "--project", projectDir, "--as", "setup",
    "add-initiative", "auth", "--desc", "auth",
  ]);
  await cli([
    "--project", projectDir, "--as", "setup",
    "add-node", "T-parity-1",
    "--kind", "resolvable", "--subkind", "task", "--title", "parity",
    "--initiative", "auth",
  ]);
}

async function addTask(projectDir, id, title) {
  await cli([
    "--project", projectDir, "--as", "setup",
    "add-node", id,
    "--kind", "resolvable", "--subkind", "task", "--title", title,
    "--initiative", "auth",
  ]);
}

async function seedClaimedTasks(projectDir, tasks) {
  for (const { id, title } of tasks) {
    await addTask(projectDir, id, title);
    await cli(["--project", projectDir, "take", id, "--as", "alice"]);
  }
}

async function acceptTasks(projectDir, ids) {
  for (const id of ids) {
    await cli(["--project", projectDir, "submit", id, "--note", "shipped", "--as", "alice"]);
    await cli(["--project", projectDir, "accept", id, "--as", "alice"]);
  }
}

async function assertRecorded(projectDir, action, actor) {
  const rec = await recorded(projectDir);
  assert.equal(rec.recorded.mode, "allow");
  assert.equal(rec.recorded.received.action, action);
  assert.equal(rec.recorded.received.actor, actor);
  return rec.recorded.received;
}

async function freshApi(projectDir, { agent, pluginId }) {
  const { createApi } = await importFresh("./plugins/api.mjs");
  return createApi({ projectDir, agent, pluginId });
}

async function recorded(projectDir) {
  return cli([
    "--project", projectDir, "--as", "reader",
    FIXTURE_COMMAND, "recorded",
  ]);
}

async function installFixture(projectDir) {
  await installPolicyFixture(projectDir);
}

test("parity: take — CLI and api.core.run produce the same actor and canonical action", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed(projectDir);
    await installFixture(projectDir);
    try {
      // --- CLI path
      await cli(["--project", projectDir, "take", "T-parity-1", "--as", "alice"]);
      const cliRec = await recorded(projectDir);
      assert.equal(cliRec.recorded.mode, "allow");
      assert.equal(cliRec.recorded.received.action, "task.take");
      assert.equal(cliRec.recorded.received.actor, "alice");
      assert.equal(cliRec.recorded.received.target.id, "T-parity-1");

      // --- API core path

      // LAST authorize invocation, so the second path needs its own
      // target.
      await cli([
        "--project", projectDir, "--as", "setup",
        "add-node", "T-parity-2",
        "--kind", "resolvable", "--subkind", "task", "--title", "parity 2",
        "--initiative", "auth",
      ]);
      const api = await freshApi(projectDir, { agent: "alice", pluginId: "example.audit" });
      await api.core.run({ op: "task.take", input: { id: "T-parity-2" } });
      const apiRec = await recorded(projectDir);
      assert.equal(apiRec.recorded.mode, "allow");
      assert.equal(apiRec.recorded.received.action, "task.take");
      assert.equal(apiRec.recorded.received.actor, "alice");
      assert.equal(apiRec.recorded.received.target.id, "T-parity-2");

      // Both paths delivered the SAME canonical action and SAME actor.
      assert.equal(apiRec.recorded.received.action, cliRec.recorded.received.action);
      assert.equal(apiRec.recorded.received.actor, cliRec.recorded.received.actor);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

// takeover (with policy allow)

test("parity: takeover — CLI preserves takeover policy action while api.core.run uses typed task.take", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed(projectDir);
    await installFixture(projectDir);
    try {
      // Seed two tasks: the first will be claimed by alice, the second
      // by alice and then taken over by bob via each path.
      await cli([
        "--project", projectDir, "--as", "setup",
        "add-node", "T-take-1",
        "--kind", "resolvable", "--subkind", "task", "--title", "t1",
        "--initiative", "auth",
      ]);
      await cli([
        "--project", projectDir, "--as", "setup",
        "add-node", "T-take-2",
        "--kind", "resolvable", "--subkind", "task", "--title", "t2",
        "--initiative", "auth",
      ]);
      await cli(["--project", projectDir, "take", "T-take-1", "--as", "alice"]);
      await cli(["--project", projectDir, "take", "T-take-2", "--as", "alice"]);

      // --- CLI takeover
      await cli(["--project", projectDir, "take", "T-take-1", "--as", "bob"]);
      const cliRec = await recorded(projectDir);
      assert.equal(cliRec.recorded.mode, "allow");
      assert.equal(cliRec.recorded.received.action, "task.takeover");
      assert.equal(cliRec.recorded.received.actor, "bob");

      // --- API core takeover
      const api = await freshApi(projectDir, { agent: "bob", pluginId: "example.audit" });
      await api.core.run({ op: "task.take", input: { id: "T-take-2" } });
      const apiRec = await recorded(projectDir);
      assert.equal(apiRec.recorded.mode, "allow");

      // while preserving the core take/log operation semantics.
      assert.equal(apiRec.recorded.received.action, "task.take");
      assert.equal(apiRec.recorded.received.actor, "bob");
      assert.equal(apiRec.recorded.received.actor, cliRec.recorded.received.actor);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

// submit + accept

test("parity: accept — CLI and api.core.run produce the same actor and canonical action", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed(projectDir);
    await installFixture(projectDir);
    try {
      await seedClaimedTasks(projectDir, [
        { id: "T-res-1", title: "r1" },
        { id: "T-res-2", title: "r2" },
      ]);

      await cli(["--project", projectDir, "submit", "T-res-1", "--note", "done via CLI", "--as", "alice"]);
      await cli(["--project", projectDir, "accept", "T-res-1", "--as", "alice"]);
      const cliRec = await assertRecorded(projectDir, "task.accept", "alice");

      const api = await freshApi(projectDir, { agent: "alice", pluginId: "example.audit" });
      await api.core.run({ op: "task.submit", input: { id: "T-res-2", note: "done via api" } });
      await api.core.run({ op: "task.accept", input: { id: "T-res-2" } });
      const apiRec = await assertRecorded(projectDir, "task.accept", "alice");
      assert.equal(apiRec.action, cliRec.action);
      assert.equal(apiRec.actor, cliRec.actor);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

// release

test("parity: release — CLI and api.core.run produce the same actor and canonical action", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed(projectDir);
    await installFixture(projectDir);
    try {
      await seedClaimedTasks(projectDir, [
        { id: "T-rel-1", title: "rel1" },
        { id: "T-rel-2", title: "rel2" },
      ]);

      await cli(["--project", projectDir, "release", "T-rel-1", "--as", "alice"]);
      const cliRec = await assertRecorded(projectDir, "task.release", "alice");

      const api = await freshApi(projectDir, { agent: "alice", pluginId: "example.audit" });
      await api.core.run({ op: "task.release", input: { id: "T-rel-2" } });
      const apiRec = await assertRecorded(projectDir, "task.release", "alice");
      assert.equal(apiRec.action, cliRec.action);
      assert.equal(apiRec.actor, cliRec.actor);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

// reopen (after accept)

test("parity: reopen — CLI and api.core.run produce the same actor and canonical action", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed(projectDir);
    await installFixture(projectDir);
    try {
      await seedClaimedTasks(projectDir, [
        { id: "T-reo-1", title: "reo1" },
        { id: "T-reo-2", title: "reo2" },
      ]);
      await acceptTasks(projectDir, ["T-reo-1", "T-reo-2"]);

      await cli(["--project", projectDir, "reopen", "T-reo-1", "--reason", "wrong acceptance", "--as", "alice"]);
      const cliRec = await assertRecorded(projectDir, "task.reopen", "alice");

      const api = await freshApi(projectDir, { agent: "alice", pluginId: "example.audit" });
      await api.core.run({ op: "task.reopen", input: { id: "T-reo-2", reason: "wrong acceptance" } });
      const apiRec = await assertRecorded(projectDir, "task.reopen", "alice");
      assert.equal(apiRec.action, cliRec.action);
      assert.equal(apiRec.actor, cliRec.actor);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

// cancel

test("parity: cancel — CLI and api.core.run produce the same actor and canonical action", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed(projectDir);
    await installFixture(projectDir);
    try {
      await seedClaimedTasks(projectDir, [
        { id: "T-can-1", title: "can1" },
        { id: "T-can-2", title: "can2" },
      ]);

      await cli(["--project", projectDir, "cancel", "T-can-1", "--reason", "out of scope", "--as", "alice"]);
      const cliRec = await assertRecorded(projectDir, "task.cancel", "alice");

      const api = await freshApi(projectDir, { agent: "alice", pluginId: "example.audit" });
      await api.core.run({ op: "task.cancel", input: { id: "T-can-2", reason: "out of scope" } });
      const apiRec = await assertRecorded(projectDir, "task.cancel", "alice");
      assert.equal(apiRec.action, cliRec.action);
      assert.equal(apiRec.actor, cliRec.actor);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("parity: add-note — CLI and api.core.run produce the same actor and canonical action", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed(projectDir);
    await installFixture(projectDir);
    try {
      // --- CLI add-note
      await cli(["--project", projectDir, "add-note", "T-parity-1", "via CLI", "--as", "alice"]);
      const cliRec = await recorded(projectDir);
      assert.equal(cliRec.recorded.mode, "allow");
      assert.equal(cliRec.recorded.received.action, "note.add");
      assert.equal(cliRec.recorded.received.actor, "alice");

      // --- API core add-note
      const api = await freshApi(projectDir, { agent: "alice", pluginId: "example.audit" });
      // note.add is an explicit-CAS typed operation. The CLI adapter routes
      // through kernel.mutate, so appending its note bumps the seeded node
      // from revision 1 to revision 2.
      await api.core.run({
        op: "note.add",
        input: { id: "T-parity-1", text: "via api", if_revision: (await cli(["--project", projectDir, "show", "T-parity-1"])).node.revision },
      });
      const apiRec = await recorded(projectDir);
      assert.equal(apiRec.recorded.mode, "allow");
      assert.equal(apiRec.recorded.received.action, "note.add");
      assert.equal(apiRec.recorded.received.actor, "alice");

      assert.equal(apiRec.recorded.received.action, cliRec.recorded.received.action);
      assert.equal(apiRec.recorded.received.actor, cliRec.recorded.received.actor);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("parity: add-initiative — CLI and api.core.run produce the same actor and canonical action", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed(projectDir);
    await installFixture(projectDir);
    try {
      // --- CLI add-initiative
      await cli(["--project", projectDir, "add-initiative", "cli-initiative", "--desc", "via CLI", "--as", "alice"]);
      const cliRec = await recorded(projectDir);
      assert.equal(cliRec.recorded.mode, "allow");
      assert.equal(cliRec.recorded.received.action, "initiative.create");
      assert.equal(cliRec.recorded.received.actor, "alice");

      // --- API core add-initiative
      const api = await freshApi(projectDir, { agent: "alice", pluginId: "example.audit" });
      await api.core.run({ op: "initiative.create", input: { name: "api-initiative", desc: "via api" } });
      const apiRec = await recorded(projectDir);
      assert.equal(apiRec.recorded.mode, "allow");
      assert.equal(apiRec.recorded.received.action, "initiative.create");
      assert.equal(apiRec.recorded.received.actor, "alice");

      assert.equal(apiRec.recorded.received.action, cliRec.recorded.received.action);
      assert.equal(apiRec.recorded.received.actor, cliRec.recorded.received.actor);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});
