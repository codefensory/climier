// Compatibility facade tests: v2 keeps the historical exports while routing
// graph semantics to their kernel/provider implementations.
import test from "node:test";
import assert from "node:assert/strict";

import { throwV2 } from "../src/errors.mjs";
import { EDGE_TYPES, existingEdge, blocksEdge, validateEdge } from "../src/kernel/edges.mjs";
import { deriveV2, isSatisfiedV2 } from "../src/providers/task/derivation.mjs";
import { supersededBy, isCurrent, isSatisfied, gateProjection } from "../src/providers/gate/semantics.mjs";
import {
  knowledgeForNode as projectKnowledge,
  informingForNode as projectInforming,
} from "../src/providers/knowledge/index.mjs";

import * as facade from "../src/v2.mjs";

test("v2 facade re-exports kernel, provider, and error primitives", () => {
  assert.equal(facade.throwV2, throwV2);
  assert.equal(facade.EDGE_TYPES, EDGE_TYPES);
  assert.equal(facade.existingEdge, existingEdge);
  assert.equal(facade.blocksEdge, blocksEdge);
  assert.equal(facade.validateEdge, validateEdge);
  assert.equal(facade.deriveV2, deriveV2);
  assert.equal(facade.isSatisfiedV2, isSatisfiedV2);
  assert.equal(facade.supersededBy, supersededBy);
  assert.equal(facade.isCurrent, isCurrent);
});

test("v2 facade preserves legacy state/id projections over provider APIs", () => {
  const state = {
    version: 2,
    initiatives: { work: {} },
    nodes: {
      old: { id: "old", kind: "resolvable", subkind: "gate", status: "superseded" },
      newer: { id: "newer", kind: "resolvable", subkind: "gate", status: "resolved" },
      task: {
        id: "task", kind: "resolvable", subkind: "task", status: "open",
        initiative: "work", domain: "auth", tags: ["api"],
      },
      knowledge: {
        id: "knowledge", kind: "knowledge", status: "active", scope: { domains: ["auth"] },
      },
      informed: { id: "informed", kind: "resolvable", subkind: "task", status: "open" },
    },
    edges: [
      { from: "newer", to: "old", type: "SUPERSEDES" },
      { from: "old", to: "task", type: "BLOCKS" },
      { from: "task", to: "informed", type: "INFORMS" },
    ],
    log: [],
  };

  assert.equal(facade.isSatisfiedV2(state, "old"), isSatisfied(state, "old"));
  assert.equal(facade.statusOfV2(state, "old"), "superseded");
  assert.equal(facade.statusOfV2({ ...state, nodes: { ...state.nodes, old: { ...state.nodes.old, status: "open" } } }, "old"), "open");
  assert.deepEqual(facade.blockingForNode(state, "task"), [{
    edge_type: "BLOCKS",
    node: gateProjection(state, "old"),
    satisfied: true,
  }]);
  assert.deepEqual(
    facade.informingForNode(state, "task"),
    projectInforming({ snapshot: state, id: "task" }),
  );
  assert.deepEqual(
    facade.knowledgeForNode(state, "task"),
    projectKnowledge({ snapshot: state, id: "task" }),
  );
});
