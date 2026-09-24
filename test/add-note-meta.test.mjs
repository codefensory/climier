// TDD for ADR-022 piece 10: add-note --meta stores structured note metadata.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

async function v2Project() {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
  const dir = await createTempProject();
  await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
  await addInit({ statePath: dir, flags: { desc: "auth" }, positional: ["auth"] });
  return dir;
}

async function addTask(dir, id) {
  const { default: addNode } = await importFresh("./cli/commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: { kind: "resolvable", subkind: "task", title: id, initiative: "auth" },
  });
}

async function addNote(dir, positional, flags) {
  const { default: fn } = await importFresh("./cli/commands/add-note.mjs");
  return fn({ statePath: dir, projectDir: dir, positional, flags });
}

test("add-note --meta stores meta on the appended note", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-n-1");
    const out = await addNote(dir, ["T-n-1", "found", "a", "clue"], { as: "alice", meta: '{"source":"logs"}' });
    const notes = out.node.notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].text, "found a clue");
    assert.equal(notes[0].agent, "alice");
    assert.deepEqual(notes[0].meta, { source: "logs" });
  } finally { await rmTempProject(dir); }
});

test("add-note without --meta leaves notes without meta", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-n-2");
    const out = await addNote(dir, ["T-n-2", "plain"], { as: "alice" });
    assert.equal(out.node.notes.length, 1);
    assert.equal(out.node.notes[0].meta, undefined);
  } finally { await rmTempProject(dir); }
});

test("add-note --meta rejects non-object JSON", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-n-3");
    await assert.rejects(
      addNote(dir, ["T-n-3", "x"], { as: "alice", meta: "42" }),
      (err) => /--meta must be a JSON object/.test(err.message),
    );
  } finally { await rmTempProject(dir); }
});
