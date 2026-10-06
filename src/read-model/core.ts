
// These pure projections compose graph semantics with domain providers. They
// have no filesystem, argv, mutation, or logging concerns.

import { incoming } from "../kernel/graph.ts";
import {
  deriveV2,
  statusOfV2 as taskStatusOfV2,
  isSatisfiedV2,
} from "../providers/task/derivation.ts";
import {
  gateProjection,
  isCurrent,
  supersededBy,
} from "../providers/gate/semantics.ts";
import {
  knowledgeForNode as providerKnowledgeForNode,
  informingForNode as providerInformingForNode,
} from "../providers/knowledge/index.ts";

function projectionArgs(input, id) {
  if (input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, "snapshot")) {
    return { snapshot: input.snapshot, id: input.id };
  }
  return { snapshot: input, id };
}


export function derive({ snapshot } = {}) {
  return deriveV2(snapshot);
}


export function statusOf(input, id) {
  const args = projectionArgs(input, id);
  const { snapshot } = args;
  const node = snapshot && snapshot.nodes ? snapshot.nodes[args.id] : null;
  if (node && node.kind === "resolvable" && node.subkind === "gate" && (node.status || "open") === "open") {
    return "open";
  }
  return taskStatusOfV2(snapshot, args.id);
}


export function blockingForNode(input, id) {
  const { snapshot, id: targetId } = projectionArgs(input, id);
  return incoming(snapshot, targetId, "BLOCKS").map((edge) => ({
    edge_type: edge.type,
    node: gateProjection(snapshot, edge.from),
    satisfied: isSatisfiedV2(snapshot, edge.from),
  }));
}


export function knowledgeForNode(input, id) {
  const { snapshot, id: targetId } = projectionArgs(input, id);
  return providerKnowledgeForNode({ snapshot, id: targetId });
}


export function informingForNode(input, id) {
  const { snapshot, id: targetId } = projectionArgs(input, id);
  return providerInformingForNode({ snapshot, id: targetId });
}

export { deriveV2, isSatisfiedV2, gateProjection, isCurrent, supersededBy };
