import test from "node:test";
import assert from "node:assert/strict";
import { applyRemoteChanges } from "../src/application/operations/index.ts";
import { readSqliteChangesSince, readSqliteState, writeSqliteState } from "../src/storage/sqlite/store.ts";
import { stateFile } from "../src/storage/state.ts";
import { createTempProject, rmTempProject } from "./helpers.ts";

test("SQLite changes since a revision are exact and replay to the current snapshot", async () => {
  const projectDir = await createTempProject();
  try {
    const file = stateFile(projectDir);
    const base = { version: 1, revision: 4, nodes: {}, edges: [], initiatives: {}, log: [] };
    await writeSqliteState(file, base);
    const firstLog = { action: "task.create", agent: "alice", node: "T-1" };
    await writeSqliteState(file, {
      ...base,
      revision: 5,
      nodes: {
        "T-1": { id: "T-1", kind: "resolvable", subkind: "task", status: "open", title: "One", body: "body" },
        "T-3": { id: "T-3", kind: "resolvable", subkind: "task", status: "open", title: "Unchanged", body: "same" },
        "T-gone": { id: "T-gone", kind: "resolvable", subkind: "task", status: "open", title: "Removed", body: "" },
      },
      initiatives: { core: { desc: "Core" } },
      plugins: { demo: { state: "before" } },
      log: [firstLog],
    });
    const secondLog = { action: "task.update", agent: "alice", node: "T-1" };
    await writeSqliteState(file, {
      version: 1,
      revision: 6,
      nodes: {
        "T-1": { id: "T-1", kind: "resolvable", subkind: "task", status: "open", title: "Updated", body: "body" },
        "T-2": { id: "T-2", kind: "resolvable", subkind: "task", status: "open", title: "Second", body: "" },
        "T-3": { id: "T-3", kind: "resolvable", subkind: "task", status: "open", title: "Unchanged", body: "same" },
      },
      edges: [{ from: "T-1", to: "T-2", type: "BLOCKS" }],
      initiatives: { core: { desc: "Core updated" } },
      plugins: { demo: { state: "after" } },
      log: [firstLog, secondLog],
    });

    const sinceFive = await readSqliteChangesSince(file, 5);
    assert.deepEqual(sinceFive.changes.map(({ revision }) => revision), [6]);
    assert.deepEqual(Object.keys(sinceFive.changes[0].delta.nodes.upsert).toSorted(), ["T-1", "T-2"]);
    assert.deepEqual(sinceFive.changes[0].delta.nodes.remove, ["T-gone"]);
    assert.deepEqual(sinceFive.changes[0].delta.initiatives.upsert, { core: { desc: "Core updated" } });
    assert.deepEqual(sinceFive.changes[0].delta.set.plugins, { demo: { state: "after" } });
    assert.equal(sinceFive.reset_required, false);
    const baseFive = {
      version: 1,
      revision: 5,
      nodes: {
        "T-1": { id: "T-1", kind: "resolvable", subkind: "task", status: "open", title: "One", body: "body" },
        "T-3": { id: "T-3", kind: "resolvable", subkind: "task", status: "open", title: "Unchanged", body: "same" },
        "T-gone": { id: "T-gone", kind: "resolvable", subkind: "task", status: "open", title: "Removed", body: "" },
      },
      edges: [],
      initiatives: { core: { desc: "Core" } },
      plugins: { demo: { state: "before" } },
      log: [firstLog],
    };
    assert.deepEqual(applyRemoteChanges(baseFive, sinceFive), await readSqliteState(file));

    const sinceFour = await readSqliteChangesSince(file, 4);
    assert.deepEqual(sinceFour.changes.map(({ revision }) => revision), [5, 6]);
    assert.equal(sinceFour.reset_required, false);
    assert.deepEqual(applyRemoteChanges(base, sinceFour), await readSqliteState(file));
    assert.deepEqual((await readSqliteChangesSince(file, 6)).changes, []);
  } finally {
    await rmTempProject(projectDir);
  }
});

test("SQLite delta history requires a snapshot before the current retained base", async () => {
  const projectDir = await createTempProject();
  try {
    const file = stateFile(projectDir);
    await writeSqliteState(file, { version: 1, revision: 7, nodes: {}, edges: [], initiatives: {}, log: [{ action: "old" }] });
    await writeSqliteState(file, { version: 1, revision: 8, nodes: {}, edges: [], initiatives: {}, log: [{ action: "checkpoint.summary" }, { action: "state.compact" }] });
    const result = await readSqliteChangesSince(file, 6);
    assert.equal(result.reset_required, true);
    assert.deepEqual(result.changes, []);
    assert.equal(result.revision, 8);
    assert.throws(() => applyRemoteChanges({ version: 1, revision: 7, nodes: {}, edges: [], initiatives: {}, log: [{ action: "old" }] }, result), {
      code: "REMOTE_SNAPSHOT_REQUIRED",
    });
  } finally {
    await rmTempProject(projectDir);
  }
});
