// src/kernel/graph.mjs — pure generic traversals over the v2 graph.
//
// ADR-011 §§2–3 + ADR-012 §3: the kernel owns the generic traversals
// (incoming / outgoing / relations). status/context, providers and
// the UI server all consume these helpers; nothing else
// may redefine them.
//
// Contract:
//   - All functions are pure: no filesystem, no locks, no providers, no
//     command-specific state. They take a v2 state shape and return arrays
//     of edge references (no cloning) so traversal is O(n) and idempotent.
//   - Insertion order is preserved by Array.prototype.filter; traversals
//     are deterministic given a fixed snapshot.
//   - Missing/typed-wrong `edges` is tolerated and yields [].

function asEdges(state) {
  return Array.isArray(state && state.edges) ? state.edges : [];
}

/**
 * Defensive accessor for the state's edges array.
 *
 * Returns the array verbatim when present, [] when missing or non-array.
 * Public so callers can iterate without re-checking the field.
 *
 * @param {object} state
 * @returns {object[]}
 */
export function edgesArray(state) {
  return asEdges(state);
}

/**
 * Edges that point at `id` (i.e. `edge.to === id`).
 *
 * When `type` is provided, the result is filtered to that single edge type.
 * Without `type`, all edges targeting `id` are returned in snapshot order.
 *
 * @param {object} state
 * @param {string} id
 * @param {string} [type] - optional edge type filter.
 * @returns {object[]}
 */
export function incoming(state, id, type) {
  const edges = asEdges(state);
  if (type === undefined) {
    return edges.filter((edge) => edge.to === id);
  }
  return edges.filter((edge) => edge.to === id && edge.type === type);
}

/**
 * Edges that originate from `id` (i.e. `edge.from === id`).
 *
 * When `type` is provided, the result is filtered to that single edge type.
 * Without `type`, all edges originating from `id` are returned in snapshot
 * order.
 *
 * @param {object} state
 * @param {string} id
 * @param {string} [type] - optional edge type filter.
 * @returns {object[]}
 */
export function outgoing(state, id, type) {
  const edges = asEdges(state);
  if (type === undefined) {
    return edges.filter((edge) => edge.from === id);
  }
  return edges.filter((edge) => edge.from === id && edge.type === type);
}

/**
 * Typed outgoing view: returns edges from `id` of a specific type.
 *
 * Equivalent to `outgoing(state, id, type)`; the alias exists so callers
 * that think in relational terms ("what does A RELATE to via X?") can
 * express intent without reading the traversal direction off `outgoing`.
 *
 * The `type` argument is required by contract: a relation without a type
 * is not a meaningful query, and passing `undefined` returns [] to make
 * that explicit at call sites.
 *
 * @param {object} state
 * @param {string} id
 * @param {string} type
 * @returns {object[]}
 */
export function relations(state, id, type) {
  if (type === undefined) return [];
  return outgoing(state, id, type);
}