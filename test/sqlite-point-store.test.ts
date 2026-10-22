import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { rmTempProject, createTempProject, writeCanonicalState } from "./helpers.ts";

const SQLITE_MODULE = "bun:sqlite";

function syntheticState(nodeCount: number) {
  const nodes: Record<string, Record<string, unknown>> = {};
  const edges: Array<Record<string, string>> = [];
  const log: Array<Record<string, unknown>> = [];
  for (let i = 0; i < nodeCount; i += 1) {
    const id = `T-point-${i}`;
    nodes[id] = {
      id, kind: "resolvable", subkind: "task", title: `Task ${i}`,
      ...(i === 4 || i === 42 ? { body: "first line\nexact body 🌱\n" } : {}),
      status: i % 2 ? "open" : "done", revision: i + 1,
    };
    if (i > 0) { edges.push({ from: `T-point-${i - 1}`, to: id, type: i % 2 ? "BLOCKS" : "DERIVED_FROM" }); }
    log.push({ action: "task.update", node: id, revision: i + 1 });
  }
  return {
    version: 1,
    revision: nodeCount,
    nodes,
    edges,
    initiatives: { core: { desc: "Point store", created_at: "2026-10-21T00:00:00.000Z" } },
    log,
  };
}

function expectedCounts(nodes: Record<string, Record<string, unknown>>, filters: Record<string, string> = {}) {
  const counts = { total: 0, byKind: {} as Record<string, number>, bySubkind: {} as Record<string, number>, byStatus: {} as Record<string, number> };
  for (const node of Object.values(nodes)) {
    if (Object.entries(filters).some(([key, value]) => node[key] !== value)) { continue; }
    counts.total += 1;
    for (const [field, target] of [["kind", counts.byKind], ["subkind", counts.bySubkind], ["status", counts.byStatus]] as const) {
      const value = node[field];
      if (typeof value === "string") { target[value] = (target[value] ?? 0) + 1; }
    }
  }
  return counts;
}

function assertCountsMatch(actual, expected) {
  assert.deepEqual(actual, expected);
  for (const field of ["byKind", "bySubkind", "byStatus"] as const) {
    assert.deepEqual(Object.keys(actual[field]), Object.keys(expected[field]), `${field} key order`);
  }
}

function representativeState(nodeCount: number) {
  const statuses = ["open", "done", "in_progress", "canceled"];
  const nodes: Record<string, Record<string, unknown>> = {};
  const edges: Array<Record<string, string>> = [];
  const actions = ["task.add", "task.update", "task.note", "gate.resolve", "knowledge.deprecate"];
  for (let i = 0; i < nodeCount; i += 1) {
    const id = `T-project-${i}`;
    nodes[id] = {
      id,
      kind: "resolvable",
      subkind: i % 3 === 0 ? "gate" : "task",
      title: `Project migration milestone ${i}`,
      body: `Implementation detail for milestone ${i}. Preserve the existing API contract, validate the migration against staging, and record any operational caveats for the next phase.`,
      status: statuses[i % statuses.length],
      revision: i + 1,
      acceptance: `The milestone ${i} is verified with an observable result.`,
    };
    if (i > 0) {
      edges.push({ from: `T-project-${i - 1}`, to: id, type: ["BLOCKS", "SUPERSEDES", "DERIVED_FROM"][i % 3] });
    }
  }
  return {
    version: 1,
    revision: nodeCount,
    nodes,
    edges,
    initiatives: { migration: { desc: "A representative prose-heavy migration plan", created_at: "2026-10-21T00:00:00.000Z" } },
    log: Array.from({ length: nodeCount }, (_, i) => ({ action: actions[i % actions.length], node: `T-project-${i}`, revision: i + 1, note: `Reviewed migration evidence for milestone ${i}.` })),
  };
}

