import assert from "node:assert/strict";
import test from "node:test";
import { createTempProject, readState, rmTempProject, stateFilePath, writeCanonicalState, writeState } from "./helpers.ts";
import { readMutationSnapshot } from "../src/kernel/mutation/execute/shared.ts";
import { createBuiltinOperationRegistry } from "../src/application/operations/builtins.ts";
import { buildRegistry } from "../src/application/operations/registry.ts";
import { executeOperation } from "../src/application/operations/execute.ts";
import { mutate } from "../src/kernel/mutate.ts";
import { pluginDataNodeSetProvider, pluginDataProjectSetProvider } from "../src/providers/plugin-data/index.ts";
import { applyRemoteChanges } from "../src/application/backend-remote-reads.ts";
import { readSqliteChangesSince, SQLITE_EDGE_INVARIANT_RULES } from "../src/storage/sqlite/store.ts";
import { STATE_EDGE_INVARIANT_RULES } from "../src/contracts/state-invariants.ts";
import type { StateSnapshot } from "../src/contracts/domain.ts";

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

test("every built-in mutation declares an explicit snapshot closure", () => {
  const registry = createBuiltinOperationRegistry();
  for (const operation of registry.ops) {
    assert.ok(registry.lookup(operation)?.snapshotClosure, `${operation} has a closure declaration`);
  }
});

