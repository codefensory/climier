import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  createTempProject,
  rmTempProject,
  readState,
  writeState,
  stateFilePath,
  importFresh,
} from "./helpers.mjs";

function baseState() {
  return {
    version: 4,
    revision: 7,
    nodes: {
      T1: { id: "T1", kind: "resolvable", subkind: "task", title: "one", body: "one", acceptance: "one", initiative: "plugin", status: "open", revision: 1 },
      T2: { id: "T2", kind: "resolvable", subkind: "task", title: "two", body: "two", acceptance: "two", initiative: "plugin", status: "open", revision: 1 },
    },
    edges: [{ from: "T1", to: "T2", type: "BLOCKS" }],
    initiatives: { plugin: { desc: "plugin", created_at: "2026-01-01T00:00:00.000Z" } },
    log: [],
  };
}

async function makeApi(dir) {
  const { createApi } = await importFresh("../src/plugins/api.mjs");
  return createApi({ projectDir: dir, agent: "plugin-agent", pluginId: "example.batch" });
}

const repair = [
  { op: "task.create", input: { id: "T3", initiative: "plugin", title: "three", body: "three", acceptance: "three" } },
  { op: "edge.remove", input: { from: "T1", to: "T2", type: "BLOCKS" } },
  { op: "edge.add", input: { from: "T1", to: "T3", type: "BLOCKS" } },
  { op: "edge.add", input: { from: "T3", to: "T2", type: "BLOCKS" } },
];

test("api.core.batch applies a declarative repair with host identity and one log", async () => {
  const dir = await createTempProject();
  try {
    await writeState(dir, baseState());
    const api = await makeApi(dir);
    const out = await api.core.batch({ if_state_revision: 7, operations: repair });

    assert.equal(out.ok, true);
    assert.equal(out.revision_before, 7);
    assert.equal(out.revision_after, 8);
    assert.deepEqual(out.results.map(({ op }) => op), repair.map(({ op }) => op));
    const state = await readState(dir);
    assert.deepEqual(state.edges, [
      { from: "T1", to: "T3", type: "BLOCKS" },
      { from: "T3", to: "T2", type: "BLOCKS" },
    ]);
    assert.equal(state.nodes.T3.revision, 1);
    assert.equal(state.log.length, 1);
    assert.equal(state.log[0].action, "core.batch");
    assert.equal(state.log[0].agent, "plugin-agent");
    assert.equal(state.log[0].plugin_id, "example.batch");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.batch rolls back on an operation failure and reports its index/op", async () => {
  const dir = await createTempProject();
  try {
    await writeState(dir, baseState());
    const before = await fs.readFile(stateFilePath(dir));
    const api = await makeApi(dir);
    await assert.rejects(
      api.core.batch({
        if_state_revision: 7,
        operations: [...repair.slice(0, 3), { op: "edge.add", input: { from: "T1", to: "T3", type: "BLOCKS" } }],
      }),
      (error) => error.code === "PLUGIN_CORE_ACTION_FAILED" &&
        error.details.op === "core.batch" &&
        error.details.cause.code === "BATCH_OPERATION_FAILED" &&
        error.details.cause.details.operation_index === 3,
    );
    assert.deepEqual(await fs.readFile(stateFilePath(dir)), before);
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.batch rejects stale global CAS before any operation", async () => {
  const dir = await createTempProject();
  try {
    await writeState(dir, baseState());
    const api = await makeApi(dir);
    await assert.rejects(
      api.core.batch({ if_state_revision: 6, operations: repair }),
      (error) => error.code === "PLUGIN_CORE_ACTION_FAILED" &&
        error.details.cause.code === "STATE_REVISION_CONFLICT",
    );
    const state = await readState(dir);
    assert.equal(state.revision, 7);
    assert.equal(state.log.length, 0);
    assert.equal(state.nodes.T3, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core.batch accepts only the declarative envelope", async () => {
  const dir = await createTempProject();
  try {
    await writeState(dir, baseState());
    const api = await makeApi(dir);
    for (const input of [null, [], {}, { operations: [] }]) {
      await assert.rejects(
        api.core.batch(input),
        (error) => error.code === "PLUGIN_CORE_INVALID_OPERATION",
      );
    }
    await assert.rejects(
      api.core.batch({ operations: [{ op: "edge.remove", input: {}, actor: "spoof" }] }),
      (error) => error.code === "PLUGIN_CORE_INVALID_OPERATION",
    );
  } finally {
    await rmTempProject(dir);
  }
});
