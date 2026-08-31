// src/providers/knowledge/search.mjs — pure knowledge search helper for
// the knowledge provider.
//
// Implements case-insensitive substring matching across
// id/title/body/mitigation/domain/tags/refs/meta; active by default;
// deprecated only with `all: true`; deterministic id order; body snippets
// are truncated to 200 chars. It operates on a snapshot rather than
// reading state from the filesystem.
//
// Pure: no fs, no lock, no state, no log, no policy, no commands, no
// registry, no adapter, no CLI, no UI. This is the canonical provider
// implementation per ADR-012 §3.

const SNIPPET_LIMIT = 200;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeQuery(query) {
  return typeof query === "string" ? query.trim().toLowerCase() : "";
}

function searchableFields(node) {
  return [
    ["id", node.id],
    ["title", node.title],
    ["body", node.body],
    ["mitigation", node.mitigation],
    ["domain", node.domain],
    ["tags", asArray(node.tags)],
    ["refs", asArray(node.refs).map((ref) => ref && ref.target)],
    ["meta", node.meta],
  ];
}

function includes(value, query) {
  if (value == null) return false;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text ? text.toLowerCase().includes(query) : false;
}

function collectMatches(snapshot, query) {
  const nodes = snapshot && snapshot.nodes && typeof snapshot.nodes === "object" ? snapshot.nodes : {};
  const out = [];
  for (const node of Object.values(nodes)) {
    if (!node || node.kind !== "knowledge") continue;
    const matchedFields = searchableFields(node)
      .filter(([, value]) => includes(value, query))
      .map(([field]) => field);
    if (matchedFields.length === 0) continue;
    out.push({ node, matchedFields });
  }
  return out;
}

function projectMatch({ node, matchedFields }) {
  return {
    id: node.id,
    kind: "knowledge",
    title: node.title,
    initiative: node.initiative,
    domain: node.domain,
    status: node.status || "active",
    matched_fields: matchedFields,
    snippet: String(node.body || "").slice(0, SNIPPET_LIMIT),
  };
}

/**
 * Search the snapshot for knowledge nodes matching `query`.
 *
 * @param {object} args
 * @param {object} args.snapshot - v2 state snapshot ({nodes, edges, ...}).
 * @param {string} args.query - Substring (case-insensitive). Empty/whitespace → no matches.
 * @param {boolean} [args.all=false] - When true, include deprecated knowledge.
 * @returns {{ matches: object[], count: number }} Matches in deterministic id order.
 */
export function searchKnowledge({ snapshot, query, all = false } = {}) {
  const q = normalizeQuery(query);
  if (!q) return { matches: [], count: 0 };

  const collected = collectMatches(snapshot, q);
  const includeDeprecated = all === true;
  const projected = [];
  for (const item of collected) {
    const status = (item.node && item.node.status) || "active";
    if (!includeDeprecated && status !== "active") continue;
    projected.push(projectMatch(item));
  }
  projected.sort((a, b) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return { matches: projected, count: projected.length };
}
