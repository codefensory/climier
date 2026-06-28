// graph view: print the DAG as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("graph: returns a list of lines with id, title, deps, status", async () => {
  const { default: graph } = await importFresh("./commands/graph.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "root" };
      s.tasks.T2 = { id: "T2", title: "child", depends_on: ["T1"] };
      return s;
    });
    const lines = await graph({ statePath: dir, flags: {} });
    assert.ok(Array.isArray(lines));
    assert.ok(lines.length >= 2);
    const flat = lines.join("\n");
    assert.match(flat, /T1/);
    assert.match(flat, /T2/);
  } finally {
    await rmTempProject(dir);
  }
});

test("graph: shows decision nodes too", async () => {
  const { default: graph } = await importFresh("./commands/graph.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1", title: "big choice" };
      s.tasks.T1 = { id: "T1", depends_on: ["D1"] };
      return s;
    });
    const lines = await graph({ statePath: dir, flags: {} });
    const flat = lines.join("\n");
    assert.match(flat, /D1.*big choice/);
  } finally {
    await rmTempProject(dir);
  }
});
