import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  initProject,
  makeApi,
  createFirstTask,
  createSecondTask,
  addBlockingEdge,
  takeFirstTask,
  submitFirstTask,
  acceptFirstTask,
  addNoteToSecondTask,
  assertFullSliceState,
} from "./plugin-core-integration-helpers.ts";

test("plugin-core-integration: api.core.version is 1 and api.core.run is a function", async () => {
  const dir = await createTempProject();
  try {
    const api = await makeApi(dir);
    assert.equal(api.core.version, 1);
    assert.equal(typeof api.core.run, "function");

    assert.equal(typeof api.runtime, "object");
    assert.equal(typeof api.query, "object");
    assert.equal(typeof api.data, "object");
  } finally {
    await rmTempProject(dir);
  }
});

test("plugin-core-integration: full first slice leaves intact state and logs with plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    const api = await makeApi(dir, { agent: "alice", pluginId: "example.core" });
    await createFirstTask(api, dir);
    const created2 = await createSecondTask(api);
    await addBlockingEdge(api);
    await takeFirstTask(api, dir);
    await submitFirstTask(api, dir);
    await acceptFirstTask(api, dir);
    await addNoteToSecondTask(api, dir, created2);
    await assertFullSliceState(dir);
  } finally {
    await rmTempProject(dir);
  }
});

test("plugin-core-integration: history for a node touched via core.run reports plugin_id on the entries", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    const api = await makeApi(dir, { agent: "alice", pluginId: "example.core" });
    await api.core.run({
      op: "task.create",
      input: {
        id: "T-hist",
        initiative: "plugin-platform",
        title: "history task",
        body: "b",
        acceptance: "a",
        blocked_by: "",
      },
    });
    const taken = await api.core.run({ op: "task.take", input: { id: "T-hist" } });
    await api.core.run({
      op: "note.add",
      input: {
        id: "T-hist",
        text: "ctx",
        if_revision: taken.diff.updated[0].node.revision,
      },
    });
    const out = await api.query.history("T-hist");
    assert.equal(out.id, "T-hist");
    assert.ok(out.entries.length >= 3, "history must list at least 3 entries");
    for (const entry of out.entries) {
      assert.equal(entry.plugin_id, "example.core", `history entry missing plugin_id: ${JSON.stringify(entry)}`);
    }
  } finally {
    await rmTempProject(dir);
  }
});
