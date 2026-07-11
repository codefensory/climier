// Initiative validation: --initiative must refer to a registered initiative
// on every write (add-task, add-decision, add-gotcha). Prevents silent
// typo-driven orphan initiatives (the "qa" / "research" case in new-vegsport).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("assertInitiativeRegistered: passes for a registered initiative", async () => {
  const { assertInitiativeRegistered } = await importFresh("./state.mjs");
  const s = { initiatives: { migration: { desc: "x" } } };
  assert.doesNotThrow(() => assertInitiativeRegistered(s, "migration", "add-task"));
});

test("assertInitiativeRegistered: throws with sorted list of valid names", async () => {
  const { assertInitiativeRegistered } = await importFresh("./state.mjs");
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
  const { assertInitiativeRegistered } = await importFresh("./state.mjs");
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
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      addTask({ statePath: dir, flags: { initiative: "qa", title: "x" }, positional: ["T1"] }),
      /--initiative 'qa' is not registered/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: fails on empty state with no initiatives registered", async () => {
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      addTask({ statePath: dir, flags: { initiative: "migration", title: "x" }, positional: ["T1"] }),
      /no initiatives registered/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: succeeds when --initiative is registered", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "the move" }, positional: ["migration"] });
    const out = await addTask({
      statePath: dir,
      flags: { initiative: "migration", title: "x" },
      positional: ["T1"],
    });
    assert.equal(out.task.initiative, "migration");
  } finally {
    await rmTempProject(dir);
  }
});

// --- add-decision ---

test("add-decision: fails when --initiative is not registered", async () => {
  const { default: addDecision } = await importFresh("./commands/add-decision.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      addDecision({ statePath: dir, flags: { title: "x", initiative: "qa" }, positional: ["D1"] }),
      /--initiative 'qa' is not registered/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-decision: still allows transversal decisions without --initiative", async () => {
  const { default: addDecision } = await importFresh("./commands/add-decision.mjs");
  const dir = await createTempProject();
  try {
    const out = await addDecision({ statePath: dir, flags: { title: "x" }, positional: ["D1"] });
    assert.equal(out.decision.initiative, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-decision: succeeds when --initiative is registered", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addDecision } = await importFresh("./commands/add-decision.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "spikes" }, positional: ["research"] });
    const out = await addDecision({
      statePath: dir,
      flags: { title: "x", initiative: "research" },
      positional: ["D1"],
    });
    assert.equal(out.decision.initiative, "research");
  } finally {
    await rmTempProject(dir);
  }
});

// --- add-gotcha ---

test("add-gotcha: fails when --initiative is not registered", async () => {
  const { default: addGotcha } = await importFresh("./commands/add-gotcha.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      addGotcha({
        statePath: dir,
        flags: { title: "x", "applies-to": "domain:db", initiative: "qa" },
        positional: ["G1"],
      }),
      /--initiative 'qa' is not registered/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-gotcha: still allows transversal gotchas without --initiative", async () => {
  const { default: addGotcha } = await importFresh("./commands/add-gotcha.mjs");
  const dir = await createTempProject();
  try {
    const out = await addGotcha({
      statePath: dir,
      flags: { title: "x", "applies-to": "domain:db" },
      positional: ["G1"],
    });
    assert.equal(out.gotcha.initiative, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-gotcha: succeeds when --initiative is registered", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addGotcha } = await importFresh("./commands/add-gotcha.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "traps" }, positional: ["auth"] });
    const out = await addGotcha({
      statePath: dir,
      flags: { title: "x", "applies-to": "domain:db", initiative: "auth" },
      positional: ["G1"],
    });
    assert.equal(out.gotcha.initiative, "auth");
  } finally {
    await rmTempProject(dir);
  }
});
