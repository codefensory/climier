// add-task --phase: CLI auto-allocates the next free id for a phase.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState } from "./helpers.mjs";

test("add-task --phase: allocates F1.T3 when F1.T1 and F1.T2 exist", async () => {
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.initiatives["mig"] = { desc: "" };
      s.tasks["F1.T1"] = { id: "F1.T1", title: "a", initiative: "mig" };
      s.tasks["F1.T2"] = { id: "F1.T2", title: "b", initiative: "mig" };
      return s;
    });
    const out = await addTask({
      statePath: dir,
      flags: { phase: "F1", initiative: "mig", title: "c" },
      positional: [],
    });
    assert.equal(out.task.id, "F1.T3");
    const s = await readState(dir);
    assert.ok(s.tasks["F1.T3"]);
    assert.equal(s.tasks["F1.T3"].title, "c");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task --phase: empty phase gets phase.T1", async () => {
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.initiatives["mig"] = { desc: "" };
      return s;
    });
    const out = await addTask({
      statePath: dir,
      flags: { phase: "F5", initiative: "mig", title: "first in F5" },
      positional: [],
    });
    assert.equal(out.task.id, "F5.T1");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task --phase: ignores .OPEN placeholders in the phase", async () => {
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.initiatives["mig"] = { desc: "" };
      s.tasks["F2.OPEN"] = { id: "F2.OPEN", title: "decompose later", initiative: "mig" };
      return s;
    });
    const out = await addTask({
      statePath: dir,
      flags: { phase: "F2", initiative: "mig", title: "concrete" },
      positional: [],
    });
    assert.equal(out.task.id, "F2.T1");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: positional id still works (backward compat)", async () => {
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.initiatives["mig"] = { desc: "" };
      return s;
    });
    const out = await addTask({
      statePath: dir,
      flags: { initiative: "mig", title: "x" },
      positional: ["F9.T7"],
    });
    assert.equal(out.task.id, "F9.T7");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: rejects when both positional and --phase are given", async () => {
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.initiatives["mig"] = { desc: "" };
      return s;
    });
    await assert.rejects(
      addTask({
        statePath: dir,
        flags: { phase: "F1", initiative: "mig", title: "x" },
        positional: ["F1.T5"],
      }),
      /not both|either.*or/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: rejects when neither positional nor --phase is given", async () => {
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.initiatives["mig"] = { desc: "" };
      return s;
    });
    await assert.rejects(
      addTask({
        statePath: dir,
        flags: { initiative: "mig", title: "x" },
        positional: [],
      }),
      /task id required|--phase/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task --phase F1 --suffix R: creates F1.T1R", async () => {
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.initiatives["mig"] = { desc: "" };
      s.tasks["F1.T1"] = { id: "F1.T1", title: "a", initiative: "mig" };
      s.tasks["F1.T2"] = { id: "F1.T2", title: "b", initiative: "mig" };
      return s;
    });
    const out = await addTask({
      statePath: dir,
      flags: { phase: "F1", suffix: "R", initiative: "mig", title: "research variant" },
      positional: [],
    });
    assert.equal(out.task.id, "F1.T1R");
    const s = await readState(dir);
    assert.ok(s.tasks["F1.T1R"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task --phase F1 --suffix R: R family is independent of T family", async () => {
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.initiatives["mig"] = { desc: "" };
      s.tasks["F1.T1R"] = { id: "F1.T1R", title: "r1", initiative: "mig" };
      return s;
    });
    const out = await addTask({
      statePath: dir,
      flags: { phase: "F1", suffix: "R", initiative: "mig", title: "r2" },
      positional: [],
    });
    assert.equal(out.task.id, "F1.T2R");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task --suffix: rejects suffix with a dot", async () => {
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.initiatives["mig"] = { desc: "" };
      return s;
    });
    await assert.rejects(
      addTask({
        statePath: dir,
        flags: { phase: "F1", suffix: "R.1", initiative: "mig", title: "x" },
        positional: [],
      }),
      /suffix/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task --suffix: rejects empty suffix", async () => {
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.initiatives["mig"] = { desc: "" };
      return s;
    });
    await assert.rejects(
      addTask({
        statePath: dir,
        flags: { phase: "F1", suffix: "", initiative: "mig", title: "x" },
        positional: [],
      }),
      /suffix/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});
