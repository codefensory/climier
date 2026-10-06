
// These pure projections compose graph semantics with domain providers. They
// have no filesystem, argv, mutation, or logging concerns.

import { incoming } from "../kernel/graph.ts";
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
}

function projectionArgs(input: ReadModelSnapshot | ProjectionArgs | undefined, id?: string): ProjectionArgs {
  if (input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, "snapshot")) {
    const args = input as ProjectionArgs;
    return { snapshot: args.snapshot, id: args.id };
  }
  return { snapshot: input as ReadModelSnapshot | undefined, id };
}


export function derive({ snapshot }: { snapshot?: ReadModelSnapshot } = {}) {
  return deriveV2(snapshot);
}


export function statusOf(input: ReadModelSnapshot | ProjectionArgs | undefined, id?: string) {
  const args = projectionArgs(input, id);
  const { snapshot } = args;
  const node = snapshot && snapshot.nodes ? snapshot.nodes[args.id as string] : null;
  if (node && node.kind === "resolvable" && node.subkind === "gate" && (node.status || "open") === "open") {
    return "open";
  }
  return taskStatusOfV2(snapshot, args.id);
}


export function blockingForNode(input: ReadModelSnapshot | ProjectionArgs | undefined, id?: string) {
  const { snapshot, id: targetId } = projectionArgs(input, id);
  return incoming(snapshot, targetId, "BLOCKS").map((edge) => ({
    edge_type: edge.type,
    node: gateProjection(snapshot, edge.from),
    satisfied: isSatisfiedV2(snapshot, edge.from),
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

export { deriveV2, isSatisfiedV2, gateProjection, isCurrent, supersededBy };