test("remaining operation closures activate and include graph, scope, initiative, and plugin roots", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, {
      version: 1,
      revision: 9,
      nodes: {
        T1: { id: "T1", kind: "resolvable", subkind: "task", title: "task", initiative: "core", domain: "db", tags: ["sqlite"], status: "open", revision: 4 },
        T2: { id: "T2", kind: "resolvable", subkind: "task", title: "dependent", initiative: "core", status: "open", revision: 5 },
        G1: { id: "G1", kind: "resolvable", subkind: "gate", title: "gate", initiative: "core", status: "open", revision: 6 },
        G2: { id: "G2", kind: "resolvable", subkind: "gate", title: "replacement gate", initiative: "core", status: "resolved", revision: 7 },
        K1: { id: "K1", kind: "knowledge", title: "knowledge", initiative: "core", domain: "db", tags: ["sqlite"], status: "active", revision: 8, scope: { domains: ["db"], initiatives: ["core"], tags: ["sqlite"], node_ids: ["T1"] } },
        K2: { id: "K2", kind: "knowledge", title: "new knowledge", initiative: "core", domain: "db", tags: ["sqlite"], status: "active", revision: 9, scope: { domains: ["db"], initiatives: [], tags: [], node_ids: [] } },
        UNRELATED: { id: "UNRELATED", kind: "resolvable", subkind: "task", title: "unrelated", initiative: "other", status: "open", revision: 2 },
      },
      edges: [
        { from: "G1", to: "T2", type: "BLOCKS" },
        { from: "T1", to: "T2", type: "BLOCKS" },
        { from: "G2", to: "G1", type: "SUPERSEDES" },
        { from: "K2", to: "K1", type: "SUPERSEDES" },
      ],
      initiatives: { core: { desc: "core" }, other: { desc: "other" } },
      plugins: { "example.metrics": { data: { keep: true } } },
      log: [{ action: "seed" }],
    });
    const registry = createBuiltinOperationRegistry();
    const operationInputs: Record<string, Record<string, unknown>> = {
      "task.create": { id: "T-new", initiative: "core", blocked_by: ["T1"] },
      "task.update": { id: "T1", changes: { title: "updated" } },
      "task.take": { id: "T1" }, "task.submit": { id: "T1" }, "task.accept": { id: "T1" },
      "task.reject": { id: "T1" }, "task.release": { id: "T1" }, "task.reopen": { id: "T1" },
      "task.cancel": { id: "T1" }, "note.add": { id: "T1" },
      "gate.create": { id: "G-new", initiative: "core", supersedes: "G1", blocked_by: ["T1"] },
      "gate.update": { id: "G1", changes: { title: "updated" } },
      "gate.resolve": { id: "G1" }, "gate.reopen": { id: "G1" }, "gate.cancel": { id: "G1" },
      "knowledge.create": { id: "K-new", initiative: "core", domain: "db", tags: ["sqlite"], supersedes: "K1" },
      "knowledge.update": { id: "K1", changes: { title: "updated" } },
      "knowledge.deprecate": { id: "K1" },
      "edge.add": { from: "T1", to: "T2", type: "BLOCKS" },
      "edge.remove": { from: "T1", to: "T2", type: "BLOCKS" },
      "initiative.create": { name: "new-initiative" },
    };
    for (const operation of registry.ops) {
      const entry = registry.lookup(operation)!;
      const result = await readMutationSnapshot(dir, entry.snapshotClosure, { action: operation, input: operationInputs[operation] });
      assert.ok(result.closure, `${operation} used its declared closure`);
    }

    const gate = registry.lookup("gate.resolve")!;
    const gateSnapshot = await readMutationSnapshot(dir, gate.snapshotClosure, { action: "gate.resolve", input: { id: "G1" } });
    assert.deepEqual(Object.keys(gateSnapshot.state.nodes).toSorted(), ["G1", "G2", "K1", "K2", "T1", "T2"]);
    const knowledge = registry.lookup("knowledge.deprecate")!;
    const knowledgeSnapshot = await readMutationSnapshot(dir, knowledge.snapshotClosure, { action: "knowledge.deprecate", input: { id: "K1" } });
    assert.deepEqual(Object.keys(knowledgeSnapshot.state.nodes).toSorted(), ["K1", "K2"]);
    const edge = registry.lookup("edge.add")!;
    const edgeSnapshot = await readMutationSnapshot(dir, edge.snapshotClosure, { action: "edge.add", input: { from: "T1", to: "T2", type: "BLOCKS" } });
    assert.ok(["T1", "T2", "G1", "G2"].every((id) => edgeSnapshot.state.nodes[id]));
    assert.equal(edgeSnapshot.state.nodes.UNRELATED, undefined);
    const initiative = registry.lookup("initiative.create")!;
    const initiativeSnapshot = await readMutationSnapshot(dir, initiative.snapshotClosure, { action: "initiative.create", input: { name: "new" } });
    assert.deepEqual(initiativeSnapshot.state.nodes, {});
    assert.deepEqual(initiativeSnapshot.state.initiatives, { core: {}, other: {} });

    const nodePlugin = await readMutationSnapshot(dir, "plugin-data.node", {
      action: "plugin-data.node.set", input: { id: "T1" },
    });
    assert.deepEqual(Object.keys(nodePlugin.state.nodes), ["T1"]);
    const projectPlugin = await readMutationSnapshot(dir, "plugin-data.project", {
      action: "plugin-data.project.set", input: { key: "counter" },
    });
    assert.deepEqual(projectPlugin.state.plugins, { "example.metrics": { data: { keep: true } } });
  } finally {
    await rmTempProject(dir);
  }
});

