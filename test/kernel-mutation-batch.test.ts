import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  createTempProject,
  rmTempProject,
  readState as readStateRaw,
  writeCanonicalState as writeStateHelper,
  stateFilePath,
} from "./helpers.mjs";
import { createBuiltinOperationRegistry, executeBatch as executeBatchRaw } from "../src/application/operations/index.ts";
import { mutate } from "../src/kernel/mutate.ts";
import { bootstrapFencedState } from "../src/storage/ledger.ts";

const registry = createBuiltinOperationRegistry();

type NodeRecord = { id: string; revision: number; title?: string };
type Edge = { from: string; to: string; type: string };
type LogEntry = { action?: string; agent?: string; operations: Array<{ op: string }> };
type State = { version: number; fence_generation: number; revision: number; nodes: Record<string, NodeRecord>; edges: Edge[]; log: LogEntry[] };
type BatchResult = { ok: boolean; revision_before: number; revision_after: number; results: Array<Record<string, unknown>> };
type ErrorLike = { code?: string; details?: Record<string, unknown> };
function errorLike(error: unknown): ErrorLike {
  return (typeof error === "object" && error !== null ? error : {}) as ErrorLike;
}
function readStateHelper(dir: string): Promise<State> {
  return readStateRaw(dir) as Promise<State>;
}
function executeBatch(args: Parameters<typeof executeBatchRaw>[0]): Promise<BatchResult> {
  return executeBatchRaw(args) as Promise<BatchResult>;
}

async function verifyCanonicalBatch(dir: string, readFencedState: (dir: string) => Promise<State>) {
  const out = await executeBatch({
    projectDir: dir,
    actor: "alice",
    if_state_revision: 8,
    operations: repair,
    source: { registry, mutate },
  });
  assert.equal(out.revision_before, 8);
  assert.equal(out.revision_after, 9);
  const state = await readFencedState(dir);
  assert.equal(state.version, 1);
  assert.equal(state.fence_generation, 1);
  assert.equal(state.nodes.T3.revision, 9);
  assert.equal(state.revision, 9);
  assert.equal(state.log.length, 1);
}

async function bootstrap(dir) {
  await writeStateHelper(dir, {
    version: 1,
    revision: 7,
    nodes: {
      T1: { id: "T1", kind: "resolvable", subkind: "task", title: "one", body: "one", acceptance: "one", initiative: "kernel", status: "open", revision: 3 },
      T2: { id: "T2", kind: "resolvable", subkind: "task", title: "two", body: "two", acceptance: "two", initiative: "kernel", status: "open", revision: 1 },
    },
    edges: [{ from: "T1", to: "T2", type: "BLOCKS" }],
    initiatives: { kernel: { desc: "kernel", created_at: "2026-01-01T00:00:00.000Z" } },
    log: [],
  });
  await bootstrapFencedState(dir);
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

test("core batch starts from canonical state and persists through the fenced commit", async () => {
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const { readFencedState: rawReadFencedState } = await import("../src/storage/ledger.ts");
    const readFencedState = rawReadFencedState as (dir: string) => Promise<State>;
    await verifyCanonicalBatch(dir, readFencedState);

    const secondDir = await createTempProject();
    try {
      await bootstrap(secondDir);
      const before = await readFencedState(secondDir);
      const second = await executeBatch({
        projectDir: secondDir,
        actor: "alice",
        if_state_revision: before.revision,
        operations: repair,
        source: { registry, mutate },
      });
      assert.equal(second.revision_before, before.revision);
      const committed = await readFencedState(secondDir);
      assert.equal(committed.version, 1);
      assert.equal(committed.fence_generation, before.fence_generation);
      assert.equal(committed.revision, before.revision + 1);
    } finally {
      await rmTempProject(secondDir);
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("core batch composes built-ins on one draft and writes one core.batch revision/log", async () => {
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const out = await executeBatch({
      projectDir: dir,
      actor: "alice",
      if_state_revision: 8,
      operations: repair,
      source: { registry, mutate },
    });
    assert.equal(out.ok, true);
    assert.equal(out.revision_before, 8);
    assert.equal(out.revision_after, 9);
    assert.equal(out.results.length, 4);
    assert.deepEqual(out.results.map((entry) => entry.op), repair.map((entry) => entry.op));

    const state = await readStateHelper(dir);
    assert.deepEqual(state.edges, [
      { from: "T1", to: "T3", type: "BLOCKS" },
      { from: "T3", to: "T2", type: "BLOCKS" },
    ]);
    assert.equal(state.nodes.T3.revision, 9);
    assert.equal(state.revision, 9);
    assert.equal(state.log.length, 1);
    assert.equal(state.log[0].action, "core.batch");
    assert.equal(state.log[0].agent, "alice");
    assert.equal(state.log[0].operations.length, 4);
    assert.deepEqual(state.log[0].operations.map(({ op }) => op), repair.map(({ op }) => op));
  } finally {
    await rmTempProject(dir);
  }
});

test("core batch internal CAS uses the same state-fenced node revisions as its final write", async () => {
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const out = await executeBatch({
      projectDir: dir,
      actor: "alice",
      if_state_revision: 8,
      operations: [
        repair[0],
        { op: "task.update", input: { id: "T3", if_revision: 9, changes: { title: "three revised" } } },
        { op: "task.update", input: { id: "T1", if_revision: 8, changes: { title: "one revised" } } },
        { op: "task.update", input: { id: "T1", if_revision: 9, changes: { title: "one revised twice" } } },
      ],
      source: { registry, mutate },
    });

    assert.equal(out.ok, true);
    const state = await readStateHelper(dir);
    assert.equal(state.nodes.T3.revision, 9);
    assert.equal(state.nodes.T1.revision, 9);
    assert.equal(state.revision, 9);
    assert.ok(state.revision >= Math.max(...Object.values(state.nodes).map((node) => node.revision)));
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
        if_state_revision: 8,
        operations: [
          ...repair.slice(0, 3),
          { op: "edge.add", input: { from: "T1", to: "T3", type: "BLOCKS" } },
        ],
        source: { registry, mutate },
      }),
      (error) => {
        const failure = errorLike(error);
        const details = failure.details as { operation_index?: number; op?: string; cause?: { code?: string } } | undefined;
        assert.equal(failure.code, "BATCH_OPERATION_FAILED");
        assert.equal(details?.operation_index, 3);
        assert.equal(details?.op, "edge.add");
        assert.equal(details?.cause?.code, "DUPLICATE_EDGE");
        return true;
      },
    );
    const after = await fs.readFile(stateFilePath(dir));
    assert.deepEqual(after, before);
    const state = await readStateHelper(dir);
    assert.equal(state.revision, 8);
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
      if_state_revision: 8,
      operations: [{ op: "edge.remove", input: { from: "missing", to: "also-missing", type: "BLOCKS" } }],
      source: { registry, mutate },
    });
    assert.equal(out.ok, true);
    assert.equal(out.revision_before, 8);
    assert.equal(out.revision_after, 8);
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
      (error) => errorLike(error).code === "STATE_REVISION_CONFLICT",
    );
    assert.equal(prepared, false);
  } finally {
    await rmTempProject(dir);
  }
});
