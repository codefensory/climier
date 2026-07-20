// F8 — v2 agent source resolution: --as > CLIMIER_AGENT > MISSING_AGENT.
//
// Coverage:
//   - resolveAgent unit tests (precedence, boolean edge, structured details)
//   - each v2 mutating command emits MISSING_AGENT when neither source is set
//   - CLIMIER_AGENT is picked up when --as is absent
//   - CLI smoke: env var works end-to-end without --as
//
// helpers.mjs sets CLIMIER_AGENT to a default so unrelated v2 tests keep
// passing. These tests delete the env var to exercise the missing-agent path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, runCli } from "./helpers.mjs";

function assertV2Error(data, code) {
  assert.equal(data.ok, false);
  assert.ok(data.error && typeof data.error === "object");
  assert.equal(data.error.code, code);
  assert.equal(typeof data.error.message, "string");
  assert.ok(data.error.details !== undefined);
}

function clearAgentEnv(restore) {
  const prev = process.env.CLIMIER_AGENT;
  delete process.env.CLIMIER_AGENT;
  return () => {
    if (prev === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prev;
    if (restore) restore();
  };
}

async function freshV2(dir) {
  const { default: init } = await importFresh("./commands/init.mjs");
  await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
}

// --- pure helper: resolveAgent precedence --------------------------------

test("resolveAgent: --as takes precedence over CLIMIER_AGENT", async () => {
  const { resolveAgent } = await importFresh("./agent.mjs");
  const prev = process.env.CLIMIER_AGENT;
  process.env.CLIMIER_AGENT = "env-agent";
  try {
    assert.equal(resolveAgent({ as: "flag-agent" }, "test-cmd"), "flag-agent");
  } finally {
    if (prev === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prev;
  }
});

test("resolveAgent: CLIMIER_AGENT used when --as is absent", async () => {
  const { resolveAgent } = await importFresh("./agent.mjs");
  const prev = process.env.CLIMIER_AGENT;
  process.env.CLIMIER_AGENT = "env-agent";
  try {
    assert.equal(resolveAgent({}, "test-cmd"), "env-agent");
  } finally {
    if (prev === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prev;
  }
});

test("resolveAgent: empty --as falls through to CLIMIER_AGENT", async () => {
  const { resolveAgent } = await importFresh("./agent.mjs");
  const prev = process.env.CLIMIER_AGENT;
  process.env.CLIMIER_AGENT = "env-agent";
  try {
    assert.equal(resolveAgent({ as: "   " }, "test-cmd"), "env-agent");
  } finally {
    if (prev === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prev;
  }
});

test("resolveAgent: both sources empty throws MISSING_AGENT with structured details", async () => {
  const { resolveAgent } = await importFresh("./agent.mjs");
  const restore = clearAgentEnv();
  try {
    let caught;
    try { resolveAgent({}, "test-cmd"); } catch (e) { caught = e; }
    assert.ok(caught, "should have thrown");
    assert.equal(caught.code, "MISSING_AGENT");
    assert.match(caught.message, /^test-cmd:/);
    assert.match(caught.message, /--as/);
    assert.match(caught.message, /CLIMIER_AGENT/);
    assert.deepEqual(caught.details, {
      command: "test-cmd",
      flag: "as",
      env: "CLIMIER_AGENT",
    });
  } finally { restore(); }
});

test("resolveAgent: --as boolean true throws MISSING_AGENT (not coerced to 'true')", async () => {
  const { resolveAgent } = await importFresh("./agent.mjs");
  const restore = clearAgentEnv();
  try {
    let caught;
    try { resolveAgent({ as: true }, "test-cmd"); } catch (e) { caught = e; }
    assert.ok(caught, "should have thrown");
    assert.equal(caught.code, "MISSING_AGENT");
  } finally { restore(); }
});

test("resolveAgent: missing flags object falls through to env", async () => {
  const { resolveAgent } = await importFresh("./agent.mjs");
  const prev = process.env.CLIMIER_AGENT;
  process.env.CLIMIER_AGENT = "env-agent";
  try {
    assert.equal(resolveAgent(undefined, "test-cmd"), "env-agent");
    assert.equal(resolveAgent(null, "test-cmd"), "env-agent");
  } finally {
    if (prev === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prev;
  }
});

// --- integration: each v2 mutating command requires an agent -----------

for (const [name, buildFlags, positional, register] of [
  ["add-initiative", () => ({ desc: "x" }), ["foo"], false],
  ["add-task", () => ({ initiative: "auth", title: "t", body: "b", acceptance: "a", "blocked-by": "" }), [], true],
  ["add-gate", () => ({ initiative: "auth", title: "t", body: "b", purpose: "decision" }), [], true],
  ["add-knowledge", () => ({ initiative: "auth", title: "t", body: "b", "scope-domains": "auth" }), [], true],
  ["add-node", () => ({ kind: "resolvable", subkind: "task", title: "t", initiative: "auth" }), ["T-x"], true],
  ["add-edge", () => ({ type: "BLOCKS" }), ["T-a", "T-b"], true],
]) {
  test(`${name}: missing agent emits MISSING_AGENT`, async () => {
    const dir = await createTempProject();
    const restore = clearAgentEnv();
    try {
      await freshV2(dir);
      if (register) {
        const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
        // Setup passes --as so add-initiative itself doesn't trip the new
        // MISSING_AGENT gate before we get to the command under test.
        await addInit({ statePath: dir, flags: { desc: "auth", as: "setup" }, positional: ["auth"] });
        // Pre-create the edge endpoints if needed (add-edge needs both T-a and T-b).
        if (name === "add-edge") {
          const { default: addNode } = await importFresh("./commands/add-node.mjs");
          await addNode({
            statePath: dir,
            positional: ["T-a"],
            flags: { kind: "resolvable", subkind: "task", title: "a", initiative: "auth", as: "setup" },
          });
          await addNode({
            statePath: dir,
            positional: ["T-b"],
            flags: { kind: "resolvable", subkind: "task", title: "b", initiative: "auth", as: "setup" },
          });
        }
      }
      const { default: cmd } = await importFresh(`./commands/${name}.mjs`);
      let caught;
      try {
        await cmd({
          statePath: dir,
          projectDir: dir,
          positional,
          flags: buildFlags(),
        });
      } catch (e) { caught = e; }
      assert.ok(caught, `${name} should have thrown MISSING_AGENT`);
      assert.equal(caught.code, "MISSING_AGENT");
      assert.equal(caught.details.command, name);
      assert.match(caught.message, new RegExp(`^${name}:`));
    } finally { restore(); await rmTempProject(dir); }
  });
}

test("v2-update: missing agent emits MISSING_AGENT", async () => {
  const dir = await createTempProject();
  const restore = clearAgentEnv();
  try {
    await freshV2(dir);
    const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
    await addInit({ statePath: dir, flags: { desc: "auth", as: "setup" }, positional: ["auth"] });
    const { default: addNode } = await importFresh("./commands/add-node.mjs");
    await addNode({
      statePath: dir,
      positional: ["T-a"],
      flags: { kind: "resolvable", subkind: "task", title: "a", initiative: "auth", as: "setup" },
    });
    const { default: update } = await importFresh("./commands/v2-update.mjs");
    let caught;
    try {
      await update({
        statePath: dir,
        positional: ["T-a"],
        flags: { title: "new" },
      });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, "MISSING_AGENT");
    assert.equal(caught.details.command, "update");
  } finally { restore(); await rmTempProject(dir); }
});

// --- integration: CLIMIER_AGENT is picked up when --as is absent --------

test("add-initiative: CLIMIER_AGENT is accepted when --as is absent", async () => {
  const dir = await createTempProject();
  const prev = process.env.CLIMIER_AGENT;
  process.env.CLIMIER_AGENT = "env-only-agent";
  try {
    await freshV2(dir);
    const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
    const out = await addInit({
      statePath: dir,
      flags: { desc: "x" },
      positional: ["foo"],
    });
    assert.equal(out.initiative.name, "foo");
  } finally {
    if (prev === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prev;
    await rmTempProject(dir);
  }
});

test("add-node: CLIMIER_AGENT is recorded in the log when --as is absent", async () => {
  const dir = await createTempProject();
  const prev = process.env.CLIMIER_AGENT;
  process.env.CLIMIER_AGENT = "env-only-agent";
  try {
    await freshV2(dir);
    const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
    await addInit({ statePath: dir, flags: { desc: "auth" }, positional: ["auth"] });
    const { default: addNode } = await importFresh("./commands/add-node.mjs");
    await addNode({
      statePath: dir,
      positional: ["T-x"],
      flags: { kind: "resolvable", subkind: "task", title: "t", initiative: "auth" },
    });
    const { readState } = await importFresh("./state.mjs");
    const s = await readState(dir);
    const last = s.log[s.log.length - 1];
    assert.equal(last.agent, "env-only-agent");
  } finally {
    if (prev === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prev;
    await rmTempProject(dir);
  }
});

// --- CLI smoke: env var works end-to-end -------------------------------

test("CLI: CLIMIER_AGENT works for add-initiative without --as", async () => {
  const dir = await createTempProject();
  try {
    const initR = await runCli(["--project", dir, "init", "--v2"], { env: { CLIMIER_AGENT: "agent-x" } });
    assert.equal(initR.code, 0, initR.stderr);
    const r = await runCli(["--project", dir, "add-initiative", "foo"], { env: { CLIMIER_AGENT: "agent-x" } });
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.initiative.name, "foo");
  } finally { await rmTempProject(dir); }
});

test("CLI: --as takes precedence over CLIMIER_AGENT in the log entry", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init", "--v2"], { env: { CLIMIER_AGENT: "env-agent" } });
    assert.equal(r.code, 0, r.stderr);
    // Register the initiative so add-node doesn't trip INITIATIVE_NOT_FOUND.
    r = await runCli(
      ["--project", dir, "add-initiative", "auth", "--desc", ""],
      { env: { CLIMIER_AGENT: "env-agent" } },
    );
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(
      ["--project", dir, "add-node", "T-x", "--kind", "resolvable", "--subkind", "task",
       "--title", "t", "--initiative", "auth", "--as", "flag-agent"],
      { env: { CLIMIER_AGENT: "env-agent" } },
    );
    assert.equal(r.code, 0, r.stderr);
    // Read the log directly to inspect the recorded agent.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const meta = JSON.parse(await fs.readFile(path.join(dir, ".climier.json"), "utf8"));
    const stateFile = path.join(process.env.CLIMIER_HOME, "projects", meta.project_id, "tasks.json");
    const s = JSON.parse(await fs.readFile(stateFile, "utf8"));
    const last = s.log[s.log.length - 1];
    assert.equal(last.agent, "flag-agent");
  } finally { await rmTempProject(dir); }
});

test("CLI: missing agent emits MISSING_AGENT", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init", "--v2"], { env: { CLIMIER_AGENT: "" } });
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "foo"], { env: { CLIMIER_AGENT: "" } });
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "MISSING_AGENT");
    assert.equal(data.error.details.command, "add-initiative");
  } finally { await rmTempProject(dir); }
});