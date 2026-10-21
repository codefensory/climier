import assert from "node:assert/strict";
import test from "node:test";
import { createTempProject, readState, rmTempProject, stateFilePath, writeCanonicalState, writeState } from "./helpers.ts";
import { readMutationSnapshot } from "../src/kernel/mutation/execute/shared.ts";
import { createBuiltinOperationRegistry } from "../src/application/operations/builtins.ts";
import { buildRegistry } from "../src/application/operations/registry.ts";
import { executeOperation } from "../src/application/operations/execute.ts";
import { mutate } from "../src/kernel/mutate.ts";
import { applyRemoteChanges } from "../src/application/backend-remote-reads.ts";
import { readSqliteChangesSince } from "../src/storage/sqlite/store.ts";

const stateFixture = {
  version: 1,
  revision: 12,
  nodes: {
    T0: { id: "T0", kind: "resolvable", subkind: "task", title: "target", initiative: "core", domain: "db", tags: ["sqlite"], status: "submitted", revision: 12 },
    T1: { id: "T1", kind: "resolvable", subkind: "task", title: "dependent", initiative: "core", status: "open", revision: 3 },
    T2: { id: "T2", kind: "resolvable", subkind: "task", title: "other blocker", initiative: "core", status: "done", revision: 7 },
    T3: { id: "T3", kind: "resolvable", subkind: "task", title: "replacement", initiative: "core", status: "done", revision: 8 },
    T4: { id: "T4", kind: "resolvable", subkind: "task", title: "unrelated", initiative: "other", status: "open", revision: 2 },
    K0: { id: "K0", kind: "knowledge", title: "applicable", body: "full body", status: "active", scope: { domains: ["db"], initiatives: [], tags: [], node_ids: [] } },
    K1: { id: "K1", kind: "knowledge", title: "unrelated knowledge", status: "active", scope: { domains: ["web"], initiatives: [], tags: [], node_ids: [] } },
  },
  edges: [
    { from: "T2", to: "T0", type: "SUPERSEDES" },
    { from: "T0", to: "T1", type: "BLOCKS" },
    { from: "T2", to: "T1", type: "BLOCKS" },
    { from: "T3", to: "T2", type: "SUPERSEDES" },
    { from: "T4", to: "T4", type: "DERIVED_FROM" },
  ].filter((edge) => edge.from !== edge.to),
  initiatives: { core: { desc: "core" }, other: { desc: "other" } },
  log: [{ action: "seed", node: "T0" }],
};

const SQLITE_MODULE = "bun:sqlite";

const coveredOperations = [
  "task.create", "task.update", "note.add", "task.take", "task.submit", "task.accept",
  "task.reject", "task.release", "task.reopen", "task.cancel",
];

test("built-in task and note operations declare an explicit mutation closure", () => {
  const registry = createBuiltinOperationRegistry();
  for (const operation of coveredOperations) {
    assert.ok(registry.lookup(operation)?.snapshotClosure, `${operation} has a closure declaration`);
  }
});

test("closure mutations reject globally duplicated stored edges", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, {
      version: 1,
      revision: 1,
      nodes: {
        A: { id: "A", kind: "resolvable", subkind: "task", title: "A", initiative: "core", status: "open", revision: 1 },
        B: { id: "B", kind: "resolvable", subkind: "task", title: "B", initiative: "core", status: "open", revision: 1 },
        C: { id: "C", kind: "resolvable", subkind: "task", title: "C", initiative: "core", status: "open", revision: 1 },
      },
      edges: [{ from: "A", to: "B", type: "BLOCKS" }],
      initiatives: { core: { desc: "core" } },
      log: [],
    });
    const { Database } = await import(SQLITE_MODULE);
    const database = new Database(stateFilePath(dir));
    try {
      database.query("INSERT INTO edges (position, data, from_id, to_id, edge_type) VALUES (?, ?, ?, ?, ?)")
        .run(1, JSON.stringify({ from: "A", to: "B", type: "BLOCKS" }), "A", "B", "BLOCKS");
    } finally {
      database.close();
    }

    await assert.rejects(executeOperation({
      projectDir: dir,
      actor: "alice",
      operation: "note.add",
      input: { id: "C", text: "note", if_revision: 1 },
      source: { registry: createBuiltinOperationRegistry(), mutate },
    }), (error: { code?: string }) => error.code === "DUPLICATE_EDGE");
  } finally {
    await rmTempProject(dir);
  }
});

