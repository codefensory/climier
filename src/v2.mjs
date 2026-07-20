import { emptyState } from "./state.mjs";
import { throwV2 } from "./errors.mjs";

// Re-exported so callers that already import from v2.mjs keep working.
// ponytail: thin re-export, remove when v2 callers all switch to errors.mjs.
export { throwV2 };

// Full list of edge-type names that exist as constants in the schema. Kept
// here so existing data with deprecated types (INFORMS, RELATES_TO,
// CONFLICTS_WITH) can still be read; mutating commands reject them via
// the narrower EDGE_TYPES whitelist below.
export const EDGE_TYPE_CONSTANTS = [
  "BLOCKS",
  "INFORMS",
  "SUPERSEDES",
  "DERIVED_FROM",
  "RELATES_TO",
  "CONFLICTS_WITH",
];

// Edge types the mutating commands (add-node, add-edge) accept today.
// Deprecated types are rejected with INVALID_EDGE_TYPE; cleanup of the
// constants list happens in a later phase.
export const EDGE_TYPES = ["BLOCKS", "SUPERSEDES", "DERIVED_FROM"];

export function existingEdge(state, from, to, type) {
  return asArray(state.edges).some(
    (edge) => edge.from === from && edge.to === to && edge.type === type,
  );
}

// Canonical BLOCKS edge: from BLOCKS to means to is BLOCKED-BY from.
// Used by CLI surfaces that phrase the relationship from the dependent's
// point of view (e.g. `--blocked-by G-y` means "this node is blocked by G-y").
export function blocksEdge(blockerId, blockedId) {
  return { from: blockerId, to: blockedId, type: "BLOCKS" };
}

