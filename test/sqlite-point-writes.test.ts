import test from "node:test";
import assert from "node:assert/strict";
import { applyRemoteChanges } from "../src/application/operations/index.ts";
import { readSqliteChangesSince, readSqliteState, updateSqliteState, writeSqliteState } from "../src/storage/sqlite/store.ts";
import { stateFile } from "../src/storage/state.ts";
import { createTempProject, rmTempProject } from "./helpers.ts";

const SQLITE_MODULE = "bun:sqlite";
type TestState = {
  version: number;
  revision: number;
  nodes: Record<string, ReturnType<typeof node>>;
  edges: Array<{ from: string; to: string; type: string }>;
  initiatives: Record<string, { desc: string }>;
  log: Array<Record<string, unknown>>;
  plugins: Record<string, unknown>;
};

const node = (id: string, title: string, body: string) => ({
  id,
  kind: "resolvable",
  subkind: "task",
  title,
  body,
  status: "open",
});

function initialState(): TestState {
  return {
    version: 1,
    revision: 0,
    nodes: {
      "T-one": node("T-one", "One", "first body"),
      "T-two": node("T-two", "Two", "second body"),
    },
    edges: [{ from: "T-one", to: "T-two", type: "BLOCKS" }],
    initiatives: { core: { desc: "Core" } },
    log: [],
    plugins: { demo: { enabled: true } },
  };
}

test("SQLite state writes touch only changed collection rows", async () => {
  const projectDir = await createTempProject();
  try {
    const file = stateFile(projectDir);
    const previous = initialState();
    await writeSqliteState(file, previous);
    const { Database } = await import(SQLITE_MODULE);
    const database = new Database(file);
    try {
      database.exec(`
        CREATE TABLE write_audit (table_name TEXT, operation TEXT);
        CREATE TRIGGER audit_nodes_update AFTER UPDATE ON nodes BEGIN INSERT INTO write_audit VALUES ('nodes', 'update'); END;
        CREATE TRIGGER audit_nodes_delete AFTER DELETE ON nodes BEGIN INSERT INTO write_audit VALUES ('nodes', 'delete'); END;
        CREATE TRIGGER audit_nodes_insert AFTER INSERT ON nodes BEGIN INSERT INTO write_audit VALUES ('nodes', 'insert'); END;
        CREATE TRIGGER audit_edges_update AFTER UPDATE ON edges BEGIN INSERT INTO write_audit VALUES ('edges', 'update'); END;
        CREATE TRIGGER audit_edges_delete AFTER DELETE ON edges BEGIN INSERT INTO write_audit VALUES ('edges', 'delete'); END;
        CREATE TRIGGER audit_edges_insert AFTER INSERT ON edges BEGIN INSERT INTO write_audit VALUES ('edges', 'insert'); END;
        CREATE TRIGGER audit_initiatives_update AFTER UPDATE ON initiatives BEGIN INSERT INTO write_audit VALUES ('initiatives', 'update'); END;
        CREATE TRIGGER audit_initiatives_delete AFTER DELETE ON initiatives BEGIN INSERT INTO write_audit VALUES ('initiatives', 'delete'); END;
        CREATE TRIGGER audit_initiatives_insert AFTER INSERT ON initiatives BEGIN INSERT INTO write_audit VALUES ('initiatives', 'insert'); END;
        CREATE TRIGGER audit_log_update AFTER UPDATE ON log BEGIN INSERT INTO write_audit VALUES ('log', 'update'); END;
        CREATE TRIGGER audit_log_delete AFTER DELETE ON log BEGIN INSERT INTO write_audit VALUES ('log', 'delete'); END;
        CREATE TRIGGER audit_log_insert AFTER INSERT ON log BEGIN INSERT INTO write_audit VALUES ('log', 'insert'); END;
        CREATE TRIGGER audit_meta_revision AFTER UPDATE ON meta WHEN OLD.key = 'revision' BEGIN INSERT INTO write_audit VALUES ('meta.revision', 'update'); END;
      `);
    } finally {
      database.close();
    }

    const next = {
      ...previous,
      revision: 1,
      nodes: { ...previous.nodes, "T-one": node("T-one", "Updated", "updated body") },
      log: [{ action: "task.update", node: "T-one" }],
    };
    await writeSqliteState(file, next, previous);

    const audit = new Database(file);
    try {
      const writes = audit.query("SELECT table_name, operation, COUNT(*) AS count FROM write_audit GROUP BY table_name, operation ORDER BY table_name, operation").all();
      assert.deepEqual(writes, [
        { table_name: "log", operation: "insert", count: 1 },
        { table_name: "meta.revision", operation: "update", count: 1 },
        { table_name: "nodes", operation: "update", count: 1 },
      ]);
      assert.deepEqual(audit.query("SELECT body FROM node_body ORDER BY body").all(), [
        { body: "second body" },
        { body: "updated body" },
      ]);
      audit.exec("DELETE FROM write_audit");
    } finally {
      audit.close();
    }

    await updateSqliteState(file, (state) => state);

    const noOpAudit = new Database(file);
    try {
      assert.equal(noOpAudit.query("SELECT COUNT(*) AS count FROM write_audit WHERE table_name = 'nodes'").get().count, 0);
      assert.equal(noOpAudit.query("SELECT COUNT(*) AS count FROM write_audit WHERE table_name = 'meta.revision'").get().count, 0);
    } finally {
      noOpAudit.close();
    }
  } finally {
    await rmTempProject(projectDir);
  }
});

