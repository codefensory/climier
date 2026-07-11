// update.test.mjs: edit a ready or archived task's mutable fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState } from "./helpers.mjs";

test("update: changes a ready task's title", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "old", initiative: "x" };
      return s;
    });
    const out = await update({ statePath: dir, flags: { title: "new", as: "alice" }, positional: ["T1"] });
    assert.equal(out.task.title, "new");
    const s = await readState(dir);
    assert.equal(s.tasks.T1.title, "new");
  } finally {
    await rmTempProject(dir);
  }
});

test("update: sets body on a ready task", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t", initiative: "x" };
      return s;
    });
    const out = await update({ statePath: dir, flags: { body: "## Spec\n\nThe thing must...", as: "alice" }, positional: ["T1"] });
    assert.equal(out.task.body, "## Spec\n\nThe thing must...");
  } finally {
    await rmTempProject(dir);
  }
});

test("update: changes multiple fields at once", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "old", initiative: "x", skills: ["ts"], effort: "s", domain: "api" };
      return s;
    });
    const out = await update({
      statePath: dir,
      flags: { title: "new", skills: "ts,sql", effort: "m", domain: "db", as: "alice" },
      positional: ["T1"],
    });
    assert.equal(out.task.title, "new");
    assert.deepEqual(out.task.skills, ["ts", "sql"]);
    assert.equal(out.task.effort, "m");
    assert.equal(out.task.domain, "db");
  } finally {
    await rmTempProject(dir);
  }
});

test("update: clears skills when --skills '' (empty)", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t", initiative: "x", skills: ["ts", "sql"] };
      return s;
    });
    const out = await update({ statePath: dir, flags: { skills: "", as: "alice" }, positional: ["T1"] });
    assert.deepEqual(out.task.skills, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("update: does not change fields that were not passed", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "keep", initiative: "x", effort: "s" };
      return s;
    });
    const out = await update({ statePath: dir, flags: { title: "new", as: "alice" }, positional: ["T1"] });
    assert.equal(out.task.effort, "s");
  } finally {
    await rmTempProject(dir);
  }
});

test("update: works on an archived task", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "old", status: "archived" };
      return s;
    });
    const out = await update({ statePath: dir, flags: { title: "new", as: "alice" }, positional: ["T1"] });
    assert.equal(out.task.title, "new");
    assert.equal(out.task.status, "archived");
  } finally {
    await rmTempProject(dir);
  }
});

test("update: fails on an in_progress task", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t", status: "in_progress", claimed_by: "bob" };
      return s;
    });
    await assert.rejects(
      update({ statePath: dir, flags: { title: "new", as: "alice" }, positional: ["T1"] }),
      /not.*ready.*archived|in_progress/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("update: fails on a done task", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t", status: "done" };
      return s;
    });
    await assert.rejects(
      update({ statePath: dir, flags: { title: "new", as: "alice" }, positional: ["T1"] }),
      /not.*ready.*archived|done/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("update: fails if task does not exist", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t" };
      return s;
    });
    await assert.rejects(
      update({ statePath: dir, flags: { title: "new", as: "alice" }, positional: ["NOPE"] }),
      /not found/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("update: fails if no editable fields are given", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t" };
      return s;
    });
    await assert.rejects(
      update({ statePath: dir, flags: { as: "alice" }, positional: ["T1"] }),
      /at least one|required|nothing to update/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("update: requires --as (for audit log)", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t" };
      return s;
    });
    await assert.rejects(
      update({ statePath: dir, flags: { title: "new" }, positional: ["T1"] }),
      /--as/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("update: appends a log entry with action=update and changes diff", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "old", initiative: "x" };
      return s;
    });
    await update({ statePath: dir, flags: { title: "new", as: "alice" }, positional: ["T1"] });
    const s = await readState(dir);
    const last = s.log[s.log.length - 1];
    assert.equal(last.action, "update");
    assert.equal(last.agent, "alice");
    assert.equal(last.task, "T1");
    assert.ok(last.changes, "log entry should have a changes field");
    assert.deepEqual(last.changes.title, { from: "old", to: "new" });
  } finally {
    await rmTempProject(dir);
  }
});

test("update: logs a diff for every changed field", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "a", initiative: "x", effort: "s" };
      return s;
    });
    await update({ statePath: dir, flags: { title: "b", effort: "m", as: "alice" }, positional: ["T1"] });
    const s = await readState(dir);
    const last = s.log[s.log.length - 1];
    assert.deepEqual(last.changes.title, { from: "a", to: "b" });
    assert.deepEqual(last.changes.effort, { from: "s", to: "m" });
  } finally {
    await rmTempProject(dir);
  }
});

test("update: works on a blocked task (no persisted status)", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const { derive } = await importFresh("./dag.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t", initiative: "x" };
      s.tasks.T2 = { id: "T2", title: "depends on T1", initiative: "x", depends_on: ["T1"] };
      return s;
    });
    // T2 is blocked (depends on T1 which is ready). Confirm.
    assert.ok(derive(await readState(dir)).blocked.includes("T2"));
    const out = await update({ statePath: dir, flags: { title: "still blocked but new title", as: "alice" }, positional: ["T2"] });
    assert.equal(out.task.title, "still blocked but new title");
    const s = await readState(dir);
    assert.equal(s.tasks.T2.title, "still blocked but new title");
    // Still blocked: no change to deps.
    assert.ok(derive(s).blocked.includes("T2"));
  } finally {
    await rmTempProject(dir);
  }
});

