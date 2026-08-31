// Pure snapshot-vs-draft diff helpers for the kernel mutation pipeline.
//
// This module owns comparison of edges and initiatives. Node comparison and
// revision assignment live in revisions.mjs. No helper performs I/O or
// depends on storage, locks, or adapters.

import { assignRevisionsAndDiff, deepEqualNodes, stripRevision } from "./revisions.mjs";

function asEdge(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  if (typeof e.from !== "string" || typeof e.to !== "string" || typeof e.type !== "string") return null;
  return { from: e.from, to: e.to, type: e.type };
}

function edgeKey(e) {
  return `${e.from}|${e.to}|${e.type}`;
}

function snapshotEdgeMap(edges) {
  const map = new Map();
  for (const e of edges || []) {
    const normalized = asEdge(e);
    if (!normalized) continue;
    map.set(edgeKey(normalized), normalized);
  }
  return map;
}

function draftEdgeMap(edges) {
  return snapshotEdgeMap(edges);
}

export function computeEdgeDiff(snapshotEdges, draftEdges) {
  const snapMap = snapshotEdgeMap(snapshotEdges);
  const draftMap = draftEdgeMap(draftEdges);
  const added = [];
  const removed = [];
  for (const [k, e] of draftMap) {
    if (!snapMap.has(k)) added.push(e);
  }
  for (const [k, e] of snapMap) {
    if (!draftMap.has(k)) removed.push(e);
  }
  return { added, removed };
}

// Compare two v2 initiative entries by their JSON-serializable fields.
// We only persist primitives (desc: string, created_at?: string), so a
// shallow key-by-key comparison is sufficient and preserves the historical
// behavior if a future plugin extends the shape with non-JSON values.
function initiativesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

// Snapshot-vs-draft delta on the initiatives map. Registration is monotonic:
// the kernel has no provider seam for deleting an existing initiative.
export function computeInitiativeDiff(snapshotInitiatives, draftInitiatives) {
  const snap = snapshotInitiatives && typeof snapshotInitiatives === "object" ? snapshotInitiatives : {};
  const draft = draftInitiatives && typeof draftInitiatives === "object" ? draftInitiatives : {};
  const created = [];
  const updated = [];
  for (const [name, draftInit] of Object.entries(draft)) {
    const prev = snap[name];
    if (!prev) {
      created.push({ name, initiative: { ...draftInit } });
      continue;
    }
    if (!initiativesEqual(prev, draftInit)) {
      updated.push({ name, initiative: { ...draftInit }, previous: { ...prev } });
    }
  }
  return { created, updated };
}

// Compatibility exports: callers of the original diff boundary continue to
// receive the same pure helpers while revisions have their own module.
export {
  asEdge,
  edgeKey,
  snapshotEdgeMap,
  draftEdgeMap,
  initiativesEqual,
  assignRevisionsAndDiff,
  deepEqualNodes,
  stripRevision,
};
