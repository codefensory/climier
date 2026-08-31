// Initiative validation: --initiative must refer to a registered initiative
// on every write (add-task, add-gate, add-knowledge). Prevents silent
// typo-driven orphan initiatives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("assertInitiativeRegistered: passes for a registered initiative", async () => {
  const { assertInitiativeRegistered } = await importFresh("./storage/state.mjs");
  const s = { initiatives: { migration: { desc: "x" } } };
  assert.doesNotThrow(() => assertInitiativeRegistered(s, "migration", "add-task"));
});

test("assertInitiativeRegistered: throws with sorted list of valid names", async () => {
  const { assertInitiativeRegistered } = await importFresh("./storage/state.mjs");
  const s = { initiatives: { migration: { desc: "x" }, maintenance: { desc: "y" } } };
  try {
    assertInitiativeRegistered(s, "qa", "add-task");
    assert.fail("should have thrown");
  } catch (err) {
    assert.match(err.message, /--initiative 'qa' is not registered/);
    assert.match(err.message, /maintenance, migration/); // sorted alphabetically
  }
});

test("assertInitiativeRegistered: empty state hints at add-initiative", async () => {
  const { assertInitiativeRegistered } = await importFresh("./storage/state.mjs");
  try {
    assertInitiativeRegistered(null, "qa", "add-task");
    assert.fail("should have thrown");
  } catch (err) {
    assert.match(err.message, /no initiatives registered/);
    assert.match(err.message, /add-initiative/);
  }
  try {
    assertInitiativeRegistered({ initiatives: {} }, "qa", "add-task");
    assert.fail("should have thrown");
  } catch (err) {
    assert.match(err.message, /no initiatives registered/);
  }
});

// --- add-task ---

test("add-task: fails when --initiative is not registered", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { default: addTask } = await importFresh("./cli/commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await init({ projectDir: dir, positional: [], flags: {} });
    await assert.rejects(
      addTask({
        statePath: dir,
        flags: {
          initiative: "qa",
          title: "x",
          body: "b",
          acceptance: "a",
          "blocked-by": "",
        },
        positional: ["T1"],
      }),
      /initiative 'qa' is not registered/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: fails on empty state with no initiatives registered", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { default: addTask } = await importFresh("./cli/commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await init({ projectDir: dir, positional: [], flags: {} });
    await assert.rejects(
      addTask({
        statePath: dir,
        flags: {
          initiative: "migration",
          title: "x",
          body: "b",
          acceptance: "a",
          "blocked-by": "",
        },
        positional: ["T1"],
      }),
      /no initiatives registered|initiative 'migration' is not registered/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: succeeds when --initiative is registered", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./cli/commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await init({ projectDir: dir, positional: [], flags: {} });
    await addInit({ statePath: dir, flags: { desc: "the move" }, positional: ["migration"] });
    const out = await addTask({
      statePath: dir,
      flags: {
        initiative: "migration",
        title: "x",
        body: "b",
        acceptance: "a",
        "blocked-by": "",
      },
      positional: ["T1"],
    });
    assert.equal(out.node.initiative, "migration");
  } finally {
    await rmTempProject(dir);
  }
});

// --- add-gate (replaces v1 add-decision) ---

test("add-gate: fails when --initiative is not registered", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { default: addGate } = await importFresh("./cli/commands/add-gate.mjs");
  const dir = await createTempProject();
  try {
    await init({ projectDir: dir, positional: [], flags: {} });
    await assert.rejects(
      addGate({
        statePath: dir,
        flags: { initiative: "qa", title: "x", body: "b", purpose: "decision" },
        positional: ["G-decision-1"],
      }),
      /initiative 'qa' is not registered/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-gate: succeeds when --initiative is registered", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
  const { default: addGate } = await importFresh("./cli/commands/add-gate.mjs");
  const dir = await createTempProject();
  try {
    await init({ projectDir: dir, positional: [], flags: {} });
    await addInit({ statePath: dir, flags: { desc: "spikes" }, positional: ["research"] });
    const out = await addGate({
      statePath: dir,
      flags: { initiative: "research", title: "x", body: "b", purpose: "decision" },
      positional: ["G-decision-1"],
    });
    assert.equal(out.node.initiative, "research");
  } finally {
    await rmTempProject(dir);
  }
});

// --- add-knowledge (replaces v1 add-gotcha) ---

test("add-knowledge: fails when --initiative is not registered", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { default: addKnowledge } = await importFresh("./cli/commands/add-knowledge.mjs");
  const dir = await createTempProject();
  try {
    await init({ projectDir: dir, positional: [], flags: {} });
    await assert.rejects(
      addKnowledge({
        statePath: dir,
        flags: { initiative: "qa", title: "x", body: "b", "scope-domains": "db" },
        positional: ["K-trap-1"],
      }),
      /initiative 'qa' is not registered/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-knowledge: succeeds when --initiative is registered", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
  const { default: addKnowledge } = await importFresh("./cli/commands/add-knowledge.mjs");
  const dir = await createTempProject();
  try {
    await init({ projectDir: dir, positional: [], flags: {} });
    await addInit({ statePath: dir, flags: { desc: "traps" }, positional: ["auth"] });
    const out = await addKnowledge({
      statePath: dir,
      flags: { initiative: "auth", title: "x", body: "b", "scope-domains": "db" },
      positional: ["K-trap-1"],
    });
    assert.equal(out.node.initiative, "auth");
  } finally {
    await rmTempProject(dir);
  }
});