// Canonical core projections over a v2 snapshot.
//
// These pure projections compose graph semantics with domain providers. They
// have no filesystem, argv, mutation, or logging concerns.

import { incoming } from "../kernel/graph.mjs";
import {
  deriveV2,
  statusOfV2 as taskStatusOfV2,
  isSatisfiedV2,
} from "../providers/task/derivation.mjs";
import {
  gateProjection,
  isCurrent,
  supersededBy,
} from "../providers/gate/semantics.mjs";
import {
  knowledgeForNode as providerKnowledgeForNode,
  informingForNode as providerInformingForNode,
} from "../providers/knowledge/index.mjs";

function projectionArgs(input, id) {
  if (input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, "snapshot")) {
    return { snapshot: input.snapshot, id: input.id };
  }
  return { snapshot: input, id };
}

/** Derive the read-model task and gate pools from an explicit snapshot. */
export function derive({ snapshot } = {}) {
  return deriveV2(snapshot);
}

/**
 * Return the externally visible status for a node. Open gates are a
 * read-model status, rather than task readiness.
 */
export function statusOf(input, id) {
  const args = projectionArgs(input, id);
  const { snapshot } = args;
  const node = snapshot && snapshot.nodes ? snapshot.nodes[args.id] : null;
  if (node && node.kind === "resolvable" && node.subkind === "gate" && (node.status || "open") === "open") {
    return "open";
  }
  return taskStatusOfV2(snapshot, args.id);
}

/** Project BLOCKS dependencies with gate projection and task satisfaction. */
export function blockingForNode(input, id) {
  const { snapshot, id: targetId } = projectionArgs(input, id);
  return incoming(snapshot, targetId, "BLOCKS").map((edge) => ({
    edge_type: edge.type,
    node: gateProjection(snapshot, edge.from),
    satisfied: isSatisfiedV2(snapshot, edge.from),
  }));
}

/** Project knowledge matching the target node's explicit scopes. */
export function knowledgeForNode(input, id) {
  const { snapshot, id: targetId } = projectionArgs(input, id);
  return providerKnowledgeForNode({ snapshot, id: targetId });
}

/** Project INFORMS relations as inline nodes. */
export function informingForNode(input, id) {
  const { snapshot, id: targetId } = projectionArgs(input, id);
  return providerInformingForNode({ snapshot, id: targetId });
}

export { deriveV2, isSatisfiedV2, gateProjection, isCurrent, supersededBy };
