// src/providers/knowledge/scopes.mjs — pure scope-matching helper for the
// knowledge provider.
//
// Responsibility:
//   - `matchesScopes(node, knowledge)` returns the scope keys that match
//     `node` against `knowledge.scope`, ordered by priority.
//   - `SCOPE_ORDER` exposes the canonical priority (node_id > domain > tag
//     > initiative). This is the canonical provider order per ADR-012 §3.
//
// Constraints:
//   - Pure function over JSON-shaped values: no fs, no lock, no state, no
//     log, no policy, no commands, no registry, no adapter, no CLI, no UI.
//   - Tolerates missing/typed-wrong scope fields (defensive: callers
//     receive [] or the partial match instead of an exception).
//   - Order-independent of the keys present in `scope`: matches are always
//     reported in `SCOPE_ORDER`, never in the caller's insertion order.

export const SCOPE_ORDER = Object.freeze(["node_id", "domain", "tag", "initiative"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Returns the scope keys from `knowledge.scope` that match `node`,
 * ordered by `SCOPE_ORDER`. Returns `[]` when nothing matches.
 *
 * Match rules (codified here so the provider does not depend on command
 * adapters):
 *   - `node_id` matches when `scope.node_ids` contains `node.id`.
 *   - `domain` matches when `node.domain` is non-empty AND
 *     `scope.domains` contains it.
 *   - `initiative` matches when `node.initiative` is non-empty AND
 *     `scope.initiatives` contains it.
 *   - `tag` matches when any of `node.tags` is contained in
 *     `scope.tags`.
 *
 * @param {object} node - Target node (task/gate/knowledge) being matched.
 * @param {object} knowledge - Knowledge node carrying `scope`.
 * @returns {string[]} Subset of SCOPE_ORDER in priority order.
 */
export function matchesScopes(node, knowledge) {
  if (!node || typeof node !== "object") return [];
  const scope = knowledge && typeof knowledge === "object" && knowledge.scope && typeof knowledge.scope === "object"
    ? knowledge.scope
    : {};
  const matched = [];
  if (typeof node.id === "string" && node.id.length > 0 && asArray(scope.node_ids).includes(node.id)) {
    matched.push("node_id");
  }
  if (typeof node.domain === "string" && node.domain.length > 0 && asArray(scope.domains).includes(node.domain)) {
    matched.push("domain");
  }
  if (typeof node.initiative === "string" && node.initiative.length > 0 && asArray(scope.initiatives).includes(node.initiative)) {
    matched.push("initiative");
  }
  const nodeTags = asArray(node.tags);
  if (nodeTags.length > 0) {
    const scopeTags = asArray(scope.tags);
    if (scopeTags.length > 0 && nodeTags.some((tag) => scopeTags.includes(tag))) {
      matched.push("tag");
    }
  }
  // Re-order by priority: SCOPE_ORDER is authoritative.
  return SCOPE_ORDER.filter((k) => matched.includes(k));
}
