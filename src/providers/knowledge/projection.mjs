// src/providers/knowledge/projection.mjs — pure knowledge projection for a
// target node.
//
// Knowledge is selected by any matching scope. A match carries every scope
// that matched so consumers can explain why it was selected. Results are
// ranked by the most-specific matching scope and then by id. Deprecated and
// superseded knowledge remains visible here; lifecycle policy belongs to the
// caller (for example, context uses deprecated matches to emit an alert).
//
// Pure: no fs, no lock, no state, no log, no policy, no commands, no
// registry, no adapter, no CLI, no UI.

import { matchesScopes } from "./scopes.mjs";
import { rankKnowledge } from "./ranking.mjs";

/**
 * Project knowledge nodes matching the target node's scopes.
 *
 * @param {object} args
 * @param {object} args.snapshot - v2 state snapshot ({nodes, edges, ...}).
 * @param {string} args.id - Target node id.
 * @returns {object[]} Matching knowledge nodes with `scope_matches`.
 */
export function knowledgeForNode({ snapshot, id } = {}) {
  if (!snapshot || typeof snapshot !== "object") return [];
  if (typeof id !== "string" || id.length === 0) return [];
  if (!snapshot.nodes || typeof snapshot.nodes !== "object" || Array.isArray(snapshot.nodes)) return [];

  const node = snapshot.nodes[id];
  if (!node || typeof node !== "object") return [];

  const matches = Object.values(snapshot.nodes)
    .filter((candidate) => candidate && typeof candidate === "object" && candidate.kind === "knowledge")
    .map((candidate) => {
      const scopeMatches = matchesScopes(node, candidate);
      if (scopeMatches.length === 0) return null;
      return { ...candidate, scope_matches: scopeMatches };
    })
    .filter(Boolean);

  return rankKnowledge(matches);
}
