// add-task, add-initiative, add-decision, add-gotcha.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("add-task: appends a new task to state", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["migration"] });
    await addTask({
      statePath: dir,
      flags: { initiative: "migration", title: "first", skills: "ts,sql", effort: "m", domain: "db" },
      positional: ["T1"],
    });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.title, "first");
    assert.equal(s.tasks.T1.initiative, "migration");
    assert.deepEqual(s.tasks.T1.skills, ["ts", "sql"]);
    assert.equal(s.tasks.T1.effort, "m");
    assert.equal(s.tasks.T1.domain, "db");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: --depends-on attaches deps", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    await addTask({ statePath: dir, flags: { initiative: "mig", title: "x" }, positional: ["T1"] });
    await addTask({ statePath: dir, flags: { initiative: "mig", title: "y", "depends-on": "T1" }, positional: ["T2"] });
    const s = await readState(dir);
    assert.deepEqual(s.tasks.T2.depends_on, ["T1"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: rejects duplicate id", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    await addTask({ statePath: dir, flags: { initiative: "mig", title: "x" }, positional: ["T1"] });
    await assert.rejects(addTask({ statePath: dir, flags: { initiative: "mig", title: "y" }, positional: ["T1"] }));
  } finally {
    await rmTempProject(dir);
  }
});

test("add-initiative: registers an initiative with description", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "the big migration" }, positional: ["migration"] });
    const s = await readState(dir);
    assert.equal(s.initiatives.migration.desc, "the big migration");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-decision and add-gotcha work", async () => {
  // We don't expose add-decision/add-gotcha as CLI commands in v1; they're seeded
  // via the example fixture or added via JSON. But for completeness, expose a
  // minimal programmatic addNode helper that add-task uses.
  const { addNode } = await importFresh("./state.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await addNode(dir, "decisions", "D1", { id: "D1", title: "x" });
    await addNode(dir, "gotchas", "G1", { id: "G1", title: "y", applies_to: ["domain:db"] });
    const s = await readState(dir);
    assert.ok(s.decisions.D1);
    assert.ok(s.gotchas.G1);
  } finally {
    await rmTempProject(dir);
  }
});
