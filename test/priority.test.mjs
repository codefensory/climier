// priority: optional `priority: "high" | "medium" | "low"` field on tasks.
// When absent, views report it as "medium". Validation is strict: only those
// three values, case-insensitive on input, normalized to lowercase on write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

// --- add-task --priority ---

test("add-task: --priority high sets the priority field (lowercased)", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    await addTask({
      statePath: dir,
      flags: { initiative: "mig", title: "x", priority: "high" },
      positional: ["T1"],
    });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.priority, "high");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: --priority is case-insensitive on input (HIGH -> high)", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    await addTask({
      statePath: dir,
      flags: { initiative: "mig", title: "x", priority: "HIGH" },
      positional: ["T1"],
    });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.priority, "high");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: all three valid levels round-trip", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    for (const [given, want] of [["high", "high"], ["medium", "medium"], ["low", "low"]]) {
      await addTask({
        statePath: dir,
        flags: { initiative: "mig", title: given, priority: given },
        positional: [`T_${given}`],
      });
    }
    const s = await readState(dir);
    assert.equal(s.tasks.T_high.priority, "high");
    assert.equal(s.tasks.T_medium.priority, "medium");
    assert.equal(s.tasks.T_low.priority, "low");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: --priority with invalid value rejects listing valid options", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    await assert.rejects(
      addTask({ statePath: dir, flags: { initiative: "mig", title: "x", priority: "urgent" }, positional: ["T1"] }),
      /priority/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: --priority with no value rejects", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    await assert.rejects(
      addTask({ statePath: dir, flags: { initiative: "mig", title: "x", priority: true }, positional: ["T1"] }),
      /priority/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: omitting --priority leaves the field absent (default medium in views)", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    await addTask({
      statePath: dir,
      flags: { initiative: "mig", title: "x" },
      positional: ["T1"],
    });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.priority, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

// --- update --priority ---

test("update: --priority high changes the priority field", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const { updateState, readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "x", priority: "low" };
      return s;
    });
    await update({ statePath: dir, flags: { as: "a", priority: "high" }, positional: ["T1"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.priority, "high");
  } finally {
    await rmTempProject(dir);
  }
});

test("update: --priority can set a priority that was previously absent", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const { updateState, readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "x" };
      return s;
    });
    await update({ statePath: dir, flags: { as: "a", priority: "high" }, positional: ["T1"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.priority, "high");
  } finally {
    await rmTempProject(dir);
  }
});

test("update: --priority with invalid value rejects", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "x" };
      return s;
    });
    await assert.rejects(
      update({ statePath: dir, flags: { as: "a", priority: "urgent" }, positional: ["T1"] }),
      /priority/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

// --- views: priority surfaces in ready, tasks, status ---

test("ready: includes priority in the output (lowercased)", async () => {
  const { default: ready } = await importFresh("./commands/ready.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", initiative: "mig", title: "a", priority: "high" };
      s.tasks.T2 = { id: "T2", initiative: "mig", title: "b", priority: "low" };
      return s;
    });
    const out = await ready({ statePath: dir, flags: {} });
    const t1 = out.find((t) => t.id === "T1");
    const t2 = out.find((t) => t.id === "T2");
    assert.equal(t1.priority, "high");
    assert.equal(t2.priority, "low");
  } finally {
    await rmTempProject(dir);
  }
});

test("ready: tasks without a priority field report priority as 'medium' (the default)", async () => {
  const { default: ready } = await importFresh("./commands/ready.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", initiative: "mig", title: "a" };
      return s;
    });
    const out = await ready({ statePath: dir, flags: {} });
    assert.equal(out[0].priority, "medium");
  } finally {
    await rmTempProject(dir);
  }
});

test("tasks: includes priority in the output (default 'medium' if absent)", async () => {
  const { default: tasks } = await importFresh("./commands/tasks.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", initiative: "mig", title: "a", priority: "high" };
      s.tasks.T2 = { id: "T2", initiative: "mig", title: "b" };
      return s;
    });
    const out = await tasks({ statePath: dir, flags: {} });
    assert.equal(out.find((t) => t.id === "T1").priority, "high");
    assert.equal(out.find((t) => t.id === "T2").priority, "medium");
  } finally {
    await rmTempProject(dir);
  }
});

test("status: in_progress entries include priority", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = {
        id: "T1",
        initiative: "mig",
        title: "x",
        status: "in_progress",
        claimed_by: "alice",
        claimed_at: Date.now(),
        priority: "high",
      };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    assert.equal(out.in_progress[0].priority, "high");
  } finally {
    await rmTempProject(dir);
  }
});

test("status: ready entries include priority (default 'medium')", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", initiative: "mig", title: "x" };
      s.tasks.T2 = { id: "T2", initiative: "mig", title: "y", priority: "low" };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    const r1 = out.ready.find((t) => t.id === "T1");
    const r2 = out.ready.find((t) => t.id === "T2");
    assert.equal(r1.priority, "medium");
    assert.equal(r2.priority, "low");
  } finally {
    await rmTempProject(dir);
  }
});