test("update: --body on a blocked task is editable too", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const { derive } = await importFresh("./dag.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "a", initiative: "x" };
      s.tasks.T2 = { id: "T2", title: "blocked", initiative: "x", depends_on: ["T1"], body: "old" };
      return s;
    });
    assert.ok(derive(await readState(dir)).blocked.includes("T2"));
    const out = await update({ statePath: dir, flags: { body: "## Revised spec\n\ndetails...", as: "alice" }, positional: ["T2"] });
    assert.equal(out.task.body, "## Revised spec\n\ndetails...");
    const s = await readState(dir);
    assert.equal(s.tasks.T2.body, "## Revised spec\n\ndetails...");
    assert.ok(derive(s).blocked.includes("T2"));
  } finally {
    await rmTempProject(dir);
  }
});

test("update: --depends-on rewrites the dependency list", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "a", initiative: "x" };
      s.tasks.T2 = { id: "T2", title: "b", initiative: "x" };
      s.tasks.T3 = { id: "T3", title: "c", initiative: "x", depends_on: ["T1"] };
      return s;
    });
    const out = await update({ statePath: dir, flags: { "depends-on": "T2", as: "alice" }, positional: ["T3"] });
    assert.deepEqual(out.task.depends_on, ["T2"]);
    const s = await readState(dir);
    assert.deepEqual(s.tasks.T3.depends_on, ["T2"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("update: --depends-on that drops the last blocker makes the task ready", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const { derive } = await importFresh("./dag.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "a", initiative: "x" };
      s.tasks.T2 = { id: "T2", title: "b", initiative: "x", depends_on: ["T1"] };
      return s;
    });
    assert.ok(derive(await readState(dir)).blocked.includes("T2"));
    // Drop the only dep -> T2 becomes ready.
    await update({ statePath: dir, flags: { "depends-on": "", as: "alice" }, positional: ["T2"] });
    const s = await readState(dir);
    assert.deepEqual(s.tasks.T2.depends_on, []);
    assert.ok(derive(s).ready.includes("T2"));
    assert.ok(!derive(s).blocked.includes("T2"));
  } finally {
    await rmTempProject(dir);
  }
});

test("update: --depends-on '' clears the deps to []", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "a", initiative: "x" };
      s.tasks.T2 = { id: "T2", title: "b", initiative: "x", depends_on: ["T1"] };
      return s;
    });
    const out = await update({ statePath: dir, flags: { "depends-on": "", as: "alice" }, positional: ["T2"] });
    assert.deepEqual(out.task.depends_on, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("update: --depends-on fails if any dep is unknown", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "a", initiative: "x" };
      return s;
    });
    await assert.rejects(
      update({ statePath: dir, flags: { "depends-on": "T1,NOPE", as: "alice" }, positional: ["T1"] }),
      /depends-on.*NOPE.*not found|not found in tasks or decisions/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("update: --depends-on accepts decision ids as well as task ids", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const { derive } = await importFresh("./dag.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "a", initiative: "x" };
      s.decisions.D1 = { id: "D1", title: "pick a lib", status: "decided" };
      s.tasks.T2 = { id: "T2", title: "b", initiative: "x", depends_on: ["T1"] };
      return s;
    });
    // Drop the task dep, add a decision dep. D1 is decided, so T2 becomes ready.
    await update({ statePath: dir, flags: { "depends-on": "D1", as: "alice" }, positional: ["T2"] });
    const s = await readState(dir);
    assert.deepEqual(s.tasks.T2.depends_on, ["D1"]);
    assert.ok(derive(s).ready.includes("T2"));
  } finally {
    await rmTempProject(dir);
  }
});

test("update: --depends-on logs the diff with from/to arrays", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "a", initiative: "x" };
      s.tasks.T2 = { id: "T2", title: "b", initiative: "x" };
      s.tasks.T3 = { id: "T3", title: "c", initiative: "x", depends_on: ["T1"] };
      return s;
    });
    await update({ statePath: dir, flags: { "depends-on": "T2", as: "alice" }, positional: ["T3"] });
    const s = await readState(dir);
    const last = s.log[s.log.length - 1];
    assert.deepEqual(last.changes["depends-on"], { from: ["T1"], to: ["T2"] });
  } finally {
    await rmTempProject(dir);
  }
});

test("update: --depends-on keeps in_progress / done tasks locked (status guard still wins)", async () => {
  const { default: update } = await importFresh("./commands/update.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "a", status: "in_progress", claimed_by: "bob" };
      return s;
    });
    await assert.rejects(
      update({ statePath: dir, flags: { "depends-on": "", as: "alice" }, positional: ["T1"] }),
      /in_progress/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});
