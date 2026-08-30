// src/providers/knowledge/informing.mjs — pure informing helper for the
// knowledge-core provider slice (plan B4-knowledge-core).
//
// Returns the INFORMS edges of a node, projected as inline node data.
// Provides the `informingForNode` projection over a snapshot
// rather than reading state from the filesystem; the provider stays the
// new canonical implementation per ADR-012 §3.
//
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
  // Compute `superseded_by` from snapshot edges via `incoming` (kernel
  // traversal). The traversal tolerates missing edges; we still default
  // to null defensively.
  const supersedeEdges = (snapshot && Array.isArray(snapshot.edges) ? snapshot.edges : [])
    .filter((edge) => edge && edge.type === "SUPERSEDES" && edge.to === id);
  const supersededBy = supersedeEdges.length > 0
    ? supersedeEdges.map((edge) => edge.from).sort()[0]
    : null;
  return {
    ...node,
    is_current: supersededBy === null,
    superseded_by: supersededBy,
  };
}

/**
 * INFORMS edges of `id`, projected as inline node data.
 *
 * @param {object} args
 * @param {object} args.snapshot - v2 state snapshot ({nodes, edges, ...}).
 * @param {string} args.id - Target node id.
 * @returns {Array<{ edge_type: string, node: object }>}
 */
export function informingForNode({ snapshot, id } = {}) {
  if (!snapshot || typeof snapshot !== "object") return [];
  if (typeof id !== "string" || id.length === 0) return [];
  const edges = relations(snapshot, id, "INFORMS");
  return edges.map((edge) => ({
    edge_type: edge.type,
    node: inlineNode(snapshot, edge.to),
  }));
}
