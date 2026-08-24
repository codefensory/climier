// add-note: append a note to a node's running thread. Any status (open/in_progress/done/...).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState } from "./helpers.mjs";

function seedTask(extra = {}) {
  return async (dir, id = "T1") => {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.nodes[id] = {
        id,
        kind: "resolvable",
        subkind: "task",
        title: "t",
        ...extra,
      };
      return s;
    });
  };
}

test("add-note: appends a note to an open task and returns the node envelope", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    await seedTask()(dir);
    const out = await addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T1", "investigated, see RFC-042"] });
    assert.ok(out.node);
    assert.equal(out.node.id, "T1");
    assert.ok(Array.isArray(out.node.notes));
    assert.equal(out.node.notes.length, 1);
    assert.equal(out.node.notes[0].text, "investigated, see RFC-042");
    assert.equal(out.node.notes[0].agent, "alice");
    assert.ok(out.node.notes[0].ts);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: multiple notes accumulate on the same node", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    await seedTask()(dir);
    await addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T1", "first"] });
    await addNote({ statePath: dir, flags: { as: "bob" }, positional: ["T1", "second"] });
    await addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T1", "third"] });
    const s = await readState(dir);
    const notes = s.nodes.T1.notes;
    assert.equal(notes.length, 3);
    assert.deepEqual(notes.map((n) => n.text), ["first", "second", "third"]);
    assert.deepEqual(notes.map((n) => n.agent), ["alice", "bob", "alice"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: works on an in_progress task", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    await seedTask({ status: "in_progress", claim: { by: "bob", at: Date.now() } })(dir);
    const out = await addNote({ statePath: dir, flags: { as: "bob" }, positional: ["T1", "found a blocker"] });
    assert.equal(out.node.notes[0].text, "found a blocker");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: works on a done task", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    await seedTask({ status: "done", done_by: "alice", done_at: "2026-01-01T00:00:00.000Z" })(dir);
    const out = await addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T1", "follow-up: also check F2.T1"] });
    assert.equal(out.node.notes[0].text, "follow-up: also check F2.T1");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: works on an archived task", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    await seedTask({ status: "archived" })(dir);
    const out = await addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T1", "actually we might want this back"] });
    assert.equal(out.node.notes[0].text, "actually we might want this back");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: fails if text is empty", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    await seedTask()(dir);
    await assert.rejects(
      addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T1", "   "] }),
      /note text required/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: fails if node does not exist", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    await seedTask()(dir);
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
    await seedTask()(dir);
    await assert.rejects(
      addNote({ statePath: dir, flags: {}, positional: ["T1", "hi"] }),
      /--as|MISSING_AGENT/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: appends a log entry with action=add-note, agent=alice, node=T1", async () => {
  const { default: addNote } = await importFresh("./commands/add-note.mjs");
  const dir = await createTempProject();
  try {
    await seedTask()(dir);
    await addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T1", "checkpoint"] });
    const s = await readState(dir);
    const last = s.log[s.log.length - 1];
    assert.equal(last.action, "add-note");
    assert.equal(last.agent, "alice");
    assert.equal(last.node, "T1");
    assert.equal(last.note, "checkpoint");
  } finally {
    await rmTempProject(dir);
  }
});