export function validateEdge(state, edge, commandName) {
  const { from, to, type } = edge;
  if (from === to) {
    throwV2(
      "SELF_EDGE",
      `${commandName}: edge ${from} -> ${to} is a self-edge`,
      { from, to, type },
    );
  }
  const nodes = state && state.nodes ? state.nodes : {};
  const fromNode = nodes[from];
  const toNode = nodes[to];
  if (!fromNode || !toNode) {
    const missing = !fromNode ? from : to;
    throwV2(
      "INVALID_EDGE_TARGET",
      `${commandName}: edge ${type} ${from} -> ${to} references missing node '${missing}'`,
      { from, to, type, missing },
    );
  }
  if (!EDGE_TYPES.includes(type)) {
    throwV2(
      "INVALID_EDGE_TYPE",
      `${commandName}: edge type ${type} is not allowed (allowed: ${EDGE_TYPES.join(", ")})`,
      { type, allowed: EDGE_TYPES },
    );
  }
  if (type === "BLOCKS") {
    if (fromNode.kind !== "resolvable" || toNode.kind !== "resolvable") {
      throwV2(
        "INVALID_EDGE_KIND",
        `${commandName}: BLOCKS requires both ends to be resolvable (got ${fromNode.kind} -> ${toNode.kind})`,
        { from, to, type, fromKind: fromNode.kind, toKind: toNode.kind },
      );
    }
  } else if (type === "SUPERSEDES") {
    if (fromNode.kind !== toNode.kind) {
      throwV2(
        "INVALID_EDGE_KIND",
        `${commandName}: SUPERSEDES requires both ends to be the same kind (got ${fromNode.kind} -> ${toNode.kind})`,
        { from, to, type, fromKind: fromNode.kind, toKind: toNode.kind },
      );
    }
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function blockers(state, id) {
  return asArray(state.edges).filter((edge) => edge.to === id && edge.type === "BLOCKS");
}

function rels(state, id, type) {
  return asArray(state.edges).filter((edge) => edge.from === id && edge.type === type);
}

export function supersededBy(state, id) {
  const next = asArray(state.edges)
    .filter((edge) => edge.type === "SUPERSEDES" && edge.to === id)
    .map((edge) => edge.from)
    .sort();
  return next[0] || null;
}

export function isCurrent(state, id) {
  return supersededBy(state, id) === null;
}

export function statusOfV2(state, id) {
  const s = state || emptyState(2);
  const node = s.nodes[id];
  if (!node) return "unknown";
  if (node.kind === "knowledge") return node.status || "active";
  const status = node.status || "open";
  if (["in_progress", "done", "archived", "canceled", "resolved", "superseded"].includes(status)) {
    return status;
  }
  if (node.backlog === true) return "backlog";
  const d = deriveV2(s);
  if (d.ready.includes(id)) return "ready";
  if (d.blocked.includes(id)) return "blocked";
  return status;
}

export function isSatisfiedV2(state, id) {
  const node = state.nodes[id];
  if (!node) return false;
  if (node.kind === "knowledge") return false;
  const status = node.status || "open";
  if (node.subkind === "task") {
    return status === "done" || status === "archived";
  }
  if (node.subkind === "gate") {
    if (status === "resolved") return true;
    if (status === "superseded") {
      const nextId = supersededBy(state, id);
      return nextId ? isSatisfiedV2(state, nextId) : false;
    }
  }
  return false;
}

export function deriveV2(state) {
  const s = state || emptyState(2);
  const ready = [];
  const blocked = [];
  const backlog = [];
  const openGates = [];

  for (const [id, node] of Object.entries(s.nodes || {})) {
    if (node.kind !== "resolvable") continue;
    const status = node.status || "open";
    if (node.subkind === "gate") {
      if (status === "open") openGates.push(id);
      continue;
    }
    if (["in_progress", "done", "archived", "canceled"].includes(status)) continue;
    if (node.backlog === true) {
      backlog.push(id);
      continue;
    }
    const deps = blockers(s, id);
    const ok = deps.every((edge) => isSatisfiedV2(s, edge.from));
    if (ok) ready.push(id);
    else blocked.push(id);
  }

  return { ready, blocked, backlog, openGates };
}

// F10: a knowledge can match via several scopes simultaneously (e.g. node_id AND
// domain). Return the matching scopes in priority order so callers can rank and
// order them. Priority: node_id > domain > tag > initiative.
const SCOPE_ORDER = ["node_id", "domain", "tag", "initiative"];

function matchesScopes(node, knowledge) {
  const scope = knowledge.scope || {};
  const matched = [];
  if (asArray(scope.node_ids).includes(node.id)) matched.push("node_id");
  if (node.domain && asArray(scope.domains).includes(node.domain)) matched.push("domain");
  if (node.initiative && asArray(scope.initiatives).includes(node.initiative)) matched.push("initiative");
  const tags = asArray(node.tags);
  if (tags.some((tag) => asArray(scope.tags).includes(tag))) matched.push("tag");
  // De-dupe and reorder by priority.
  return SCOPE_ORDER.filter((k) => matched.includes(k));
}

// Specificity rank: lower is more specific. node_id=0, domain=1, tag=2, initiative=3.
function specificityRank(scopeMatches) {
  for (let i = 0; i < SCOPE_ORDER.length; i++) {
    if (scopeMatches.includes(SCOPE_ORDER[i])) return i;
  }
  return Infinity;
}

export function knowledgeForNode(state, id) {
  const node = state.nodes[id];
  if (!node) return [];
  return Object.values(state.nodes)
    // F10: include deprecated knowledge in the array too so the caller can
    // surface a KNOWLEDGE_DEPRECATED_SOON alert.
    .filter((candidate) => candidate.kind === "knowledge")
    .map((candidate) => {
      const scopeMatches = matchesScopes(node, candidate);
      if (scopeMatches.length === 0) return null;
      return { ...candidate, scope_matches: scopeMatches };
    })
    .filter(Boolean)
    // F10: most-specific first; tie-break by id for determinism.
    .sort((a, b) => {
      const ra = specificityRank(a.scope_matches);
      const rb = specificityRank(b.scope_matches);
      if (ra !== rb) return ra - rb;
      return a.id.localeCompare(b.id);
    });
}

function inlineNode(state, id) {
  const node = state.nodes[id];
  if (!node) {
    return {
      id,
      status: "missing",
      is_current: true,
      superseded_by: null,
    };
  }
  return {
    ...node,
    is_current: isCurrent(state, id),
    superseded_by: supersededBy(state, id),
  };
}

export function blockingForNode(state, id) {
  return blockers(state, id).map((edge) => ({
    edge_type: edge.type,
    node: inlineNode(state, edge.from),
    satisfied: isSatisfiedV2(state, edge.from),
  }));
}

export function informingForNode(state, id) {
  return rels(state, id, "INFORMS").map((edge) => ({
    edge_type: edge.type,
    node: inlineNode(state, edge.to),
  }));
}
