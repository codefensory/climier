import assert from "node:assert/strict";
import test from "node:test";
import { createTransaction } from "../src/kernel/transaction.ts";
import {
  assignRevisionsAndDiff,
  computeEdgeDiff,
  computeInitiativeDiff,
} from "../src/kernel/mutation/diff.ts";

function largeSnapshot(): {
  version: number;
  revision: number;
  nodes: Record<string, Record<string, unknown>>;
  edges: Array<{ from: string; to: string; type: string }>;
  initiatives: Record<string, { desc: string }>;
  log: unknown[];
} {
  const nodes = {};
  const initiatives = {};
  for (let i = 0; i < 100; i += 1) {
    const id = `T${i}`;
    nodes[id] = { id, kind: "resolvable", subkind: "task", title: id, revision: i + 1 };
    initiatives[`initiative-${i}`] = { desc: `initiative ${i}` };
  }
  const edges: Array<{ from: string; to: string; type: string }> = [];
  for (let i = 0; i < 80; i += 4) {
    edges.push({ from: `T${i}`, to: `T${i + 1}`, type: "BLOCKS" });
  }
  return { version: 1, revision: 100, nodes, edges, initiatives, log: [] };
}

test("mutation diff compares only node, edge, and initiative ids touched by the draft", () => {
  const snapshot = largeSnapshot();
  const tx = createTransaction(snapshot);
  tx.updateNode("T99", { title: "updated" });
  tx.addEdge({ from: "T99", to: "T0", type: "BLOCKS" });
  tx.createInitiative({ name: "new-initiative", desc: "new" });

  const dirtyIds = tx.getDirtyIds();
  assert.deepEqual(dirtyIds, {
    nodes: ["T99"],
    edges: ["T99|T0|BLOCKS"],
    initiatives: ["new-initiative"],
  });

  const compared: string[] = [];
  const draft = tx.view();
  let draftNodeEnumerations = 0;
  const nodes = new Proxy(draft.nodes, {
    ownKeys(target) {
      draftNodeEnumerations += 1;
      return Reflect.ownKeys(target);
    },
  });
  const nodeDiff = assignRevisionsAndDiff(snapshot, { ...draft, nodes }, dirtyIds.nodes, (id) => compared.push(`node:${id}`));
  assert.equal(draftNodeEnumerations, 0, "dirty node diff must not enumerate the full draft node collection");
  let draftEdgeVisits = 0;
  const edges = new Proxy(draft.edges, {
    ownKeys(target) {
      draftEdgeVisits += 1;
      return Reflect.ownKeys(target);
    },
    get(target, key, receiver) {
      if (key === Symbol.iterator || (typeof key === "string" && /^\d+$/.test(key))) {draftEdgeVisits += 1;}
      return Reflect.get(target, key, receiver);
    },
  });
  const edgeDiff = computeEdgeDiff(snapshot.edges, edges, tx.getDirtyEdgeChanges(), (key) => compared.push(`edge:${key}`));
  assert.equal(draftEdgeVisits, 0, "dirty edge diff must not visit the full draft edge collection");
  const initiativeDiff = computeInitiativeDiff(snapshot.initiatives, draft.initiatives, dirtyIds.initiatives, (name) => compared.push(`initiative:${name}`));

  assert.deepEqual(compared, ["node:T99", "edge:T99|T0|BLOCKS", "initiative:new-initiative"]);
  assert.deepEqual(nodeDiff, assignRevisionsAndDiff(snapshot, draft));
  assert.deepEqual(edgeDiff, computeEdgeDiff(snapshot.edges, draft.edges));
  assert.deepEqual(initiativeDiff, computeInitiativeDiff(snapshot.initiatives, draft.initiatives));
  assert.deepEqual((nodeDiff.updated as Array<{ id: string }>).map(({ id }) => id), ["T99"]);
  assert.deepEqual(edgeDiff.added, [{ from: "T99", to: "T0", type: "BLOCKS" }]);
  assert.deepEqual((initiativeDiff.created as Array<{ name: string }>).map(({ name }) => name), ["new-initiative"]);
});

test("dirty edge diff cancels add-then-remove and remove-then-add sequences", () => {
  const snapshot = largeSnapshot();
  const tx = createTransaction(snapshot);
  tx.addEdge({ from: "T99", to: "T0", type: "BLOCKS" });
  tx.removeEdge({ from: "T99", to: "T0", type: "BLOCKS" });
  tx.removeEdge({ from: "T0", to: "T1", type: "BLOCKS" });
  tx.addEdge({ from: "T0", to: "T1", type: "BLOCKS" });

  const diff = computeEdgeDiff(snapshot.edges, tx.view().edges, tx.getDirtyEdgeChanges());
  assert.deepEqual(diff, { added: [], removed: [] });
});