// Counts rows returned to JavaScript; it does not measure rows SQLite scans.
async function countResultRows(run: () => Promise<unknown>) {
  const { Database } = await import(SQLITE_MODULE);
  const originalQuery = Database.prototype.query;
  let rowsRead = 0;
  Database.prototype.query = function (sql, ...args) {
    const statement = originalQuery.call(this, sql, ...args);
    if (!/^\s*(SELECT|PRAGMA)\b/i.test(sql)) { return statement; }
    const originalGet = statement.get;
    const originalAll = statement.all;
    statement.get = function (...queryArgs) {
      const row = originalGet.apply(this, queryArgs);
      if (row !== null && row !== undefined) { rowsRead += 1; }
      return row;
    };
    statement.all = function (...queryArgs) {
      const rows = originalAll.apply(this, queryArgs);
      rowsRead += rows.length;
      return rows;
    };
    return statement;
  };
  try { await run(); return rowsRead; }
  finally { Database.prototype.query = originalQuery; }
}

async function observeNodeSelects<T>(run: () => Promise<T>) {
  const { Database } = await import(SQLITE_MODULE);
  const originalQuery = Database.prototype.query;
  const selects: Array<{ sql: string; rows: Array<Record<string, unknown>> }> = [];
  Database.prototype.query = function (sql, ...args) {
    const statement = originalQuery.call(this, sql, ...args);
    if (!/^\s*SELECT\b/i.test(sql) || !/\bFROM\s+nodes\b/i.test(sql)) { return statement; }
    const originalAll = statement.all;
    statement.all = function (...queryArgs) {
      const rows = originalAll.apply(this, queryArgs);
      selects.push({ sql, rows });
      return rows;
    };
    return statement;
  };
  try { return { result: await run(), selects }; }
  finally { Database.prototype.query = originalQuery; }
}

test("point reads match complete SQLite state and preserve node property order", async () => {
  const projectDir = await createTempProject();
  try {
    const state = syntheticState(6);
    await writeCanonicalState(projectDir, state);
    const { stateFile } = await import("../src/storage/state.ts");
    const { readSqliteState, readSqliteNode, readSqliteNodesByIds, readSqliteEdgesOf, readSqliteLogSince, readSqliteCounts, readSqliteRevision, withSqliteTransaction } = await import("../src/storage/sqlite/store.ts");
    const file = stateFile(projectDir);
    const complete = await readSqliteState(file);
    assert.ok(complete);
    const targetId = "T-point-4";
    assert.equal(JSON.stringify(await readSqliteNode(file, targetId)), JSON.stringify(complete.nodes[targetId]));
    const ids = ["T-point-4", "T-point-1", "missing", "T-point-4"];
    const expectedNodes = Object.fromEntries(Object.entries(complete.nodes).filter(([id]) => ids.includes(id)));
    assert.equal(JSON.stringify(await readSqliteNodesByIds(file, ids)), JSON.stringify(expectedNodes));
    const idSet = new Set(ids);
    for (const type of [undefined, "BLOCKS"]) {
      const expected = complete.edges.filter((edge: any) => (idSet.has(edge.from) || idSet.has(edge.to)) && (!type || edge.type === type));
      assert.equal(JSON.stringify(await readSqliteEdgesOf(file, ids, type ? { type } : {})), JSON.stringify(expected));
    }
    assert.equal(JSON.stringify(await readSqliteLogSince(file, 3)), JSON.stringify([]));
    assert.deepEqual(await readSqliteCounts(file), expectedCounts(complete.nodes as Record<string, Record<string, unknown>>));
    assert.deepEqual(await readSqliteCounts(file, { kind: "resolvable", subkind: "task", status: "open" }), expectedCounts(complete.nodes as Record<string, Record<string, unknown>>, { kind: "resolvable", subkind: "task", status: "open" }));
    assert.equal(await readSqliteRevision(file), complete.revision);
    assert.deepEqual(await readSqliteNodesByIds(file, []), {});
    assert.deepEqual(await readSqliteEdgesOf(file, []), []);
    await withSqliteTransaction(file, async () => {
      assert.equal(JSON.stringify(await readSqliteNode(file, targetId)), JSON.stringify(complete.nodes[targetId]));
      assert.equal(await readSqliteRevision(file), complete.revision);
      assert.deepEqual(await readSqliteNodesByIds(file, []), {});
      await assert.rejects(readSqliteEdgesOf(`${file}.other`, []), /cannot access another SQLite project/);
    });
    assert.equal(await readSqliteNode(file, "missing"), null);
  } finally { await rmTempProject(projectDir); }
});