test("edge.add closure follows long BLOCKS paths so cycle errors match full snapshots", async () => {
  const dir = await createTempProject();
  try {
    const state = {
      version: 1,
      revision: 4,
      nodes: Object.fromEntries(["A", "B", "C", "D", "UNRELATED"].map((id, index) => [id, {
        id, kind: "resolvable", subkind: "task", title: id, initiative: "core", status: "open", revision: index + 1,
      }])),
      edges: [
        { from: "B", to: "C", type: "BLOCKS" },
        { from: "C", to: "D", type: "BLOCKS" },
        { from: "D", to: "A", type: "BLOCKS" },
      ],
      initiatives: { core: { desc: "core" } },
      log: [],
    };
    await writeCanonicalState(dir, state);
    const registry = createBuiltinOperationRegistry();
    const { state: closure } = await readMutationSnapshot(dir, "edge", {
      action: "edge.add", input: { from: "A", to: "B", type: "BLOCKS" },
    });
    assert.deepEqual(closure.edges, state.edges);
    assert.equal(closure.nodes.UNRELATED, undefined);
    await assert.rejects(executeOperation({
      projectDir: dir,
      actor: "alice",
      operation: "edge.add",
      input: { from: "A", to: "B", type: "BLOCKS" },
      source: { registry, mutate },
    }), (error: { code?: string; details?: Record<string, unknown> }) => {
      assert.equal(error.code, "CYCLE_DETECTED");
      assert.deepEqual(error.details?.cycle, ["A", "B", "C", "D", "A"]);
      return true;
    });
  } finally {
    await rmTempProject(dir);
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

test("closure mutations reject unrelated self-edges, invalid edge types, and BLOCKS cycles", async (t) => {
  const cases = [
    { name: "self-edge", edges: [{ from: "A", to: "A", type: "BLOCKS" }], code: "SELF_EDGE" },
    { name: "invalid edge type", edges: [{ from: "A", to: "B", type: "INVALID" }], code: "INVALID_EDGE_TYPE" },
    {
      name: "BLOCKS cycle",
      edges: [{ from: "A", to: "B", type: "BLOCKS" }, { from: "B", to: "A", type: "BLOCKS" }],
      code: "CYCLE_DETECTED",
    },
  ];
  for (const example of cases) {
    await t.test(example.name, async () => {
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
          edges: [],
          initiatives: { core: { desc: "core" } },
          log: [],
        });
        const { Database } = await import(SQLITE_MODULE);
        const database = new Database(stateFilePath(dir));
        try {
          const insert = database.query("INSERT INTO edges (position, data, from_id, to_id, edge_type) VALUES (?, ?, ?, ?, ?)");
          for (const [position, edge] of example.edges.entries()) {
            insert.run(position, JSON.stringify(edge), edge.from, edge.to, edge.type);
          }
        } finally {
          database.close();
        }

        await assert.rejects(readState(dir), (error: { code?: string }) => error.code === example.code);
        await assert.rejects(executeOperation({
          projectDir: dir,
          actor: "alice",
          operation: "note.add",
          input: { id: "C", text: "note", if_revision: 1 },
          source: { registry: createBuiltinOperationRegistry(), mutate },
        }), (error: { code?: string }) => error.code === example.code);
      } finally {
        await rmTempProject(dir);
      }
    });
  }
});

