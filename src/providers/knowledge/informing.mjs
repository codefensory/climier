// src/providers/knowledge/informing.mjs — pure informing helper for the
// knowledge provider.
// Returns the INFORMS edges of a node, projected as inline node data.
// Provides the `informingForNode` projection over a snapshot
// rather than reading state from the filesystem; this is the canonical

// Pure: no fs, no lock, no state, no log, no policy, no commands, no
// registry, no adapter, no CLI, no UI.

import { relations } from "../../kernel/graph.mjs";

function inlineNode(snapshot, id) {
  const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
  if (!node) {
    return {
      id,
      status: "missing",
      is_current: true,
      superseded_by: null,
    };
  }

  const supersedeEdges = (snapshot && Array.isArray(snapshot.edges) ? snapshot.edges : [])
    .filter((edge) => edge && edge.type === "SUPERSEDES" && edge.to === id);
  const supersededBy = supersedeEdges.length > 0
    ? supersedeEdges.map((edge) => edge.from).toSorted()[0]
    : null;
  return {
    ...node,
    is_current: supersededBy === null,
    superseded_by: supersededBy,
  };
}


export function informingForNode({ snapshot, id } = {}) {
  if (!snapshot || typeof snapshot !== "object") {
    return [];
  }
  if (typeof id !== "string" || id.length === 0) {
    return [];
  }
  const edges = relations(snapshot, id, "INFORMS");
  return edges.map((edge) => ({
    edge_type: edge.type,
    node: inlineNode(snapshot, edge.to),
  }));
}
