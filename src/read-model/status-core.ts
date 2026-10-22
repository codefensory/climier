import { createGraphProjection, incoming, type GraphProjection } from "../kernel/graph.ts";
import { deriveV2, isSatisfiedV2, statusOfV2 as taskStatusOfV2 } from "../providers/task/derivation.ts";
import type { ReadModelSnapshot } from "./types.ts";
import { projectionArgs, type ProjectionArgs } from "./projection-args.ts";

export function createProjectionGraph(snapshot?: ReadModelSnapshot): GraphProjection {
  return createGraphProjection(snapshot);
}

export function projectionGraph(snapshot: ReadModelSnapshot | undefined, graph?: GraphProjection): GraphProjection {
  return graph || createProjectionGraph(snapshot);
}

export function derive({ snapshot, graph }: { snapshot?: ReadModelSnapshot; graph?: GraphProjection } = {}) {
  return deriveV2(snapshot, projectionGraph(snapshot, graph));
}

export function statusOf(input: ReadModelSnapshot | ProjectionArgs | undefined, id?: string, graph?: GraphProjection) {
  const args = projectionArgs(input, id, graph);
  const node = args.snapshot?.nodes?.[args.id as string];
  if (node && node.kind === "resolvable" && node.subkind === "gate" && (node.status || "open") === "open") {
    return "open";
  }
  return taskStatusOfV2(args.snapshot, args.id, projectionGraph(args.snapshot, args.graph));
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
