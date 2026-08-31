// Pure reasoning for conflicts between active execution contracts.
//
// Contract validation and normalization live in contract.mjs. This module
// owns the path relationship and active-task conflict rules so those concerns
// remain independently reusable and testable.

import { executionContractFor } from "./contract.mjs";

// Path ancestry: A is an ancestor of B iff A's path segments are a strict
// prefix of B's segments. Equality is its own case (handled separately).
// Splits on "/" — works on POSIX-style repo paths; the repo's source tree
// uses POSIX separators exclusively (no .bat / .ps1).
function pathSegments(p) {
  return String(p).split("/").filter((part) => part.length > 0);
}

export function pathRelationship(a, b) {
  if (a === b) return "equal";
  const aSegs = pathSegments(a);
  const bSegs = pathSegments(b);
  if (aSegs.length === 0 || bSegs.length === 0) return null;
  const min = Math.min(aSegs.length, bSegs.length);
  let match = 0;
  for (let i = 0; i < min; i++) {
    if (aSegs[i] !== bSegs[i]) break;
    match++;
  }
  if (match === 0) return null;
  if (match === aSegs.length && aSegs.length < bSegs.length) return "self_is_ancestor_of_other";
  if (match === bSegs.length && bSegs.length < aSegs.length) return "self_is_descendant_of_other";
  return null;
}

// Detect ownership conflicts for `id`'s contract against every other task in
// the state. The current task is excluded; tasks with status done /
// canceled / archived / superseded are excluded (their claim is not active).
// knowledge / gate nodes are excluded (their `owns` is not meaningful).
//
// Returns an array of conflict records:
//   {
//     self_path, other_path, other_node_id, relationship,
//     other_node_title
//   }
// sorted deterministically by (other_node_id, self_path, other_path).
export function detectOwnershipConflicts(state, id) {
  const self = state && state.nodes ? state.nodes[id] : null;
  const selfContract = executionContractFor(state, id);
  if (!self || !selfContract || !Array.isArray(selfContract.owns) || selfContract.owns.length === 0) {
    return [];
  }
  const selfPaths = selfContract.owns;
  const conflicts = [];
  for (const [otherId, other] of Object.entries(state.nodes || {})) {
    if (otherId === id) continue;
    if (!other || other.kind !== "resolvable" || other.subkind !== "task") continue;
    const status = other.status || "open";
    if (["done", "canceled", "archived", "superseded"].includes(status)) continue;
    const otherContract = executionContractFor(state, otherId);
    if (!otherContract || !Array.isArray(otherContract.owns) || otherContract.owns.length === 0) continue;
    for (const selfPath of selfPaths) {
      for (const otherPath of otherContract.owns) {
        const relationship = pathRelationship(selfPath, otherPath);
        if (!relationship) continue;
        conflicts.push({
          self_path: selfPath,
          other_path: otherPath,
          other_node_id: otherId,
          other_node_title: other.title || null,
          relationship,
          other_status: status,
        });
      }
    }
  }
  conflicts.sort((a, b) => {
    if (a.other_node_id !== b.other_node_id) return a.other_node_id.localeCompare(b.other_node_id);
    if (a.self_path !== b.self_path) return a.self_path.localeCompare(b.self_path);
    return a.other_path.localeCompare(b.other_path);
  });
  return conflicts;
}
