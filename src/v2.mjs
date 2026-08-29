import { emptyState } from "./state.mjs";
import { throwV2 } from "./errors.mjs";
import { incoming, relations } from "./kernel/graph.mjs";

// Re-exported so callers that already import from v2.mjs keep working.
// ponytail: thin re-export, remove when v2 callers all switch to errors.mjs.
export { throwV2 };

// Kernel primitives (B2). The canonical implementation lives in
// src/kernel/edges.mjs and src/kernel/graph.mjs; v2.mjs is a thin facade.
// `EDGE_TYPE_CONSTANTS` is the historical alias that still includes the
// deprecated informational/conflict types so existing data with those
// types can be read; mutating commands reject them via EDGE_TYPES below.
export { EDGE_TYPES, existingEdge, blocksEdge, validateEdge } from "./kernel/edges.mjs";

export const EDGE_TYPE_CONSTANTS = [
  "BLOCKS",
  "INFORMS",
  "SUPERSEDES",
  "DERIVED_FROM",
  "RELATES_TO",
  "CONFLICTS_WITH",
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function supersededBy(state, id) {
  const next = incoming(state, id, "SUPERSEDES")
    .map((edge) => edge.from)
    .sort();
  return next[0] || null;
}

export function isCurrent(state, id) {
  return supersededBy(state, id) === null;
}

export function statusOfV2(state, id) {
  const s = state || emptyState();
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
  const s = state || emptyState();
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
    const deps = incoming(s, id, "BLOCKS");
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
  return incoming(state, id, "BLOCKS").map((edge) => ({
    edge_type: edge.type,
    node: inlineNode(state, edge.from),
    satisfied: isSatisfiedV2(state, edge.from),
  }));
}

export function informingForNode(state, id) {
  return relations(state, id, "INFORMS").map((edge) => ({
    edge_type: edge.type,
    node: inlineNode(state, edge.to),
  }));
}