test("closure mutations reject globally dangling stored edges", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, {
      version: 1,
      revision: 1,
      nodes: {
        A: { id: "A", kind: "resolvable", subkind: "task", title: "A", initiative: "core", status: "open", revision: 1 },
        C: { id: "C", kind: "resolvable", subkind: "task", title: "C", initiative: "core", status: "open", revision: 1 },
      },
      edges: [],
      initiatives: { core: { desc: "core" } },
      log: [],
    });
    const { Database } = await import(SQLITE_MODULE);
    const database = new Database(stateFilePath(dir));
    try {
      database.query("INSERT INTO edges (position, data, from_id, to_id, edge_type) VALUES (?, ?, ?, ?, ?)")
        .run(0, JSON.stringify({ from: "A", to: "MISSING", type: "BLOCKS" }), "A", "MISSING", "BLOCKS");
    } finally {
      database.close();
    }

    await assert.rejects(executeOperation({
      projectDir: dir,
      actor: "alice",
      operation: "note.add",
      input: { id: "C", text: "note", if_revision: 1 },
      source: { registry: createBuiltinOperationRegistry(), mutate },
    }), (error: { code?: string }) => error.code === "INVALID_EDGE_TARGET");
  } finally {
    await rmTempProject(dir);
  }
});

test("closure mutations validate edge kinds for loaded endpoint nodes", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, {
      version: 1,
      revision: 1,
      nodes: {
        A: { id: "A", kind: "resolvable", subkind: "task", title: "A", initiative: "core", status: "open", revision: 1 },
        K: { id: "K", kind: "knowledge", title: "knowledge", initiative: "core", status: "active" },
      },
      edges: [],
      initiatives: { core: { desc: "core" } },
      log: [],
    });
    const { Database } = await import(SQLITE_MODULE);
    const database = new Database(stateFilePath(dir));
    try {
      database.query("INSERT INTO edges (position, data, from_id, to_id, edge_type) VALUES (?, ?, ?, ?, ?)")
        .run(0, JSON.stringify({ from: "A", to: "K", type: "BLOCKS" }), "A", "K", "BLOCKS");
    } finally {
      database.close();
    }

    await assert.rejects(executeOperation({
      projectDir: dir,
      actor: "alice",
      operation: "note.add",
      input: { id: "A", text: "note", if_revision: 1 },
      source: { registry: createBuiltinOperationRegistry(), mutate },
    }), (error: { code?: string }) => error.code === "INVALID_EDGE_KIND");
  } finally {
    await rmTempProject(dir);
  }
});

test("task.accept closure includes readiness dependents and supersedes chains but excludes unrelated state", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, stateFixture);
    const { state } = await readMutationSnapshot(dir, "task.accept", {
      action: "task.accept",
      input: { id: "T0" },
    });

    assert.deepEqual(Object.keys(state.nodes).toSorted(), ["K0", "T0", "T1", "T2", "T3"]);
    assert.deepEqual(state.edges, stateFixture.edges.slice(0, 4));
    assert.deepEqual(Object.keys(state.initiatives), ["core"]);
    assert.equal(state.nodes.K0.body, "full body");
    assert.deepEqual(state.log, []);
    assert.equal(state.revision, 12);
  } finally {
    await rmTempProject(dir);
  }
});

