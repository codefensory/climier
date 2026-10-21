
// These pure projections compose graph semantics with domain providers. They
// have no filesystem, argv, mutation, or logging concerns.

import { incoming, type GraphProjection } from "../kernel/graph.ts";
import { projectionArgs, type ProjectionArgs } from "./projection-args.ts";
import { createProjectionGraph, derive, projectionGraph, statusOf, unsatisfiedBlockerIdsForNode } from "./status-core.ts";
import type { ReadModelSnapshot } from "./types.ts";
import { deriveV2, isSatisfiedV2 } from "../providers/task/derivation.ts";
import {
  gateProjection,
  isCurrent,
  supersededBy,
} from "../providers/gate/semantics.ts";
import { knowledgeForNode as providerKnowledgeForNode } from "../providers/knowledge/projection.ts";
import { informingForNode as providerInformingForNode } from "../providers/knowledge/informing.ts";

export function blockingForNode(input: ReadModelSnapshot | ProjectionArgs | undefined, id?: string, graph?: GraphProjection) {
  const { snapshot, id: targetId, graph: suppliedGraph } = projectionArgs(input, id, graph);
  const currentGraph = projectionGraph(snapshot, suppliedGraph);
  return incoming(snapshot, targetId, "BLOCKS", currentGraph.indexes).map((edge) => ({
    edge_type: edge.type,
    node: gateProjection(snapshot, edge.from, currentGraph),
    satisfied: isSatisfiedV2(snapshot, edge.from, new Set(), currentGraph),
  }));
}

export function knowledgeForNode(input: ReadModelSnapshot | ProjectionArgs | undefined, id?: string) {
  const { snapshot, id: targetId } = projectionArgs(input, id);
  return providerKnowledgeForNode({ snapshot, id: targetId });
}


export function informingForNode(input: ReadModelSnapshot | ProjectionArgs | undefined, id?: string) {
  const { snapshot, id: targetId } = projectionArgs(input, id);
  return providerInformingForNode({ snapshot, id: targetId });
}

export { createProjectionGraph, derive, statusOf, unsatisfiedBlockerIdsForNode, deriveV2, isSatisfiedV2, gateProjection, isCurrent, supersededBy };
