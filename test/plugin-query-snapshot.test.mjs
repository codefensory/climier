import test from "node:test";
import assert from "node:assert/strict";

import {
  createTempProject,
  rmTempProject,
  importFresh,
  writeState,
} from "./helpers.mjs";

function snapshotState() {
  return {
    version: 4,
    revision: 17,
    initiatives: {},
    nodes: {
      "T-z": {
        id: "T-z",
        kind: "resolvable",
        subkind: "task",
        status: "open",
        plugins: {
          "plugin.a": { data: { node: "a" } },
          "plugin.b": { data: { secret: "b" } },
        },
      },
      "T-a": {
        id: "T-a",
        kind: "resolvable",
        subkind: "task",
        status: "done",
        plugins: {
          "plugin.a": { data: { node: "a2" } },
        },
      },
      "G-open": {
        id: "G-open",
        kind: "resolvable",
        subkind: "gate",
        status: "open",
      },
    },
    edges: [
      { from: "T-z", to: "T-a", type: "DERIVED_FROM" },
      { from: "G-open", to: "T-z", type: "BLOCKS" },
      { from: "T-a", to: "T-z", type: "SUPERSEDES" },
    ],
    plugins: {
      "plugin.b": { data: { secret: "project-b" }, meta: { private: true } },
      "plugin.a": { data: { project: "a" }, meta: { private: false } },
    },
    log: [],
  };
}

test("read-model projectSnapshot creates a deterministic core lifecycle projection", async () => {
  const { projectSnapshot } = await importFresh("./read-model/index.mjs");
  const source = snapshotState();
  const out = projectSnapshot({ snapshot: source, pluginId: "plugin.a" });

  assert.deepEqual(Object.keys(out), ["revision", "nodes", "edges", "derived", "plugins"]);
  assert.equal(out.revision, 17);
  assert.deepEqual(Object.keys(out.nodes), ["G-open", "T-a", "T-z"]);
  assert.deepEqual(out.edges, [
    { from: "G-open", to: "T-z", type: "BLOCKS" },
    { from: "T-a", to: "T-z", type: "SUPERSEDES" },
    { from: "T-z", to: "T-a", type: "DERIVED_FROM" },
  ]);
  assert.deepEqual(out.derived, {
    "G-open": "open",
    "T-a": "done",
    "T-z": "blocked",
  });
  assert.deepEqual(out.plugins, {
    "plugin.a": { data: { project: "a" }, meta: { private: false } },
  });
  assert.deepEqual(out.nodes["T-z"].plugins, {
    "plugin.a": { data: { node: "a" } },
  });
  assert.equal(out.nodes["T-z"].plugins["plugin.b"], undefined);

  out.nodes["T-z"].plugins["plugin.a"].data.node = "changed";
  assert.equal(source.nodes["T-z"].plugins["plugin.a"].data.node, "a");
});

test("api.query.snapshot reads one coherent state and exposes only the caller namespace", async () => {
  const dir = await createTempProject();
  try {
    await writeState(dir, snapshotState());
    const { createApi } = await importFresh("./plugins/api.mjs");
    const api = createApi({ projectDir: dir, agent: "alice", pluginId: "plugin.a" });
    assert.equal(typeof api.query.snapshot, "function");

    const out = await api.query.snapshot();
    assert.equal(out.revision, 17);
    assert.deepEqual(Object.keys(out.nodes), ["G-open", "T-a", "T-z"]);
    assert.deepEqual(Object.keys(out.plugins), ["plugin.a"]);
    assert.equal(out.plugins["plugin.b"], undefined);
    assert.equal(out.nodes["T-z"].plugins["plugin.b"], undefined);
    assert.deepEqual(out.derived, {
      "G-open": "open",
      "T-a": "done",
      "T-z": "blocked",
    });
  } finally {
    await rmTempProject(dir);
  }
});