test("count maps preserve first appearance order from the complete state", async () => {
  const projectDir = await createTempProject();
  try {
    const state = {
      version: 1,
      revision: 2,
      nodes: {
        "T-open-first": { id: "T-open-first", kind: "resolvable", subkind: "task", title: "Open first", status: "open", revision: 1 },
        "T-done-second": { id: "T-done-second", kind: "resolvable", subkind: "task", title: "Done second", status: "done", revision: 2 },
      },
      edges: [],
      initiatives: { core: { desc: "Point store", created_at: "2026-10-21T00:00:00.000Z" } },
      log: [],
    };
    await writeCanonicalState(projectDir, state);
    const { stateFile } = await import("../src/storage/state.ts");
    const { readSqliteState, readSqliteCounts } = await import("../src/storage/sqlite/store.ts");
    const complete = await readSqliteState(stateFile(projectDir));
    assert.ok(complete);
    assertCountsMatch(await readSqliteCounts(stateFile(projectDir)), expectedCounts(complete.nodes as Record<string, Record<string, unknown>>));
  } finally { await rmTempProject(projectDir); }
});

test("v3 SQLite databases migrate edge lookup columns and indexes", async () => {
  const projectDir = await createTempProject();
  try {
    const { stateFile } = await import("../src/storage/state.ts");
    const file = stateFile(projectDir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const { Database } = await import(SQLITE_MODULE);
    const database = new Database(file, { create: true });
    try {
      database.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE nodes (id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, data TEXT NOT NULL, body_hash TEXT);
        CREATE TABLE node_body (hash TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE edges (position INTEGER PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE initiatives (name TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, data TEXT NOT NULL);
        CREATE TABLE log (position INTEGER PRIMARY KEY, data TEXT NOT NULL, from_revision INTEGER, state_revision INTEGER, delta TEXT);
        CREATE TABLE sync_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        INSERT INTO meta VALUES ('version', '1'), ('revision', '0'), ('extras', '{}'), ('__root_order', '["version","revision","nodes","edges","initiatives","log"]');
        INSERT INTO nodes VALUES ('T-old', 0, '{"id":"T-old","kind":"resolvable","subkind":"task","title":"Old","status":"open"}', NULL);
        INSERT INTO nodes VALUES ('T-new', 1, '{"id":"T-new","kind":"resolvable","subkind":"task","title":"New","status":"open"}', NULL);
        INSERT INTO edges VALUES (0, '{"from":"T-old","to":"T-new","type":"BLOCKS"}');
        PRAGMA user_version = 3;
      `);
    } finally { database.close(); }
    const { readSqliteEdgesOf, readSqliteState } = await import("../src/storage/sqlite/store.ts");
    assert.deepEqual(await readSqliteEdgesOf(file, ["T-new"]), [{ from: "T-old", to: "T-new", type: "BLOCKS" }]);
    assert.deepEqual((await readSqliteState(file))?.nodes["T-old"], { id: "T-old", kind: "resolvable", subkind: "task", title: "Old", status: "open" });
    const migrated = new Database(file);
    try {
      assert.equal(migrated.query("PRAGMA user_version").get().user_version, 4);
      assert.deepEqual(migrated.query("SELECT from_id, to_id, edge_type FROM edges").get(), { from_id: "T-old", to_id: "T-new", edge_type: "BLOCKS" });
      const indexes = migrated.query("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(({ name }) => name);
      for (const index of ["idx_edges_from_type_position", "idx_edges_to_type_position", "idx_log_state_revision_position", "idx_nodes_count_fields_position"]) { assert.ok(indexes.includes(index), index); }
    } finally { migrated.close(); }
  } finally { await rmTempProject(projectDir); }
});

test("v4 databases acquire count indexes and filtered counts search them without changing the schema version", async () => {
  const projectDir = await createTempProject();
  try {
    await writeCanonicalState(projectDir, representativeState(240));
    const { stateFile } = await import("../src/storage/state.ts");
    const { Database } = await import(SQLITE_MODULE);
    const file = stateFile(projectDir);
    const database = new Database(file);
    const indexNames = [
      "idx_nodes_count_fields_position",
      "idx_nodes_count_subkind_position",
      "idx_nodes_count_status_position",
      "idx_nodes_count_subkind_status_position",
    ];
    try {
      assert.equal(database.query("PRAGMA user_version").get().user_version, 4);
      for (const index of indexNames.slice(1)) { database.exec(`DROP INDEX IF EXISTS ${index}`); }
    } finally { database.close(); }

    const { readSqliteCounts } = await import("../src/storage/sqlite/store.ts");
    const cases = [
      { filters: { status: "done" }, args: ["done"] },
      { filters: { subkind: "task" }, args: ["task"] },
      { filters: { kind: "resolvable" }, args: ["resolvable"] },
      { filters: { kind: "resolvable", subkind: "task" }, args: ["resolvable", "task"] },
      { filters: { kind: "resolvable", status: "done" }, args: ["resolvable", "done"] },
      { filters: { subkind: "task", status: "done" }, args: ["task", "done"] },
      { filters: { kind: "resolvable", subkind: "task", status: "done" }, args: ["resolvable", "task", "done"] },
    ];
    for (const { filters } of cases) { await readSqliteCounts(file, filters); }
    const migrated = new Database(file);
    try {
      assert.equal(migrated.query("PRAGMA user_version").get().user_version, 4);
      for (const index of indexNames) {
        assert.ok(migrated.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index), index);
      }
    } finally { migrated.close(); }

    for (const { filters, args } of cases) {
      const where = Object.entries(filters).map(([field]) => `json_extract(data, '$.${field}') = ?`).join(" AND ");
      const plan = await dbPlan(file,
        `SELECT json_extract(data, '$.kind') AS kind, json_extract(data, '$.subkind') AS subkind, json_extract(data, '$.status') AS status, COUNT(*) AS count FROM nodes WHERE ${where} GROUP BY kind, subkind, status ORDER BY MIN(position)`,
        args,
      );
      assert.ok(plan.some((detail) => /\bSEARCH\s+nodes\b/i.test(detail)), `${JSON.stringify(filters)} did not search an index: ${plan.join("; ")}`);
      assert.ok(!plan.some((detail) => /\bSCAN\s+nodes\b/i.test(detail)), `${JSON.stringify(filters)} scanned nodes: ${plan.join("; ")}`);
    }
  } finally { await rmTempProject(projectDir); }
});

test("point reads match a prose-heavy representative project across all six APIs", async () => {
  const projectDir = await createTempProject();
  try {
    const state = representativeState(240);
    await writeCanonicalState(projectDir, state);
    const { stateFile } = await import("../src/storage/state.ts");
    const { Database } = await import(SQLITE_MODULE);
    const { readSqliteState, readSqliteNode, readSqliteNodesByIds, readSqliteEdgesOf, readSqliteLogSince, readSqliteCounts, readSqliteRevision } = await import("../src/storage/sqlite/store.ts");
    const file = stateFile(projectDir);
    const database = new Database(file);
    try { database.query("UPDATE log SET state_revision = position + 1").run(); }
    finally { database.close(); }

    const complete = await readSqliteState(file);
    assert.ok(complete);
    const id = "T-project-42";
    assert.equal(JSON.stringify(await readSqliteNode(file, id)), JSON.stringify(complete.nodes[id]));
    const ids = ["T-project-40", id, "T-project-43", "missing"];
    const idSet = new Set(ids);
    const expectedNodes = Object.fromEntries(Object.entries(complete.nodes).filter(([nodeId]) => idSet.has(nodeId)));
    assert.equal(JSON.stringify(await readSqliteNodesByIds(file, ids)), JSON.stringify(expectedNodes));
    for (const type of [undefined, "SUPERSEDES"] as const) {
      const expectedEdges = complete.edges.filter((edge: any) => (idSet.has(edge.from) || idSet.has(edge.to)) && (type === undefined || edge.type === type));
      assert.equal(JSON.stringify(await readSqliteEdgesOf(file, ids, type === undefined ? {} : { type })), JSON.stringify(expectedEdges));
    }
    const since = 175;
    const expectedLog = complete.log.filter((entry: any) => entry.revision > since);
    assert.equal(JSON.stringify(await readSqliteLogSince(file, since)), JSON.stringify(expectedLog));
    assertCountsMatch(await readSqliteCounts(file), expectedCounts(complete.nodes as Record<string, Record<string, unknown>>));
    assertCountsMatch(await readSqliteCounts(file, { status: "done", subkind: "task" }), expectedCounts(complete.nodes as Record<string, Record<string, unknown>>, { status: "done", subkind: "task" }));
    assert.equal(await readSqliteRevision(file), complete.revision);
  } finally { await rmTempProject(projectDir); }
});

test("10,000-node point reads use indexed bounded work and match full-state projections", async () => {
  const projectDir = await createTempProject();
  try {
    const state = syntheticState(10_000);
    await writeCanonicalState(projectDir, state);
    const { stateFile } = await import("../src/storage/state.ts");
    const { Database } = await import(SQLITE_MODULE);
    const { readSqliteState, readSqliteNode, readSqliteNodesByIds, readSqliteEdgesOf, readSqliteLogSince, readSqliteCounts, readSqliteRevision } = await import("../src/storage/sqlite/store.ts");
    const file = stateFile(projectDir);
    const db = new Database(file);
    try { db.query("UPDATE log SET state_revision = position + 1").run(); }
    finally { db.close(); }
    const complete = await readSqliteState(file);
    assert.ok(complete);
    const oneNodeRows = await countResultRows(() => readSqliteNode(file, "T-point-42"));
    assert.ok(oneNodeRows <= 20, `readSqliteNode read ${oneNodeRows} rows`);
    const node = await readSqliteNode(file, "T-point-42");
    assert.equal(JSON.stringify(node), JSON.stringify(complete.nodes["T-point-42"]));

    const ids = ["T-point-42", "T-point-43", "T-point-9999", "missing"];
    const idSet = new Set(ids);
    const boundedReads = [
      ["readSqliteNodesByIds", () => readSqliteNodesByIds(file, ids), 24],
      ["readSqliteEdgesOf", () => readSqliteEdgesOf(file, ids), 24],
      ["readSqliteLogSince", () => readSqliteLogSince(file, 9_990), 32],
      ["readSqliteCounts", () => readSqliteCounts(file), 24],
      ["readSqliteRevision", () => readSqliteRevision(file), 24],
    ] as const;
    for (const [operation, run, budget] of boundedReads) {
      const rowsRead = await countResultRows(run);
      assert.ok(rowsRead <= budget, `${operation} read ${rowsRead} rows (budget ${budget})`);
    }
    const expectedNodes = Object.fromEntries(Object.entries(complete.nodes).filter(([id]) => idSet.has(id)));
    assert.equal(JSON.stringify(await readSqliteNodesByIds(file, ids)), JSON.stringify(expectedNodes));
    const expectedEdges = complete.edges.filter((edge: any) => idSet.has(edge.from) || idSet.has(edge.to));
    assert.equal(JSON.stringify(await readSqliteEdgesOf(file, ids)), JSON.stringify(expectedEdges));
    assert.equal(JSON.stringify(await readSqliteEdgesOf(file, ids, { type: "BLOCKS" })), JSON.stringify(expectedEdges.filter((edge: any) => edge.type === "BLOCKS")));
    assert.equal(JSON.stringify(await readSqliteLogSince(file, 9_990)), JSON.stringify(complete.log.filter((_, index) => index + 1 > 9_990)));
    const expectedAllCounts = expectedCounts(complete.nodes as Record<string, Record<string, unknown>>);
    const { result: allCounts, selects: countSelects } = await observeNodeSelects(() => readSqliteCounts(file));
    assertCountsMatch(allCounts, expectedAllCounts);
    assert.equal(countSelects.length, 1, "unfiltered counts must use one aggregate query");
    assert.match(countSelects[0].sql, /COUNT\(\*\)\s+AS\s+count/i);
    assert.match(countSelects[0].sql, /GROUP\s+BY/i);
    assert.doesNotMatch(countSelects[0].sql, /node_body|body_hash/i);
    const expectedGroupCount = new Set(Object.values(complete.nodes).map((node: any) => JSON.stringify([node.kind ?? null, node.subkind ?? null, node.status ?? null]))).size;
    assert.equal(countSelects[0].rows.length, expectedGroupCount, "only grouped count rows should reach JavaScript");
    for (const row of countSelects[0].rows) {
      assert.deepEqual(Object.keys(row), ["kind", "subkind", "status", "count"]);
    }
    assert.equal(await readSqliteRevision(file), complete.revision);

    const plans = await Promise.all([
      dbPlan(file, "SELECT id, data, body_hash FROM nodes WHERE id = ?", ["T-point-42"]),
      dbPlan(file, "SELECT data FROM log INDEXED BY idx_log_state_revision_position WHERE state_revision > ? ORDER BY position", [9_990]),
      dbPlan(file, "SELECT position, data FROM edges WHERE from_id IN (?) OR to_id IN (?) ORDER BY position", ["T-point-42", "T-point-42"]),
      dbPlan(file, "SELECT data FROM edges WHERE (from_id IN (?) OR to_id IN (?)) AND edge_type = ? ORDER BY position", ["T-point-42", "T-point-42", "BLOCKS"]),
      dbPlan(file, "SELECT id, data, body_hash FROM nodes WHERE id IN (?, ?) ORDER BY position", ["T-point-42", "T-point-43"]),
      dbPlan(file, "SELECT json_extract(data, '$.kind') AS kind, json_extract(data, '$.subkind') AS subkind, json_extract(data, '$.status') AS status, COUNT(*) AS count FROM nodes WHERE json_extract(data, '$.kind') = ? AND json_extract(data, '$.subkind') = ? AND json_extract(data, '$.status') = ? GROUP BY kind, subkind, status ORDER BY MIN(position)", ["resolvable", "task", "open"]),
    ]);
    for (const [table, plan] of [["nodes", plans[0]], ["log", plans[1]], ["edges", plans[2]], ["edges", plans[3]], ["nodes", plans[4]], ["nodes", plans[5]]] as const) {
      assert.ok(plan.some((detail) => /\bSEARCH\b/i.test(detail)), `${table} query plan did not search an index: ${plan.join("; ")}`);
      assert.ok(!plan.some((detail) => new RegExp(`\\bSCAN\\s+${table}\\b`, "i").test(detail)), `${table} query plan scanned the table: ${plan.join("; ")}`);
    }
  } finally { await rmTempProject(projectDir); }
});

async function dbPlan(file: string, sql: string, args: unknown[]) {
  const { Database } = await import(SQLITE_MODULE);
  const database = new Database(file);
  try { return database.query(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(({ detail }) => detail as string); }
  finally { database.close(); }
}
