// Canonical read-only projections over a v2 snapshot.
//
// This layer is the only place that composes graph semantics with domain
// providers. It has no filesystem, argv, mutation, or logging concerns. The
// object-shaped arguments are the canonical API; the positional form is kept
// solely so the temporary v2 facade can preserve its historical import shape.

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

/**
 * Derive the read-model task and gate pools from an explicit snapshot.
 *
 * @param {{snapshot: object}} args
 */
export function derive({ snapshot } = {}) {
  return deriveV2(snapshot);
}

/**
 * Return the externally visible status for a node.
 *
 * Open gates are a read-model status, rather than task readiness. The task
 * provider intentionally only derives task lifecycle and readiness.
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

/**
 * Project BLOCKS dependencies, combining kernel traversal, gate projection,
 * and task satisfaction into one read-model result.
 */
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

// Descriptive aliases for new consumers. The V2 names are retained only as
// compatibility aliases while the remaining consumers migrate off v2.mjs.
export const deriveReadModel = derive;
export const statusOfV2 = statusOf;
export const projectStatus = statusOf;
export const projectBlocking = blockingForNode;
export const projectKnowledge = knowledgeForNode;
export const projectInforming = informingForNode;

export { deriveV2, isSatisfiedV2 };
export {
  gateProjection,
  isCurrent,
  supersededBy,
};
