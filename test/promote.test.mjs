// promote: remove the backlog flag from a task. Atomic + audited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

async function setupBacklog(dir) {
  const { updateState } = await importFresh("./state.mjs");
  await updateState(dir, (s) => {
    s.tasks.T1 = { id: "T1", title: "future", backlog: true };
    return s;
  });
}

test("promote: removes the backlog flag and returns { task }", async () => {
  const { default: promote } = await importFresh("./commands/promote.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await setupBacklog(dir);
    const out = await promote({ statePath: dir, flags: { as: "alice" }, positional: ["T1"] });
    assert.ok(out.task);
    assert.equal(out.task.id, "T1");
    assert.equal(out.task.backlog, undefined);
    const s = await readState(dir);
    assert.equal(s.tasks.T1.backlog, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("promote: requires --as", async () => {
  const { default: promote } = await importFresh("./commands/promote.mjs");
  const dir = await createTempProject();
  try {
    await setupBacklog(dir);
    await assert.rejects(
      promote({ statePath: dir, flags: {}, positional: ["T1"] }),
      /--as/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("promote: --as with no value (boolean true) rejects", async () => {
  const { default: promote } = await importFresh("./commands/promote.mjs");
  const dir = await createTempProject();
  try {
    await setupBacklog(dir);
    await assert.rejects(
      promote({ statePath: dir, flags: { as: true }, positional: ["T1"] }),
      /--as/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("promote: fails on non-existent task", async () => {
  const { default: promote } = await importFresh("./commands/promote.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    // Set up an empty-but-valid state so the 'not found' branch is reached.
    await updateState(dir, (s) => {
      s.tasks.OTHER = { id: "OTHER", title: "something else" };
      return s;
    });
    await assert.rejects(
      promote({ statePath: dir, flags: { as: "a" }, positional: ["NOPE"] }),
      /not found/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("promote: fails on a task that is not in backlog", async () => {
  const { default: promote } = await importFresh("./commands/promote.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "ready task" };
      return s;
    });
    await assert.rejects(
      promote({ statePath: dir, flags: { as: "a" }, positional: ["T1"] }),
      /not in backlog/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("promote: fails on an in_progress task", async () => {
  const { default: promote } = await importFresh("./commands/promote.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "x" };
      return s;
    });
    await assert.rejects(
      promote({ statePath: dir, flags: { as: "a" }, positional: ["T1"] }),
      /in_progress/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("promote: fails on a done task", async () => {
  const { default: promote } = await importFresh("./commands/promote.mjs");
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "done" };
      return s;
    });
    await assert.rejects(
      promote({ statePath: dir, flags: { as: "a" }, positional: ["T1"] }),
      /done/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("promote: fails when state file is missing", async () => {
  const { default: promote } = await importFresh("./commands/promote.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      promote({ statePath: dir, flags: { as: "a" }, positional: ["T1"] }),
      /state file missing/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("promote: appends a log entry with action=promote, agent, task", async () => {
  const { default: promote } = await importFresh("./commands/promote.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await setupBacklog(dir);
    await promote({ statePath: dir, flags: { as: "alice" }, positional: ["T1"] });
    const s = await readState(dir);
    const entry = s.log.find((e) => e.action === "promote" && e.task === "T1");
    assert.ok(entry, "log should contain a promote entry");
    assert.equal(entry.agent, "alice");
  } finally {
    await rmTempProject(dir);
  }
});

test("promote: after promote, derive reports the task as ready (no deps) or blocked (unmet deps)", async () => {
  const { default: promote } = await importFresh("./commands/promote.mjs");
  const { derive } = await importFresh("./dag.mjs");
  const { updateState, readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    // Case A: no deps → becomes ready
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "future", backlog: true };
      return s;
    });
    await promote({ statePath: dir, flags: { as: "a" }, positional: ["T1"] });
    let r = derive(await readState(dir));
    assert.deepEqual(r.backlog, []);
    assert.deepEqual(r.ready, ["T1"]);

    // Case B: dep not met → becomes blocked
    await updateState(dir, (s) => {
      s.tasks.T2 = { id: "T2", title: "future 2", backlog: true, depends_on: ["T1"] };
      return s;
    });
    await promote({ statePath: dir, flags: { as: "a" }, positional: ["T2"] });
    r = derive(await readState(dir));
    assert.deepEqual(r.backlog, []);
    assert.equal(r.blocked.includes("T2"), true);
  } finally {
    await rmTempProject(dir);
  }
});