test("in-place updateState mutations persist node, edge, removal, and log changes", async () => {
  const projectDir = await createTempProject();
  try {
    const file = stateFile(projectDir);
    const initial = initialState();
    initial.revision = 1;
    await writeSqliteState(file, initial);

    await updateSqliteState(file, (state) => {
      state.revision = 2;
      const nodes = state.nodes as TestState["nodes"];
      nodes["T-one"].title = "Updated in place";
      delete nodes["T-two"];
      (state.edges as unknown[]).splice(0, 1);
      (state.log as unknown[]).push({ action: "task.update", node: "T-one" });
      return state;
    });

    const actual = await readSqliteState(file);
    assert.equal(actual.revision, 2);
    assert.equal(actual.nodes["T-one"].title, "Updated in place");
    assert.equal(Object.hasOwn(actual.nodes, "T-two"), false);
    assert.deepEqual(actual.edges, []);
    assert.deepEqual(actual.log, [{ action: "task.update", node: "T-one" }]);
  } finally {
    await rmTempProject(projectDir);
  }
});

test("a revision without a new audit entry still records its state delta", async () => {
  const projectDir = await createTempProject();
  try {
    const file = stateFile(projectDir);
    const previous = { ...initialState(), revision: 1, log: [{ action: "seed" }] };
    await writeSqliteState(file, previous);
    const next = { ...previous, revision: 2, nodes: { ...previous.nodes, "T-one": node("T-one", "Changed", "changed") } };
    await writeSqliteState(file, next, previous);

    const changes = await readSqliteChangesSince(file, 1);
    assert.equal(changes.reset_required, false);
    assert.equal(changes.changes.length, 1);
    assert.equal(JSON.stringify(applyRemoteChanges(previous, changes)), JSON.stringify(await readSqliteState(file)));
  } finally {
    await rmTempProject(projectDir);
  }
});

test("50 incremental SQLite writes equal full replacements and retain an exact delta chain", async () => {
  const incrementalDir = await createTempProject();
  const replacementDir = await createTempProject();
  try {
    const incrementalFile = stateFile(incrementalDir);
    const replacementFile = stateFile(replacementDir);
    let state = initialState();
    const initial = state;
    await writeSqliteState(incrementalFile, state);
    await writeSqliteState(replacementFile, state);

    for (let revision = 1; revision <= 50; revision += 1) {
      const previous = state;
      const next = {
        ...previous,
        revision,
        nodes: { ...previous.nodes },
        edges: [...previous.edges],
        initiatives: { ...previous.initiatives },
        log: [...previous.log, { action: "test.mutation", revision }],
        plugins: { demo: { enabled: revision % 2 === 0, revision } },
      };
      switch (revision % 5) {
        case 0:
          next.nodes["T-one"] = node("T-one", `One ${revision}`, `body ${revision}`);
          break;
        case 1:
          next.nodes[`T-added-${revision}`] = node(`T-added-${revision}`, `Added ${revision}`, `body ${revision}`);
          break;
        case 2:
          delete next.nodes[`T-added-${revision - 1}`];
          break;
        case 3: {
          const ids = Object.keys(next.nodes);
          next.edges = [{ from: ids[0], to: ids.at(-1)!, type: "DERIVED_FROM" }];
          break;
        }
        case 4:
          next.initiatives.core = { desc: `Core ${revision}` };
          next.initiatives[`initiative-${revision}`] = { desc: `Added ${revision}` };
          break;
      }
      await writeSqliteState(incrementalFile, next, previous);
      await writeSqliteState(replacementFile, next, null);
      state = next;
    }

    const incremental = await readSqliteState(incrementalFile);
    const replacement = await readSqliteState(replacementFile);
    assert.equal(JSON.stringify(incremental), JSON.stringify(replacement));

    const changes = await readSqliteChangesSince(incrementalFile, initial.revision);
    assert.equal(changes.reset_required, false);
    assert.deepEqual(changes.changes.map(({ revision }) => revision), Array.from({ length: 50 }, (_, index) => index + 1));
    assert.equal(JSON.stringify(applyRemoteChanges(initial, changes)), JSON.stringify(incremental));
  } finally {
    await rmTempProject(incrementalDir);
    await rmTempProject(replacementDir);
  }
});
