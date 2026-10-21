
// These pure projections compose graph semantics with domain providers. They
// have no filesystem, argv, mutation, or logging concerns.

import { createGraphProjection as buildGraphProjection, incoming, type GraphProjection } from "../kernel/graph.ts";
import type { ReadModelSnapshot } from "./types.ts";
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

interface ProjectionArgs {
  snapshot?: ReadModelSnapshot;
  id?: string;
  graph?: GraphProjection;
}

function projectionArgs(input: ReadModelSnapshot | ProjectionArgs | undefined, id?: string, graph?: GraphProjection): ProjectionArgs {
  if (input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, "snapshot")) {
    const args = input as ProjectionArgs;
    return { snapshot: args.snapshot, id: args.id, graph: args.graph };
  }
  return { snapshot: input as ReadModelSnapshot | undefined, id, graph };
}

export function createProjectionGraph(snapshot?: ReadModelSnapshot): GraphProjection {
  return buildGraphProjection(snapshot);
}

function projectionGraph(snapshot: ReadModelSnapshot | undefined, graph?: GraphProjection): GraphProjection {
  return graph || createProjectionGraph(snapshot);
}


export function derive({ snapshot, graph }: { snapshot?: ReadModelSnapshot; graph?: GraphProjection } = {}) {
  const currentGraph = projectionGraph(snapshot, graph);
  return deriveV2(snapshot, currentGraph);
}


export function statusOf(input: ReadModelSnapshot | ProjectionArgs | undefined, id?: string, graph?: GraphProjection) {
  const args = projectionArgs(input, id, graph);
  const { snapshot } = args;
  const node = snapshot && snapshot.nodes ? snapshot.nodes[args.id as string] : null;
  if (node && node.kind === "resolvable" && node.subkind === "gate" && (node.status || "open") === "open") {
    return "open";
  }
  const currentGraph = projectionGraph(snapshot, args.graph);
  return taskStatusOfV2(snapshot, args.id, currentGraph);
}


export function blockingForNode(input: ReadModelSnapshot | ProjectionArgs | undefined, id?: string, graph?: GraphProjection) {
  const { snapshot, id: targetId, graph: suppliedGraph } = projectionArgs(input, id, graph);
  const currentGraph = projectionGraph(snapshot, suppliedGraph);
  return incoming(snapshot, targetId, "BLOCKS", currentGraph.indexes).map((edge) => ({
    edge_type: edge.type,
    node: gateProjection(snapshot, edge.from, currentGraph),
    satisfied: isSatisfiedV2(snapshot, edge.from, new Set(), currentGraph),
  }));
}

export function unsatisfiedBlockerIdsForNode(
  input: ReadModelSnapshot | ProjectionArgs | undefined,
  id?: string,
  graph?: GraphProjection,
): string[] {
  const { snapshot, id: targetId, graph: suppliedGraph } = projectionArgs(input, id, graph);
  const currentGraph = projectionGraph(snapshot, suppliedGraph);
  const blockerIds: string[] = [];
  for (const edge of incoming(snapshot, targetId, "BLOCKS", currentGraph.indexes)) {
    if (isSatisfiedV2(snapshot, edge.from, new Set(), currentGraph)) {
      continue;
    }
    const blocker = snapshot?.nodes?.[edge.from];
    const blockerId = blocker ? blocker.id : edge.from;
    if (blockerId) {
      blockerIds.push(blockerId);
    }
  }
  return blockerIds;
}


export function knowledgeForNode(input: ReadModelSnapshot | ProjectionArgs | undefined, id?: string) {
  const { snapshot, id: targetId } = projectionArgs(input, id);
  return providerKnowledgeForNode({ snapshot, id: targetId });
}


export function informingForNode(input: ReadModelSnapshot | ProjectionArgs | undefined, id?: string) {
  const { snapshot, id: targetId } = projectionArgs(input, id);
  return providerInformingForNode({ snapshot, id: targetId });
}

export { deriveV2, isSatisfiedV2, gateProjection, isCurrent, supersededBy };