test("closure mutations do not reject a healthy unrelated BLOCKS graph", async () => {
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
    await executeOperation({
      projectDir: dir,
      actor: "alice",
      operation: "note.add",
      input: { id: "C", text: "note", if_revision: 1 },
      source: { registry: createBuiltinOperationRegistry(), mutate },
    });
    assert.equal((await readState(dir)).nodes.C.notes?.length, 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("SQL closure validation covers every canonical edge invariant", () => {
  assert.deepEqual(SQLITE_EDGE_INVARIANT_RULES, STATE_EDGE_INVARIANT_RULES);
});

test("SQL closure validation matches full-state edge invariant errors and details", async (t) => {
  const invalidEdges = [
    { name: "edge object shape", rules: ["edge-object"], edges: [null] },
    { name: "endpoint shape", rules: ["endpoint-shape"], edges: [{ from: "", to: "A", type: "BLOCKS" }] },
    { name: "missing endpoint", rules: ["endpoint-exists"], edges: [{ from: "MISSING", to: "A", type: "BLOCKS" }] },
    { name: "self-edge", rules: ["self-edge"], edges: [{ from: "A", to: "A", type: "BLOCKS" }] },
    { name: "empty edge type", rules: ["type-shape"], edges: [{ from: "A", to: "B", type: "" }] },
    { name: "unknown edge type", rules: ["allowed-type"], edges: [{ from: "A", to: "B", type: "UNKNOWN" }] },
    { name: "BLOCKS requires resolvable source", rules: ["kind-compatibility"], edges: [{ from: "K", to: "A", type: "BLOCKS" }] },
    { name: "BLOCKS requires resolvable target", rules: ["kind-compatibility"], edges: [{ from: "A", to: "K", type: "BLOCKS" }] },
    { name: "SUPERSEDES requires equal kinds", rules: ["kind-compatibility"], edges: [{ from: "A", to: "K", type: "SUPERSEDES" }] },
    { name: "duplicate edge", rules: ["unique-edge"], edges: [{ from: "A", to: "B", type: "BLOCKS" }, { from: "A", to: "B", type: "BLOCKS" }] },
    { name: "BLOCKS cycle", rules: ["blocks-acyclic"], edges: [{ from: "A", to: "B", type: "BLOCKS" }, { from: "B", to: "A", type: "BLOCKS" }] },
  ];
  const exercisedRules = new Set(invalidEdges.flatMap(({ rules }) => rules));
  assert.deepEqual([...exercisedRules].toSorted(), [...STATE_EDGE_INVARIANT_RULES].toSorted());

  async function errorFrom(operation: () => Promise<unknown>) {
    try {
      await operation();
    } catch (error) {
      const caught = error as { code?: string; details?: unknown };
      return { code: caught.code, details: caught.details };
    }
    return null;
  }

  for (const example of invalidEdges) {
    await t.test(example.name, async () => {
      const dir = await createTempProject();
      try {
        await writeCanonicalState(dir, {
          version: 1,
          revision: 1,
          nodes: {
            A: { id: "A", kind: "resolvable", subkind: "task", title: "A", initiative: "core", status: "open", revision: 1 },
            B: { id: "B", kind: "resolvable", subkind: "task", title: "B", initiative: "core", status: "open", revision: 1 },
            G: { id: "G", kind: "resolvable", subkind: "gate", title: "G", initiative: "core", status: "open", revision: 1 },
            K: { id: "K", kind: "knowledge", title: "K", initiative: "core", status: "active" },
            TARGET: { id: "TARGET", kind: "resolvable", subkind: "task", title: "target", initiative: "core", status: "open", revision: 1 },
          },
          edges: [],
          initiatives: { core: { desc: "core" } },
          log: [],
        });
        const { Database } = await import(SQLITE_MODULE);
        const database = new Database(stateFilePath(dir));
        try {
          const insert = database.query("INSERT INTO edges (position, data, from_id, to_id, edge_type) VALUES (?, ?, ?, ?, ?)");
          for (const [position, edge] of example.edges.entries()) {
            insert.run(position, JSON.stringify(edge), edge?.from ?? null, edge?.to ?? null, edge?.type ?? null);
          }
        } finally {
          database.close();
        }

        const fullError = await errorFrom(() => readState(dir));
        const closureError = await errorFrom(() => readMutationSnapshot(dir, "task", {
          action: "note.add",
          input: { id: "TARGET" },
        }));
        assert.ok(fullError, "the canonical full-state validator rejects this case");
        assert.deepEqual(closureError, fullError);
      } finally {
        await rmTempProject(dir);
      }
    });
  }
});

test("node kind changes invalidate the cached SQL edge proof", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, {
      version: 1,
      revision: 1,
      nodes: {
        A: { id: "A", kind: "resolvable", subkind: "task", title: "A", initiative: "core", status: "open", revision: 1 },
        B: { id: "B", kind: "resolvable", subkind: "task", title: "B", initiative: "core", status: "open", revision: 1 },
        TARGET: { id: "TARGET", kind: "resolvable", subkind: "task", title: "target", initiative: "core", status: "open", revision: 1 },
      },
      edges: [{ from: "A", to: "B", type: "BLOCKS" }],
      initiatives: { core: { desc: "core" } },
      log: [],
    });
    const { Database } = await import(SQLITE_MODULE);
    const database = new Database(stateFilePath(dir));
    try {
      const node = { id: "B", kind: "knowledge", title: "B", initiative: "core", status: "active" };
      database.query("UPDATE nodes SET data = ? WHERE id = 'B'").run(JSON.stringify(node));
    } finally {
      database.close();
    }

    const fullError = await readState(dir).then(() => null, (error) => error as { code?: string; details?: unknown });
    const closureError = await readMutationSnapshot(dir, "task", {
      action: "note.add",
      input: { id: "TARGET" },
    }).then(() => null, (error) => error as { code?: string; details?: unknown });
    assert.ok(fullError);
    assert.ok(closureError);
    assert.equal(fullError.code, "INVALID_EDGE_KIND");
    assert.deepEqual({ code: closureError.code, details: closureError.details }, {
      code: fullError.code,
      details: fullError.details,
    });
  } finally {
    await rmTempProject(dir);
  }
});

