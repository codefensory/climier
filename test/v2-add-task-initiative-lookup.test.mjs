import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, runCli } from "./helpers.mjs";

const taskFlags = (initiative) => ({
  initiative,
  title: "x",
  body: "y",
  acceptance: "z",
  "blocked-by": "",
  as: "test-agent",
});

async function withProject(fn) {
  const dir = await createTempProject();
  try {
    await fn(dir);
  } finally {
    await rmTempProject(dir);
  }
}

async function initV2(dir) {
  const { default: init } = await importFresh("./commands/init.mjs");
  await init({ statePath: dir, projectDir: dir, positional: [], flags: { v2: true } });
}

async function registerFoo(dir) {
  const { default: addInitiative } = await importFresh("./commands/add-initiative.mjs");
  await addInitiative({
    statePath: dir,
    projectDir: dir,
    positional: ["foo"],
    flags: { desc: "x", as: "test-agent" },
  });
}

test("v2 add-task accepts an initiative registered by add-initiative", async () => {
  await withProject(async (dir) => {
    await initV2(dir);
    await registerFoo(dir);
    const { default: addTask } = await importFresh("./commands/add-task.mjs");

    const out = await addTask({
      statePath: dir,
      projectDir: dir,
      positional: ["T-x"],
      flags: taskFlags("foo"),
    });

    assert.equal(out.node.initiative, "foo");
  });
});

test("CLI v2 add-task accepts an initiative registered by add-initiative", async () => {
  await withProject(async (dir) => {
    let result = await runCli(["init"], { cwd: dir });
    assert.equal(result.code, 0, result.stdout);
    result = await runCli(["add-initiative", "foo", "--desc", "x", "--as", "test-agent"], { cwd: dir });
    assert.equal(result.code, 0, result.stdout);

    result = await runCli([
      "add-task", "T-x", "--initiative", "foo", "--title", "x", "--body", "y",
      "--acceptance", "z", "--blocked-by", "", "--as", "test-agent",
    ], { cwd: dir });

    assert.equal(result.code, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).node.initiative, "foo");
  });
});

test("v2 add-task rejects an unregistered initiative with INITIATIVE_NOT_FOUND", async () => {
  await withProject(async (dir) => {
    await initV2(dir);
    const { default: addTask } = await importFresh("./commands/add-task.mjs");

    await assert.rejects(
      addTask({
        statePath: dir,
        projectDir: dir,
        positional: ["T-y"],
        flags: taskFlags("NOT_REGISTERED"),
      }),
      (error) => error.code === "INITIATIVE_NOT_FOUND"
        && error.details?.initiative === "NOT_REGISTERED",
    );
  });
});

test("CLI v2 add-task rejects --allow-unregistered-initiative as unknown flag (T-plugin-policy-seam-dag)", async () => {
  // T-plugin-policy-seam-dag (ADR-008 §"Capacidad interna"):
  // --allow-unregistered-initiative is no longer accepted on the
  // public CLI surface. The bin's knownFlags check rejects it before
  // the handler runs. The internal capability lives in
  // `addNodeInternal({ allowUnregisteredInitiative: true })` in
  // src/commands/internal/create-node.mjs; see test/plugin-policy-seam-dag.test.mjs for
  // the corresponding positive test.
  await withProject(async (dir) => {
    let result = await runCli(["init"], { cwd: dir });
    assert.equal(result.code, 0, result.stdout);

    result = await runCli([
      "add-task", "T-z", "--initiative", "foo", "--title", "x", "--body", "y",
      "--acceptance", "z", "--blocked-by", "", "--as", "test-agent",
      "--allow-unregistered-initiative",
    ], { cwd: dir });

    assert.equal(result.code, 1, result.stdout);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, /unknown flag --allow-unregistered-initiative/);
  });
});

test("CLI v2 add-task returns a structured error when initiative is missing", async () => {
  await withProject(async (dir) => {
    let result = await runCli(["init"], { cwd: dir });
    assert.equal(result.code, 0, result.stdout);

    result = await runCli([
      "add-task", "T-y", "--initiative", "NOT_REGISTERED", "--title", "x", "--body", "y",
      "--acceptance", "z", "--blocked-by", "", "--as", "test-agent",
    ], { cwd: dir });

    assert.equal(result.code, 1, result.stdout);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "INITIATIVE_NOT_FOUND");
    assert.equal(body.error.details.initiative, "NOT_REGISTERED");
  });
});
