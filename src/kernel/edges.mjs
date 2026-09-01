// src/kernel/edges.mjs — pure structural primitives for graph edges.
//
// ADR-011 §§2–3 + ADR-012 §3: the kernel owns the generic edge constants,
// the canonical BLOCKS constructor and the structural validator.
// mutating commands and providers all consume these
// primitives; nothing else may redefine them.
//
// Contract:
//   - EDGE_TYPES is the canonical whitelist of edge types accepted by
//     mutating paths: BLOCKS, SUPERSEDES, DERIVED_FROM. Deprecated
//     informational/conflict types (INFORMS, RELATES_TO, CONFLICTS_WITH)
//     are rejected by validateEdge.
//   - existingEdge is a pure predicate over a state's edges array.
//   - blocksEdge(blocker, blocked) builds the canonical BLOCKS edge
//     (blocker BLOCKS blocked — direction is fixed).
//   - validateEdge(state, edge, commandName) is the generic structural
//     validator: SELF_EDGE / INVALID_EDGE_TARGET / INVALID_EDGE_KIND /
//     INVALID_EDGE_TYPE. The error codes match the public v2 contract so
//     existing consumers (add-node, add-edge, providers, UI) keep working.
//   - No filesystem, no locks, no providers, no command-specific state.

import {
  EDGE_TYPES,
  validateEdge,
  wouldCreateBlocksCycle,
  blocksCyclePath,
} from "../contracts/state-invariants.mjs";

export { EDGE_TYPES, validateEdge, wouldCreateBlocksCycle, blocksCyclePath };

// Read-only relation names retained for compatibility with the v2 facade.
// They are not accepted by validateEdge.
export const EDGE_TYPE_CONSTANTS = Object.freeze([
  "BLOCKS",
  "INFORMS",
  "SUPERSEDES",
  "DERIVED_FROM",
  "RELATES_TO",
  "CONFLICTS_WITH",
]);

function asEdges(state) {
  return Array.isArray(state && state.edges) ? state.edges : [];
}

function asNodes(state) {
  return state && typeof state.nodes === "object" && state.nodes !== null ? state.nodes : {};
}

/**
 * Pure predicate: does the state's edges array already contain an edge with
 * the exact (from, to, type) triple?
 *
 * @param {object} state - v2 state with an `edges` array.
 * @param {string} from
 * @param {string} to
 * @param {string} type
 * @returns {boolean}
 */
export function existingEdge(state, from, to, type) {
  return asEdges(state).some(
    (edge) => edge.from === from && edge.to === to && edge.type === type,
  );
}

/**
 * Build the canonical BLOCKS edge between a blocker and a blocked node.
 *
 * Direction is fixed: the first argument is the blocker (the dependency),
 * the second is the blocked (the dependent). The shape matches the on-disk
 * representation consumed by validateEdge and kernel transactions
 * transactions.
 *
 * @param {string} blockerId
 * @param {string} blockedId
 * @returns {{ from: string, to: string, type: "BLOCKS" }}
 */
export function blocksEdge(blockerId, blockedId) {
  return { from: blockerId, to: blockedId, type: "BLOCKS" };
}

/**
 * Generic structural validator for an edge in the v2 state shape.
 *
 * Codes (preserved from the v2 public contract):
 *   - SELF_EDGE          : from === to
 *   - INVALID_EDGE_TARGET: missing from or to node
 *   - INVALID_EDGE_KIND  : BLOCKS requires resolvable ends; SUPERSEDES
 *                          requires matching kinds; details include both
 *                          endpoint kinds so callers can render context.
 *   - INVALID_EDGE_TYPE  : type is not in EDGE_TYPES; details include the
 *                          allowed list.
 *
 * Pure function: no filesystem, no locks, no command-specific state. The
 * `commandName` argument only feeds error messages so the resulting
 * structured error is grep-able from logs (matches the v2 convention of
 * starting every error with the command name).
 *
 * @param {object} state - v2 state with a `nodes` map.
 * @param {{ from: string, to: string, type: string }} edge
 * @param {string} commandName - used as the error message prefix.
 */
