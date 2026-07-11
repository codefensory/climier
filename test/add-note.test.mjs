// add-note.test.mjs: append a note to a task's running thread. Any status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState } from "./helpers.mjs";

test("add-note: appends a note to a ready task", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t", initiative: "x" };
      return s;
    });
    const out = await addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T1", "investigated, see RFC-042"] });
    assert.ok(Array.isArray(out.task.notes));
    assert.equal(out.task.notes.length, 1);
    assert.equal(out.task.notes[0].text, "investigated, see RFC-042");
    assert.equal(out.task.notes[0].agent, "alice");
    assert.ok(out.task.notes[0].ts, "note should have a timestamp");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: multiple notes accumulate as an array", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t" };
      return s;
    });
    await addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T1", "first"] });
    await addNote({ statePath: dir, flags: { as: "bob" }, positional: ["T1", "second"] });
    await addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T1", "third"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.notes.length, 3);
    assert.deepEqual(s.tasks.T1.notes.map((n) => n.text), ["first", "second", "third"]);
    assert.deepEqual(s.tasks.T1.notes.map((n) => n.agent), ["alice", "bob", "alice"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: works on an in_progress task", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t", status: "in_progress", claimed_by: "bob" };
      return s;
    });
    const out = await addNote({ statePath: dir, flags: { as: "bob" }, positional: ["T1", "found a blocker"] });
    assert.equal(out.task.notes[0].text, "found a blocker");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: works on a done task", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t", status: "done" };
      return s;
    });
    const out = await addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T1", "follow-up: also check F2.T1"] });
    assert.equal(out.task.notes[0].text, "follow-up: also check F2.T1");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: works on an archived task", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t", status: "archived" };
      return s;
    });
    const out = await addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T1", "actually we might want this back"] });
    assert.equal(out.task.notes[0].text, "actually we might want this back");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: fails if text is empty", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t" };
      return s;
    });
    await assert.rejects(
      addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T1", "   "] }),
      /note text required/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: fails if task does not exist", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t" };
      return s;
    });
    await assert.rejects(
      addNote({ statePath: dir, flags: { as: "alice" }, positional: ["NOPE", "hi"] }),
      /not found/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: fails if state missing", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T1", "hi"] }),
      /state file missing/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: requires --as", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t" };
      return s;
    });
    await assert.rejects(
      addNote({ statePath: dir, flags: {}, positional: ["T1", "hi"] }),
      /--as/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: appends a log entry with action=add-note", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t" };
      return s;
    });
    await addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T1", "checkpoint"] });
    const s = await readState(dir);
    const last = s.log[s.log.length - 1];
    assert.equal(last.action, "add-note");
    assert.equal(last.agent, "alice");
    assert.equal(last.task, "T1");
    assert.equal(last.note, "checkpoint");
  } finally {
    await rmTempProject(dir);
  }
});
