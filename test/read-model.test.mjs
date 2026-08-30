import test from "node:test";
import assert from "node:assert/strict";

import {
  derive,
  statusOf,
  blockingForNode,
  knowledgeForNode,
  informingForNode,
} from "../src/read-model/index.mjs";

const snapshot = {
  version: 2,
  initiatives: { work: {} },
  nodes: {
    gate: { id: "gate", kind: "resolvable", subkind: "gate", status: "resolved" },
    task: {
      id: "task", kind: "resolvable", subkind: "task", status: "open",
      initiative: "work", domain: "auth", tags: ["api"],
    },
    informed: { id: "informed", kind: "resolvable", subkind: "task", status: "open" },
    knowledge: {
      id: "knowledge", kind: "knowledge", status: "active", scope: { domains: ["auth"] },
    },
  },
  edges: [
    { from: "gate", to: "task", type: "BLOCKS" },
    { from: "task", to: "informed", type: "INFORMS" },
  ],
  log: [],
};

test("read-model composes canonical status and cross-domain projections from an explicit snapshot", () => {
  assert.deepEqual(derive({ snapshot }), {
    ready: ["task", "informed"],
    blocked: [],
    backlog: [],
    openGates: [],
  });
  assert.equal(statusOf({ snapshot, id: "task" }), "ready");
  assert.deepEqual(blockingForNode({ snapshot, id: "task" }), [{
    edge_type: "BLOCKS",
    node: { ...snapshot.nodes.gate, is_current: true, superseded_by: null },
    satisfied: true,
  }]);
  assert.equal(informingForNode({ snapshot, id: "task" })[0].node.id, "informed");
  assert.equal(knowledgeForNode({ snapshot, id: "task" })[0].id, "knowledge");
});

test("read-model preserves the legacy open status for gates", () => {
  const openGate = { ...snapshot, nodes: { ...snapshot.nodes, gate: { ...snapshot.nodes.gate, status: "open" } } };
  assert.equal(statusOf({ snapshot: openGate, id: "gate" }), "open");
});
