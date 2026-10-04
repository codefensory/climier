import test from "node:test";
import assert from "node:assert/strict";

import {
  derive,
  statusOf,
  blockingForNode,
  knowledgeForNode,
  informingForNode,
  projectStatusView,
  projectContextView,
  projectStatus,
} from "../src/read-model/index.mjs";
import { readModelParity } from "./fixtures/read-model-parity.mjs";

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

test("shared status and context views project parity fixture at one fixed epoch time", () => {
  const now = Date.parse("2025-01-04T00:00:00.000Z");
  const status = projectStatusView({ snapshot: readModelParity.snapshot, filters: { "stale-ms": 0 }, now });
  const context = projectContextView({ snapshot: readModelParity.snapshot, id: "T-progress", agent: "alice", staleMs: 0, now });

  assert.deepEqual(status.summary, { ready: 3, in_progress: 1, submitted: 1, blocked: 1, backlog: 1, open_gates: 1, active_knowledge: 3 });
  assert.equal(status.alerts[0].age_ms, now - Date.parse("2000-01-01T00:00:00.000Z"));
  assert.equal(context.claim.stale, true);
  assert.equal(context.alerts[0].kind, "STALE_CLAIM");
  assert.deepEqual(context.allowed_actions, ["submit", "release", "add-note", "update"]);
  assert.equal(projectStatus, statusOf);
});

test("shared read views require a sampled epoch-ms value and preserve neutral missing context", () => {
  assert.throws(() => projectStatusView({ snapshot }), /now.*epoch-ms/);
  assert.throws(() => projectContextView({ snapshot, id: "missing" }), /now.*epoch-ms/);
  const now = 0;
  assert.equal(projectContextView({ snapshot, id: "missing", now }), null);

  const originalNow = Date.now;
  Date.now = () => { throw new Error("projection must not sample its own clock"); };
  try {
    assert.equal(projectStatusView({ snapshot, now }).summary.ready, 2);
    assert.equal(projectContextView({ snapshot, id: "task", now }).claim, null);
  } finally {
    Date.now = originalNow;
  }
});