test("the declared accept closure commits the readiness delta without loading unrelated nodes", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, stateFixture);
    const registry = createBuiltinOperationRegistry();
    let declaredClosure: string | undefined;
    const result = await executeOperation({
      projectDir: dir,
      actor: "alice",
      operation: "task.accept",
      input: { id: "T0", accepted_at: "2026-10-21T00:00:00.000Z" },
      source: {
        registry,
        mutate(args) {
          declaredClosure = args.snapshotClosure;
          return mutate(args);
        },
      },
    }) as { effects: { newly_ready: string[] } };
    assert.equal(declaredClosure, "task.accept");
    assert.deepEqual(result.effects.newly_ready, ["T1"]);
    const after = await readState(dir);
    assert.equal(after.nodes.T0.status, "done");
    assert.equal(after.revision, 13);
  } finally {
    await rmTempProject(dir);
  }
});

test("a 52-operation sequence is byte-identical with full and declared snapshots, including delta replay", async () => {
  const fastDir = await createTempProject();
  const fullDir = await createTempProject();
  const baseState = {
    version: 1,
    revision: 2,
    nodes: {
      BASE: { id: "BASE", kind: "resolvable", subkind: "task", title: "base", initiative: "core", status: "done", revision: 2 },
      BASE2: { id: "BASE2", kind: "resolvable", subkind: "task", title: "base2", initiative: "core", status: "done", revision: 2 },
    },
    edges: [],
    initiatives: { core: { desc: "core initiative" } },
    log: [],
  };
  const originalDate = globalThis.Date;
  const fixedNow = "2026-10-21T18:00:00.000Z";
  class FixedDate extends originalDate {
    constructor(...args: any[]) {
      super(args.length > 0 ? args[0] : fixedNow);
    }
    static now() { return originalDate.parse(fixedNow); }
  }
  try {
    await writeCanonicalState(fastDir, baseState);
    await writeCanonicalState(fullDir, baseState);
    const builtins = createBuiltinOperationRegistry();
    const fullRegistry = buildRegistry(builtins.ops.map((id) => {
      const entry = builtins.lookup(id)!;
      return { id, kind: entry.kind, provider: entry.provider };
    }));

    async function runSequence(projectDir: string, registry: ReturnType<typeof createBuiltinOperationRegistry>) {
      const results: unknown[] = [];
      for (let index = 0; index < 4; index += 1) {
        const id = `T${index}`;
        const run = (operation: string, input: Record<string, unknown> = {}) => executeOperation({
          projectDir,
          actor: "alice",
          operation,
          input: { id, ...input },
          source: { registry, mutate },
        });
        results.push(await run("task.create", {
          initiative: "core", title: id, body: "task body", acceptance: "works", blocked_by: "BASE",
        }));
        let state = await readState(projectDir);
        results.push(await run("task.update", {
          if_revision: state.nodes[id].revision,
          changes: { title: `${id}-updated`, blocked_by: "BASE2" },
        }));
        state = await readState(projectDir);
        results.push(await run("note.add", { text: "note", if_revision: state.nodes[id].revision }));
        results.push(await run("task.take"));
        results.push(await run("task.release"));
        results.push(await run("task.take"));
        results.push(await run("task.submit", { note: "submitted", submitted_at: fixedNow }));
        results.push(await run("task.reject", { reason: "retry" }));
        results.push(await run("task.take"));
        results.push(await run("task.submit", { note: "accepted", submitted_at: fixedNow }));
        results.push(await run("task.accept", { accepted_at: fixedNow }));
        results.push(await run("task.reopen", { reason: "verify again" }));
        results.push(await run("task.cancel", { reason: "sequence complete" }));
      }
      return results;
    }

    globalThis.Date = FixedDate as DateConstructor;
    const fastResults = await runSequence(fastDir, builtins);
    const fullResults = await runSequence(fullDir, fullRegistry);
    globalThis.Date = originalDate;

    const fastState = await readState(fastDir);
    const fullState = await readState(fullDir);
    assert.equal(fastResults.length, 52);
    assert.equal(JSON.stringify(fastResults), JSON.stringify(fullResults));
    assert.equal(JSON.stringify(fastState), JSON.stringify(fullState));
    const changes = await readSqliteChangesSince((await import("./helpers.ts")).stateFilePath(fastDir), baseState.revision);
    const replayed = applyRemoteChanges(baseState, changes);
    assert.equal(JSON.stringify(replayed), JSON.stringify(fastState));
  } finally {
    globalThis.Date = originalDate;
    await rmTempProject(fastDir);
    await rmTempProject(fullDir);
  }
});

