// src/providers/knowledge/projection.ts — pure knowledge projection for a
// target node.
// Knowledge is selected by any matching scope. A match carries every scope
// that matched so consumers can explain why it was selected. Results are

// superseded knowledge remains visible here; lifecycle policy belongs to the

// Pure: no fs, no lock, no state, no log, no policy, no commands, no
// registry, no adapter, no CLI, no UI.

import { matchesScopes } from "./scopes.ts";
import { rankKnowledge } from "./ranking.ts";

type ProjectionNode = Record<string, unknown>;
type ProjectionSnapshot = { nodes?: Record<string, ProjectionNode> };

function projectCandidate(node: ProjectionNode, candidate: ProjectionNode) {
  if (!candidate || typeof candidate !== "object" || candidate.kind !== "knowledge") {
    return null;
  }
  const scopeMatches = matchesScopes(node, candidate);
  if (scopeMatches.length === 0) {
    return null;
  }
  return { ...candidate, scope_matches: scopeMatches };
}

function matchingKnowledge(node: ProjectionNode, nodes: Record<string, ProjectionNode>) {
  const matches: ProjectionNode[] = [];
  for (const candidate of Object.values(nodes)) {
    const projected = projectCandidate(node, candidate);
    if (projected) {
      matches.push(projected);
    }
  }
  return matches;
}

function validNodes(nodes: unknown): nodes is Record<string, ProjectionNode> {
  return nodes !== null && typeof nodes === "object" && !Array.isArray(nodes);
}

function targetNode(snapshot: ProjectionSnapshot, id: string) {
  return validNodes(snapshot.nodes) ? snapshot.nodes[id] : null;
}


export function knowledgeForNode(
  { snapshot, id }: { snapshot?: ProjectionSnapshot; id?: string } = {},
) {
  if (!snapshot || typeof snapshot !== "object") {
    return [];
  }
  if (typeof id !== "string" || id.length === 0) {
    return [];
  }
  const nodes = snapshot.nodes;
  if (!validNodes(nodes)) {
    return [];
  }
  const node = targetNode(snapshot, id);
  if (!node || typeof node !== "object") {
    return [];
  }
  return rankKnowledge(matchingKnowledge(node, nodes));
}
