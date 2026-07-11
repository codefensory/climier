// show.test.mjs: returns the raw node. body and notes must be included if present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("show: returns task with body and notes when present", async () => {
  const { default: show } = await importFresh("./commands/show.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = {
        id: "T1",
        title: "t",
        initiative: "x",
        body: "## Spec\n\nLong markdown doc",
        notes: [{ ts: "2026-01-01T00:00:00Z", agent: "alice", text: "first" }],
      };
      return s;
    });
    const out = await show({ statePath: dir, flags: {}, positional: ["T1"] });
    assert.equal(out.type, "task");
    assert.equal(out.node.body, "## Spec\n\nLong markdown doc");
    assert.equal(out.node.notes.length, 1);
    assert.equal(out.node.notes[0].text, "first");
  } finally {
    await rmTempProject(dir);
  }
});

test("show: returns task even when body and notes are absent", async () => {
  const { default: show } = await importFresh("./commands/show.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t" };
      return s;
    });
    const out = await show({ statePath: dir, flags: {}, positional: ["T1"] });
    assert.equal(out.type, "task");
    assert.equal(out.node.body, undefined);
    assert.equal(out.node.notes, undefined);
  } finally {
    await rmTempProject(dir);
  }
});