test("closure commits preserve the full-state node revision high-water mark", async () => {
  const dir = await createTempProject();
  try {
    await writeState(dir, {
      version: 1,
      revision: 1,
      nodes: {
        T0: { id: "T0", kind: "resolvable", subkind: "task", title: "target", initiative: "core", status: "open", revision: 1 },
        T1: { id: "T1", kind: "resolvable", subkind: "task", title: "high revision", initiative: "core", status: "open", revision: 99 },
      },
      edges: [],
      initiatives: { core: { desc: "core" } },
      log: [],
    });
    const registry = createBuiltinOperationRegistry();
    await executeOperation({
      projectDir: dir,
      actor: "alice",
      operation: "note.add",
      input: { id: "T0", text: "note", if_revision: 1 },
      source: { registry, mutate },
    });
    const after = await readState(dir);
    assert.equal(after.nodes.T0.revision, 2);
    assert.equal(after.revision, 99);
  } finally {
    await rmTempProject(dir);
  }
});

test("task.update keeps cycle detection over paths outside the one-hop target edges", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, {
      version: 1,
      revision: 3,
      nodes: {
        A: { id: "A", kind: "resolvable", subkind: "task", title: "A", initiative: "core", status: "open", revision: 1 },
        B: { id: "B", kind: "resolvable", subkind: "task", title: "B", initiative: "core", status: "open", revision: 2 },
        C: { id: "C", kind: "resolvable", subkind: "task", title: "C", initiative: "core", status: "open", revision: 3 },
      },
      edges: [{ from: "A", to: "B", type: "BLOCKS" }, { from: "B", to: "C", type: "BLOCKS" }],
      initiatives: { core: { desc: "core" } },
      log: [],
    });
    const before = await readState(dir);
    const registry = createBuiltinOperationRegistry();
    await assert.rejects(executeOperation({
      projectDir: dir,
      actor: "alice",
      operation: "task.update",
      input: { id: "A", if_revision: 1, changes: { blocked_by: "C" } },
      source: { registry, mutate },
    }), (error: { code?: string }) => error.code === "CYCLE_DETECTED");
    assert.equal(JSON.stringify(await readState(dir)), JSON.stringify(before));
  } finally {
    await rmTempProject(dir);
  }
});

test("task.create closure preserves the complete missing-initiative error details", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, stateFixture);
    const registry = createBuiltinOperationRegistry();
    await assert.rejects(executeOperation({
      projectDir: dir,
      actor: "alice",
      operation: "task.create",
      input: { id: "NEW", initiative: "missing", title: "new", body: "body", acceptance: "done" },
      source: { registry, mutate },
    }), (error: { code?: string; details?: Record<string, unknown> }) => {
      assert.equal(error.code, "INITIATIVE_NOT_FOUND");
      assert.deepEqual(error.details?.existing, ["core", "other"]);
      return true;
    });
  } finally {
    await rmTempProject(dir);
  }
});

test("an undeclared or mismatched mutation closure retains the complete snapshot", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, stateFixture);
    const fullState = await readState(dir);
    const { state } = await readMutationSnapshot(dir);
    const { state: mismatchedState } = await readMutationSnapshot(dir, "task.accept", {
      action: "task.update",
      input: { id: "T0" },
    });
    assert.deepEqual(state, fullState);
    assert.deepEqual(mismatchedState, fullState);
  } finally {
    await rmTempProject(dir);
  }
});
