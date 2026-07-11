// initiatives: list registered initiatives with usage counts and detect
// orphan (unregistered) initiative references left over from before
// validation was enforced, or from manual edits to tasks.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("initiatives: empty state returns empty list", async () => {
  const { default: initiatives } = await importFresh("./commands/initiatives.mjs");
  const dir = await createTempProject();
  try {
    const out = await initiatives({ statePath: dir, flags: {} });
    assert.deepEqual(out.initiatives, []);
    assert.equal(out.unregistered.nodes, 0);
    assert.deepEqual(out.unregistered.values, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("initiatives: lists registered initiatives with name and desc", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: initiatives } = await importFresh("./commands/initiatives.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "the move" }, positional: ["migration"] });
    await addInit({ statePath: dir, flags: { desc: "chores" }, positional: ["maintenance"] });
    const out = await initiatives({ statePath: dir, flags: {} });
    const names = out.initiatives.map((i) => i.name);
    assert.ok(names.includes("migration"));
    assert.ok(names.includes("maintenance"));
    const mig = out.initiatives.find((i) => i.name === "migration");
    assert.equal(mig.desc, "the move");
  } finally {
    await rmTempProject(dir);
  }
});

test("initiatives: counts tasks per initiative, all states included", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const { default: initiatives } = await importFresh("./commands/initiatives.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["maint"] });
    await addTask({ statePath: dir, flags: { initiative: "mig", title: "t1" }, positional: ["T1"] });
    await addTask({ statePath: dir, flags: { initiative: "mig", title: "t2" }, positional: ["T2"] });
    await updateState(dir, (s) => {
      s.tasks.T2.status = "done";
      s.tasks.T3 = { id: "T3", title: "t3", initiative: "mig", status: "in_progress" };
      s.tasks.T4 = { id: "T4", title: "t4", initiative: "maint" };
      return s;
    });
    const out = await initiatives({ statePath: dir, flags: {} });
    const mig = out.initiatives.find((i) => i.name === "mig");
    const maint = out.initiatives.find((i) => i.name === "maint");
    assert.equal(mig.tasks, 3); // T1, T2, T3
    assert.equal(maint.tasks, 1); // T4
  } finally {
    await rmTempProject(dir);
  }
});

test("initiatives: counts decisions and gotchas per initiative", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addDecision } = await importFresh("./commands/add-decision.mjs");
  const { default: addGotcha } = await importFresh("./commands/add-gotcha.mjs");
  const { default: initiatives } = await importFresh("./commands/initiatives.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["research"] });
    await addDecision({ statePath: dir, flags: { title: "x", initiative: "research" }, positional: ["D1"] });
    await addGotcha({ statePath: dir, flags: { title: "y", "applies-to": "T1", initiative: "research" }, positional: ["G1"] });
    const out = await initiatives({ statePath: dir, flags: {} });
    const r = out.initiatives.find((i) => i.name === "research");
    assert.equal(r.decisions, 1);
    assert.equal(r.gotchas, 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("initiatives: sorted by task count desc, ties broken by name asc", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const { default: initiatives } = await importFresh("./commands/initiatives.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["a"] });
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["b"] });
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["c"] });
    // b=2, a=1, c=0
    await addTask({ statePath: dir, flags: { initiative: "b", title: "t" }, positional: ["T1"] });
    await addTask({ statePath: dir, flags: { initiative: "b", title: "t" }, positional: ["T2"] });
    await addTask({ statePath: dir, flags: { initiative: "a", title: "t" }, positional: ["T3"] });
    const out = await initiatives({ statePath: dir, flags: {} });
    assert.deepEqual(out.initiatives.map((i) => i.name), ["b", "a", "c"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("initiatives: detects unregistered initiative references in nodes", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const { default: initiatives } = await importFresh("./commands/initiatives.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["migration"] });
    // Add a task via the validated path (uses 'migration').
    await addTask({ statePath: dir, flags: { initiative: "migration", title: "t" }, positional: ["T1"] });
    // Inject orphan nodes directly via updateState (bypasses validation, like
    // a manual edit or pre-validation-era data). Detected by `initiatives`.
    await updateState(dir, (s) => {
      s.tasks.T2 = { id: "T2", title: "orphan task", initiative: "qa" };
      s.decisions.D9 = { id: "D9", title: "orphan decision", initiative: "research" };
      s.gotchas.G1 = { id: "G1", title: "orphan gotcha", applies_to: ["T1"], initiative: "research" };
      return s;
    });
    const out = await initiatives({ statePath: dir, flags: {} });
    assert.equal(out.unregistered.nodes, 3);
    const orphanValues = out.unregistered.values.sort();
    assert.deepEqual(orphanValues, ["qa", "research"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("initiatives: nodes without any initiative field are NOT counted as unregistered", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: initiatives } = await importFresh("./commands/initiatives.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["migration"] });
    // Tasks with no initiative field at all (e.g. pre-initiative-feature data).
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "no initiative" };
      return s;
    });
    const out = await initiatives({ statePath: dir, flags: {} });
    // (none) / no-initiative tasks aren't tracked here — this is the
    // "what's registered + what's in use but not registered" view.
    assert.equal(out.unregistered.nodes, 0);
  } finally {
    await rmTempProject(dir);
  }
});