test("closure SQL preserves canonical kind rules without imposing subkind rules", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, {
      version: 1,
      revision: 1,
      nodes: {
        A: { id: "A", kind: "resolvable", subkind: "task", title: "A", initiative: "core", status: "open", revision: 1 },
        G: { id: "G", kind: "resolvable", subkind: "gate", title: "G", initiative: "core", status: "open", revision: 1 },
        K: { id: "K", kind: "knowledge", title: "K", initiative: "core", status: "active" },
        TARGET: { id: "TARGET", kind: "resolvable", subkind: "task", title: "target", initiative: "core", status: "open", revision: 1 },
      },
      edges: [
        { from: "A", to: "G", type: "BLOCKS" },
        { from: "A", to: "G", type: "SUPERSEDES" },
        { from: "K", to: "A", type: "DERIVED_FROM" },
      ],
      initiatives: { core: { desc: "core" } },
      log: [],
    });
    const full = await readState(dir);
    const { state: closure } = await readMutationSnapshot(dir, "task", { action: "note.add", input: { id: "TARGET" } });
    assert.deepEqual(closure.edges, []);
    assert.deepEqual(full.edges.length, 3);
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

test("gate, knowledge, edge, initiative, and plugin closures are byte-identical to full snapshots", async () => {
  const fastDir = await createTempProject();
  const fullDir = await createTempProject();
  const baseState = {
    version: 1,
    revision: 3,
    nodes: {
      G: { id: "G", kind: "resolvable", subkind: "gate", title: "decision", initiative: "core", resolution_mode: "choice", status: "open", revision: 3 },
      T: { id: "T", kind: "resolvable", subkind: "task", title: "task", initiative: "core", domain: "db", tags: ["sqlite"], status: "open", revision: 3 },
      D: { id: "D", kind: "resolvable", subkind: "task", title: "dependent", initiative: "core", status: "open", revision: 3 },
      B: { id: "B", kind: "resolvable", subkind: "task", title: "satisfied blocker", initiative: "core", status: "done", revision: 3 },
      K1: { id: "K1", kind: "knowledge", title: "old guidance", initiative: "core", domain: "db", tags: ["sqlite"], status: "active", revision: 3, scope: { domains: ["db"], initiatives: ["core"], tags: ["sqlite"], node_ids: [] } },
      K2: { id: "K2", kind: "knowledge", title: "new guidance", initiative: "core", domain: "db", tags: ["sqlite"], status: "active", revision: 3, scope: { domains: ["db"], initiatives: [], tags: [], node_ids: [] } },
      E1: { id: "E1", kind: "resolvable", subkind: "task", title: "edge source", initiative: "core", status: "open", revision: 3 },
      E2: { id: "E2", kind: "resolvable", subkind: "task", title: "edge target", initiative: "core", status: "open", revision: 3 },
    },
    edges: [
      { from: "G", to: "D", type: "BLOCKS" },
      { from: "B", to: "D", type: "BLOCKS" },
      { from: "K2", to: "K1", type: "SUPERSEDES" },
      { from: "E1", to: "E2", type: "DERIVED_FROM" },
    ],
    initiatives: { core: { desc: "core", created_at: "2026-01-01T00:00:00.000Z" } },
    plugins: { "example.metrics": { data: { keep: true } } },
    log: [],
  };
  const originalDate = globalThis.Date;
  const fixedNow = "2026-10-21T18:00:00.000Z";
  class FixedDate extends originalDate {
    constructor(...args: any[]) { super(args.length > 0 ? args[0] : fixedNow); }
    static now() { return originalDate.parse(fixedNow); }
  }
  try {
    await writeCanonicalState(fastDir, baseState);
    await writeCanonicalState(fullDir, baseState);
    const registry = createBuiltinOperationRegistry();
    const fullRegistry = buildRegistry(registry.ops.map((id) => {
      const { kind, provider } = registry.lookup(id)!;
      return { id, kind, provider };
    }));
    globalThis.Date = FixedDate as DateConstructor;
    async function run(projectDir: string, operationRegistry: ReturnType<typeof createBuiltinOperationRegistry>, closure: boolean) {
      const results: unknown[] = [];
      const execute = (operation: string, input: Record<string, unknown>) => executeOperation({
        projectDir,
        actor: "alice",
        operation,
        input,
        source: { registry: operationRegistry, mutate },
      });
      results.push(await execute("gate.resolve", { id: "G", choice: "ship", rationale: "verified" }));
      results.push(await execute("gate.reopen", { id: "G", reason: "reconsider" }));
      let state = await readState(projectDir);
      results.push(await execute("gate.update", { id: "G", if_revision: state.nodes.G.revision, changes: { title: "revised decision" } }));
      results.push(await execute("gate.cancel", { id: "G", reason: "decision withdrawn" }));
      results.push(await execute("gate.create", {
        id: "G-new", title: "replacement decision", body: "details", purpose: "decision",
        initiative: "core", supersedes: "G",
      }));
      results.push(await execute("knowledge.deprecate", { id: "K1", reason: "replaced" }));
      results.push(await execute("knowledge.update", { id: "K2", changes: { title: "revised guidance" } }));
      results.push(await execute("knowledge.create", {
        id: "K3", initiative: "core", title: "latest guidance", body: "details",
        scope: { domains: ["db"] }, supersedes: "K1",
      }));
      results.push(await execute("edge.add", { from: "E2", to: "E1", type: "DERIVED_FROM" }));
      results.push(await execute("edge.remove", { from: "E2", to: "E1", type: "DERIVED_FROM" }));
      results.push(await execute("initiative.create", { name: "new-initiative", desc: "new" }));
      results.push(await mutate({
        projectDir,
        request: { action: "plugin-data.node.set", actor: "alice", input: { id: "T", value: { local: true } } },
        provider: pluginDataNodeSetProvider,
        pluginId: "example.audit",
        ...(closure ? { snapshotClosure: "plugin-data.node" as const } : {}),
      }));
      results.push(await mutate({
        projectDir,
        request: { action: "plugin-data.project.set", actor: "alice", input: { key: "count", value: 7 } },
        provider: pluginDataProjectSetProvider,
        pluginId: "example.audit",
        ...(closure ? { snapshotClosure: "plugin-data.project" as const } : {}),
      }));
      return results;
    }
    const fastResults = await run(fastDir, registry, true);
    const fullResults = await run(fullDir, fullRegistry, false);
    globalThis.Date = originalDate;
    assert.equal(JSON.stringify(fastResults), JSON.stringify(fullResults));
    const fastState = await readState(fastDir);
    const fullState = await readState(fullDir);
    assert.equal(JSON.stringify(fastState), JSON.stringify(fullState));
    const changes = await readSqliteChangesSince(stateFilePath(fastDir), baseState.revision);
    assert.equal(JSON.stringify(applyRemoteChanges(baseState, changes)), JSON.stringify(fastState));
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

test("a selected policy evaluates declared-closure mutations against the complete snapshot", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, stateFixture);
    const before = await readState(dir);
    let observedSnapshot: StateSnapshot | null = null;
    let decision: "allow" | "deny" | null = null;
    await executeOperation({
      projectDir: dir,
      actor: "alice",
      operation: "note.add",
      input: { id: "T0", text: "policy-checked note", if_revision: 12 },
      source: {
        registry: createBuiltinOperationRegistry(),
        mutate,
        selectPolicy: async () => ({ pluginId: "policy-fixture" }),
        authorizeAction: async ({ snapshot }: { snapshot: StateSnapshot }) => {
          observedSnapshot = snapshot;
          decision = snapshot.nodes.T4?.title === "unrelated" && snapshot.edges.length === before.edges.length
            ? "allow"
            : "deny";
          return { decision };
        },
      },
    });

    assert.deepEqual(observedSnapshot, before);
    assert.equal(decision, "allow");
    assert.equal((await readState(dir)).nodes.T0.notes?.[0].text, "policy-checked note");
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
