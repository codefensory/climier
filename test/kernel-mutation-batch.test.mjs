import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  createTempProject,
  rmTempProject,
  readState as readStateHelper,
  writeState as writeStateHelper,
  stateFilePath,
} from "./helpers.mjs";
import { createBuiltinOperationRegistry, executeBatch } from "../src/application/operations/index.mjs";
import { mutate } from "../src/kernel/mutate.mjs";

const registry = createBuiltinOperationRegistry();

async function bootstrap(dir) {
  await writeStateHelper(dir, {
    version: 4,
    revision: 7,
    nodes: {
      T1: { id: "T1", kind: "resolvable", subkind: "task", title: "one", body: "one", acceptance: "one", initiative: "kernel", status: "open", revision: 3 },
      T2: { id: "T2", kind: "resolvable", subkind: "task", title: "two", body: "two", acceptance: "two", initiative: "kernel", status: "open", revision: 1 },
    },
    edges: [{ from: "T1", to: "T2", type: "BLOCKS" }],
    initiatives: { kernel: { desc: "kernel", created_at: "2026-01-01T00:00:00.000Z" } },
    log: [],
  });
}

const repair = [
  {
    op: "task.create",
    input: { id: "T3", initiative: "kernel", title: "three", body: "three", acceptance: "three" },
  },
  { op: "edge.remove", input: { from: "T1", to: "T2", type: "BLOCKS" } },
  { op: "edge.add", input: { from: "T1", to: "T3", type: "BLOCKS" } },
  { op: "edge.add", input: { from: "T3", to: "T2", type: "BLOCKS" } },
];

test("core batch composes built-ins on one draft and writes one core.batch revision/log", async () => {
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const out = await executeBatch({
      projectDir: dir,
      actor: "alice",
      if_state_revision: 7,
      operations: repair,
      source: { registry, mutate },
    });
    assert.equal(out.ok, true);
    assert.equal(out.revision_before, 7);
    assert.equal(out.revision_after, 8);
    assert.equal(out.results.length, 4);
    assert.deepEqual(out.results.map((entry) => entry.op), repair.map((entry) => entry.op));

    const state = await readStateHelper(dir);
    assert.deepEqual(state.edges, [
      { from: "T1", to: "T3", type: "BLOCKS" },
      { from: "T3", to: "T2", type: "BLOCKS" },
    ]);
    assert.equal(state.nodes.T3.revision, 1);
    assert.equal(state.revision, 8);
    assert.equal(state.log.length, 1);
    assert.equal(state.log[0].action, "core.batch");
    assert.equal(state.log[0].agent, "alice");
    assert.equal(state.log[0].operations.length, 4);
    assert.deepEqual(state.log[0].operations.map(({ op }) => op), repair.map(({ op }) => op));
  } finally {
    await rmTempProject(dir);
  }
});

test("core batch rolls back every draft change when a later operation fails", async () => {
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const before = await fs.readFile(stateFilePath(dir));
    await assert.rejects(
      executeBatch({
        projectDir: dir,
        actor: "alice",
        if_state_revision: 7,
        operations: [
          ...repair.slice(0, 3),
          { op: "edge.add", input: { from: "T1", to: "T3", type: "BLOCKS" } },
        ],
        source: { registry, mutate },
      }),
      (error) => {
        assert.equal(error.code, "BATCH_OPERATION_FAILED");
        assert.equal(error.details.operation_index, 3);
        assert.equal(error.details.op, "edge.add");
        assert.equal(error.details.cause.code, "DUPLICATE_EDGE");
        return true;
      },
    );
    const after = await fs.readFile(stateFilePath(dir));
    assert.deepEqual(after, before);
    const state = await readStateHelper(dir);
    assert.equal(state.revision, 7);
    assert.equal(state.log.length, 0);
    assert.equal(state.nodes.T3, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("core batch with only no-ops keeps revision and log unchanged", async () => {
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const before = await fs.readFile(stateFilePath(dir));
    const out = await executeBatch({
      projectDir: dir,
      actor: "alice",
      if_state_revision: 7,
      operations: [{ op: "edge.remove", input: { from: "missing", to: "also-missing", type: "BLOCKS" } }],
      source: { registry, mutate },
    });
    assert.equal(out.ok, true);
    assert.equal(out.revision_before, 7);
    assert.equal(out.revision_after, 7);
    assert.equal(out.results[0].idempotent, true);
    assert.deepEqual(await fs.readFile(stateFilePath(dir)), before);
  } finally {
    await rmTempProject(dir);
  }
});

test("core batch checks global CAS before preparing any operation", async () => {
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    let prepared = false;
    const customRegistry = {
      lookup() {
        prepared = true;
        return { provider: { prepare: async () => ({ target: { id: "T1" } }), apply: async () => ({}) } };
      },
    };
    await assert.rejects(
      executeBatch({
        projectDir: dir,
        actor: "alice",
        if_state_revision: 6,
        operations: [{ op: "not-built-in", input: {} }],
        source: { registry: customRegistry, mutate },
      }),
      (error) => error.code === "STATE_REVISION_CONFLICT",
    );
    assert.equal(prepared, false);
  } finally {
    await rmTempProject(dir);
  }
});
