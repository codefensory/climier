// src/providers/knowledge/projection.mjs — pure knowledge projection for a
// target node.
// Knowledge is selected by any matching scope. A match carries every scope
// that matched so consumers can explain why it was selected. Results are

// superseded knowledge remains visible here; lifecycle policy belongs to the

// Pure: no fs, no lock, no state, no log, no policy, no commands, no
// registry, no adapter, no CLI, no UI.

import { matchesScopes } from "./scopes.mjs";
import { rankKnowledge } from "./ranking.mjs";

function projectCandidate(node, candidate) {
  if (!candidate || typeof candidate !== "object" || candidate.kind !== "knowledge") {
    return null;
  }
  const scopeMatches = matchesScopes(node, candidate);
  if (scopeMatches.length === 0) {
    return null;
  }
  return { ...candidate, scope_matches: scopeMatches };
}

function matchingKnowledge(node, nodes) {
  const matches = [];
  for (const candidate of Object.values(nodes)) {
    const projected = projectCandidate(node, candidate);
    if (projected) {
      matches.push(projected);
    }
  }
  return matches;
}

function validNodes(nodes) {
  return nodes && typeof nodes === "object" && !Array.isArray(nodes);
}

function targetNode(snapshot, id) {
  return validNodes(snapshot.nodes) ? snapshot.nodes[id] : null;
}


export function knowledgeForNode({ snapshot, id } = {}) {
  if (!snapshot || typeof snapshot !== "object") {
    return [];
  }
  if (typeof id !== "string" || id.length === 0) {
    return [];
  }
  const node = targetNode(snapshot, id);
  if (!node || typeof node !== "object") {
    return [];
  }
  return rankKnowledge(matchingKnowledge(node, snapshot.nodes));
}
