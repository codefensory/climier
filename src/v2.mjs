// v2 compatibility facade.
//
// Domain semantics live in the kernel/providers. This module only preserves
// the historical import surface used by the CLI and UI while those consumers
// migrate to the canonical provider APIs.

export { throwV2 } from "./errors.mjs";
export { EDGE_TYPES, existingEdge, blocksEdge, validateEdge } from "./kernel/edges.mjs";

import { EDGE_TYPES } from "./kernel/edges.mjs";
import { incoming } from "./kernel/graph.mjs";
import {
  supersededBy,
  isCurrent,
  gateProjection,
} from "./providers/gate/semantics.mjs";
import {
  deriveV2,
  statusOfV2 as providerStatusOfV2,
  isSatisfiedV2,
} from "./providers/task/derivation.mjs";
import {
  knowledgeForNode as projectKnowledge,
  informingForNode as projectInforming,
} from "./providers/knowledge/index.mjs";

// Historical read-only alias. Deprecated relation types remain readable in
// old snapshots, while EDGE_TYPES is the mutation whitelist.
export const EDGE_TYPE_CONSTANTS = Object.freeze([
  "BLOCKS",
  "INFORMS",
  "SUPERSEDES",
  "DERIVED_FROM",
  "RELATES_TO",
  "CONFLICTS_WITH",
]);

// These names are direct provider re-exports so callers cannot accidentally
// observe a second implementation of graph/lifecycle semantics.
export { supersededBy, isCurrent, deriveV2, isSatisfiedV2 };

// The task provider owns task status derivation. Gates historically expose
// their persisted `open` status through this facade, so retain that one
// compatibility distinction while consumers migrate to provider APIs.
export const statusOfV2 = (state, id) => {
  const node = state && state.nodes ? state.nodes[id] : null;
  if (node && node.kind === "resolvable" && node.subkind === "gate" && (node.status || "open") === "open") {
    return "open";
  }
  return providerStatusOfV2(state, id);
};

// The old read surface accepts (state, id); providers accept an explicit
// snapshot object. These adapters contain no domain rules: they only preserve
// that argument shape during the consumer migration.
export const knowledgeForNode = (state, id) => projectKnowledge({ snapshot: state, id });
export const informingForNode = (state, id) => projectInforming({ snapshot: state, id });

// `blockingForNode` combines the kernel traversal with the canonical gate
// projection and task satisfaction provider, as required by the read contract.
export const blockingForNode = (state, id) => incoming(state, id, "BLOCKS").map((edge) => ({
  edge_type: edge.type,
  node: gateProjection(state, edge.from),
  satisfied: isSatisfiedV2(state, edge.from),
}));
