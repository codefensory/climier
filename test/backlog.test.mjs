// backlog: persisted `backlog: true` flag. Backlog tasks are not ready, not
// blocked — they sit in their own bucket. Promote moves them out of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

// --- derive() ---

test("derive: a task with backlog:true is excluded from ready and blocked, returned in backlog[]", async () => {
  const { derive } = await importFresh("./dag.mjs");
  const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  s.tasks.T1 = { id: "T1", title: "backlog task", backlog: true };
  s.tasks.T2 = { id: "T2", title: "ready task" };
  s.tasks.T3 = { id: "T3", title: "blocked task", depends_on: ["T1"] };
  const r = derive(s);
  assert.deepEqual(r.backlog, ["T1"]);
  assert.deepEqual(r.ready, ["T2"]);
  assert.deepEqual(r.blocked, ["T3"]);
});

test("derive: a backlog task with no deps stays backlog after its dep is 'satisfied-but-also-backlog'", async () => {
  // Edge case: T1 (backlog) and T2 (depends on T1, not backlog). T1's
  // backlog-ness does NOT satisfy T2's dep. So T2 is blocked, T1 is backlog.
  const { derive } = await importFresh("./dag.mjs");
  const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  s.tasks.T1 = { id: "T1", backlog: true };
  s.tasks.T2 = { id: "T2", depends_on: ["T1"] };
  const r = derive(s);
  assert.deepEqual(r.backlog, ["T1"]);
  assert.deepEqual(r.blocked, ["T2"]);
  assert.deepEqual(r.ready, []);
});

test("derive: empty state has backlog: [] (never undefined)", async () => {
  const { derive } = await importFresh("./dag.mjs");
  const { emptyState } = await importFresh("./state.mjs");
  const r = derive(emptyState());
  assert.deepEqual(r.backlog, []);
});

test("statusOf: a backlog task reports 'backlog'", async () => {
  const { statusOf } = await importFresh("./dag.mjs");
  const { emptyState } = await importFresh("./state.mjs");
  const s = emptyState();
  s.tasks.T1 = { id: "T1", backlog: true };
  assert.equal(statusOf(s, "T1"), "backlog");
});

// --- add-task --backlog ---

test("add-task: --backlog true sets the backlog flag", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    await addTask({
      statePath: dir,
      flags: { initiative: "mig", title: "future", backlog: "true" },
      positional: ["T1"],
    });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.backlog, true);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: --backlog false is the default behavior (flag not set)", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    await addTask({
      statePath: dir,
      flags: { initiative: "mig", title: "normal", backlog: "false" },
      positional: ["T1"],
    });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.backlog, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: --backlog with invalid value rejects with valid options", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    await assert.rejects(
      addTask({ statePath: dir, flags: { initiative: "mig", title: "x", backlog: "yes" }, positional: ["T1"] }),
      /backlog/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: --backlog with no value rejects", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    await assert.rejects(
      addTask({ statePath: dir, flags: { initiative: "mig", title: "x", backlog: true }, positional: ["T1"] }),
      /backlog/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

// --- claim: backlog tasks are not claimable ---

test("claim: rejects a backlog task with a clear error", async () => {
  const { default: claim } = await importFresh("./commands/claim.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "backlog", backlog: true };
      return s;
    });
    await assert.rejects(
      claim({ statePath: dir, flags: { as: "a" }, positional: ["T1"] }),
      /backlog/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

// --- views: ready excludes backlog, status includes backlog section ---

test("ready: excludes backlog tasks from the output", async () => {
  const { default: ready } = await importFresh("./commands/ready.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", initiative: "mig", title: "backlog", backlog: true };
      s.tasks.T2 = { id: "T2", initiative: "mig", title: "ready" };
      return s;
    });
    const out = await ready({ statePath: dir, flags: {} });
    const ids = out.map((t) => t.id);
    assert.deepEqual(ids, ["T2"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("status: includes a backlog section with id and title", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.B1 = { id: "B1", initiative: "mig", title: "future thing", backlog: true };
      s.tasks.B2 = { id: "B2", initiative: "mig", title: "another future", backlog: true };
      s.tasks.R1 = { id: "R1", initiative: "mig", title: "ready thing" };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    assert.ok(Array.isArray(out.backlog));
    const ids = out.backlog.map((t) => t.id).sort();
    assert.deepEqual(ids, ["B1", "B2"]);
    assert.equal(out.backlog[0].title, "future thing");
  } finally {
    await rmTempProject(dir);
  }
});

test("status: counts include backlog per initiative", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.B1 = { id: "B1", initiative: "mig", title: "b1", backlog: true };
      s.tasks.R1 = { id: "R1", initiative: "mig", title: "r1" };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    assert.equal(out.counts.mig.backlog, 1);
    assert.equal(out.counts.mig.ready, 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("tasks: a backlog task is listed with status 'backlog'", async () => {
  const { default: tasks } = await importFresh("./commands/tasks.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", initiative: "mig", title: "future", backlog: true };
      return s;
    });
    const out = await tasks({ statePath: dir, flags: {} });
    const t1 = out.find((t) => t.id === "T1");
    assert.equal(t1.status, "backlog");
  } finally {
    await rmTempProject(dir);
  }
});

test("tasks: --status backlog filters to only backlog tasks", async () => {
  const { default: tasks } = await importFresh("./commands/tasks.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", initiative: "mig", title: "future", backlog: true };
      s.tasks.T2 = { id: "T2", initiative: "mig", title: "ready" };
      return s;
    });
    const out = await tasks({ statePath: dir, flags: { status: "backlog" } });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "T1");
  } finally {
    await rmTempProject(dir);
  }
});

// --- update ---

test("update: --backlog true on a ready task sets the flag", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "x" };
      return s;
    });
    await update({ statePath: dir, flags: { as: "a", backlog: "true" }, positional: ["T1"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.backlog, true);
  } finally {
    await rmTempProject(dir);
  }
});

test("update: --backlog false on a backlog task removes the flag", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const { updateState, readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "x", backlog: true };
      return s;
    });
    await update({ statePath: dir, flags: { as: "a", backlog: "false" }, positional: ["T1"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.backlog, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("update: --backlog with invalid value rejects", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "x" };
      return s;
    });
    await assert.rejects(
      update({ statePath: dir, flags: { as: "a", backlog: "yeah" }, positional: ["T1"] }),
      /backlog/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

// --- pre-claim: backlog task is not claimable ---

test("pre-claim: backlog task reports derived_status='backlog', can_claim=false", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "future", backlog: true };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: {}, positional: ["T1"] });
    assert.equal(out.derived_status, "backlog");
    assert.equal(out.can_claim, false);
    assert.ok(out.blockers.some((b) => /backlog/i.test(b)));
  } finally {
    await rmTempProject(dir);
  }
});
