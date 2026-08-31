// src/providers/knowledge/ranking.mjs — pure deterministic ranking for
// scoped knowledge matches.
//
// Responsibility:
//   - `specificityRank(scopeMatches)` returns the priority index of the
//     most specific match (lower is more specific; `node_id` = 0,
//     `domain` = 1, `tag` = 2, `initiative` = 3; no match = Infinity).
//   - `rankKnowledge(items)` returns a NEW array sorted by specificity
//     (most specific first) then by id for determinism. Input array is
//     never mutated.
//
// Pure: no fs, no lock, no state, no log, no policy, no commands, no
// registry, no adapter, no CLI, no UI.

import { SCOPE_ORDER } from "./scopes.mjs";

const SCOPE_INDEX = Object.freeze(
  SCOPE_ORDER.reduce((acc, key, idx) => {
    acc[key] = idx;
    return acc;
  }, {}),
);

/**
 * Specificity rank of a knowledge match. Lower means more specific.
 *
 * @param {string[]} scopeMatches - Result of `matchesScopes`.
 * @returns {number} Priority index. `Infinity` when no match.
 */
export function specificityRank(scopeMatches) {
  if (!Array.isArray(scopeMatches) || scopeMatches.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  let best = Number.POSITIVE_INFINITY;
  for (const key of scopeMatches) {
    const idx = SCOPE_INDEX[key];
    if (typeof idx === "number" && idx < best) best = idx;
  }
  return best;
}

function compareItems(a, b) {
  const ra = specificityRank(a && a.scope_matches);
  const rb = specificityRank(b && b.scope_matches);
  if (ra !== rb) return ra - rb;
  const ai = a && typeof a.id === "string" ? a.id : "";
  const bi = b && typeof b.id === "string" ? b.id : "";
  if (ai < bi) return -1;
  if (ai > bi) return 1;
  return 0;
}

/**
 * Sort knowledge items by specificity, then by id for determinism.
 *
 * @template {{ id: string, scope_matches: string[] }} T
 * @param {T[]} items
 * @returns {T[]} New sorted array; input is not mutated.
 */
export function rankKnowledge(items) {
  if (!Array.isArray(items)) return [];
  return items.slice().sort(compareItems);
}
