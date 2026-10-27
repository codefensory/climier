// Pure snapshot-vs-draft diff helpers for the kernel mutation pipeline.
// This module owns comparison of edges and initiatives. Node comparison and
// revision assignment live in revisions.mjs. No helper performs I/O or
// depends on storage, locks, or adapters.

import { assignNodeRevision, assignRevisionsAndDiff as assignAllRevisionsAndDiff, deepEqualNodes, stripRevision } from "./revisions.ts";

function asEdge(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) {return null;}
  if (typeof e.from !== "string" || typeof e.to !== "string" || typeof e.type !== "string") {return null;}
  return { from: e.from, to: e.to, type: e.type };
}

function edgeKey(e) {
  return `${e.from}|${e.to}|${e.type}`;
}

function snapshotEdgeMap(edges) {
  const map = new Map();
  for (const e of edges || []) {
    const normalized = asEdge(e);
    if (!normalized) {continue;}
    map.set(edgeKey(normalized), normalized);
  }
  return map;
}

function draftEdgeMap(edges) {
  return snapshotEdgeMap(edges);
}

type DirtyEdgeChange = {
  key: string;
  edge: { from: string; to: string; type: string };
  before: boolean;
  after: boolean;
  originalOrder: number;
  finalOrder: number | null;
};

export function computeEdgeDiff(snapshotEdges, draftEdges, dirtyChanges?: DirtyEdgeChange[], onCompare?: (key: string) => void) {
  if (dirtyChanges !== undefined) {
    const added: DirtyEdgeChange[] = [];
    const removed: DirtyEdgeChange[] = [];
    const changes = [...dirtyChanges];
    for (const change of changes) {
      onCompare?.(change.key);
      if (change.before === change.after) {continue;}
      if (change.after) {added.push(change);}
      else {removed.push(change);}
    }
    added.sort((a, b) => (a.finalOrder ?? 0) - (b.finalOrder ?? 0));
    removed.sort((a, b) => a.originalOrder - b.originalOrder);
    return {
      added: added.map(({ edge }) => ({ from: edge.from, to: edge.to, type: edge.type })),
      removed: removed.map(({ edge }) => ({ from: edge.from, to: edge.to, type: edge.type })),
    };
  }

  const snapMap = snapshotEdgeMap(snapshotEdges);
  const draftMap = draftEdgeMap(draftEdges);
  const added: unknown[] = [];
  const removed: unknown[] = [];
  for (const [k, e] of draftMap) {
    if (!snapMap.has(k)) {added.push(e);}
  }
  for (const [k, e] of snapMap) {
    if (!draftMap.has(k)) {removed.push(e);}
  }
  return { added, removed };
}


// We only persist primitives (desc: string, created_at?: string), so a
// shallow key-by-key comparison is sufficient for the initiative shape.
function sameObjectKeys(a, b) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {return false;}
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key));
}

function objectCopy(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function initiativesEqual(a, b) {
  if (a === b) {return true;}
  if (!a || !b || typeof a !== "object" || typeof b !== "object") {return false;}
  return sameObjectKeys(a, b) && Object.keys(a).every((key) => a[key] === b[key]);
}

// Snapshot-vs-draft delta on the initiatives map. Registration is monotonic:
// the kernel has no provider seam for deleting an existing initiative.
export function computeInitiativeDiff(snapshotInitiatives, draftInitiatives, dirtyNames?: string[], onCompare?: (name: string) => void) {
  const snap = snapshotInitiatives && typeof snapshotInitiatives === "object" ? snapshotInitiatives : {};
  const draft = draftInitiatives && typeof draftInitiatives === "object" ? draftInitiatives : {};
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const names = dirtyNames === undefined ? Object.keys(draft) : dirtyNames;
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(draft, name)) {continue;}
    const draftInit = draft[name];
    const prev = snap[name];
    onCompare?.(name);
    if (!prev) {
      created.push({ name, initiative: objectCopy(draftInit) });
      continue;
    }
    if (!initiativesEqual(prev, draftInit)) {
      updated.push({ name, initiative: objectCopy(draftInit), previous: objectCopy(prev) });
    }
  }
  return { created, updated };
}

function assignDirtyRevisionsAndDiff(snapshot, draftView, dirtyIds: Iterable<string>, onCompare?: (id: string) => void) {
  const snapNodes = (snapshot && snapshot.nodes) || {};
  const draftNodes = draftView.nodes || {};
  const next = { ...snapNodes };
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const dirty = new Set(dirtyIds);
  const removed: string[] = [];

  for (const id of dirty) {
    const previous = snapNodes[id];
    if (Object.prototype.hasOwnProperty.call(draftNodes, id)) {
      onCompare?.(id);
      const assigned = assignNodeRevision(snapshot && snapshot.revision, previous, draftNodes[id]);
      next[id] = assigned.node;
      if (assigned.change === "created") {created.push({ id, node: assigned.node });}
      if (assigned.change === "updated") {updated.push({ id, node: assigned.node });}
    } else if (Object.prototype.hasOwnProperty.call(snapNodes, id)) {
      onCompare?.(id);
      delete next[id];
      removed.push(id);
    }
  }
  return { next, created, updated, removed };
}

export function assignRevisionsAndDiff(snapshot, draftView, dirtyIds?: Iterable<string>, onCompare?: (id: string) => void) {
  return dirtyIds === undefined
    ? assignAllRevisionsAndDiff(snapshot, draftView)
    : assignDirtyRevisionsAndDiff(snapshot, draftView, dirtyIds, onCompare);
}

// Compatibility exports: callers of the original diff boundary continue to
// receive the same pure helpers while revisions have their own module.
export {
  asEdge,
  edgeKey,
  snapshotEdgeMap,
  draftEdgeMap,
  initiativesEqual,
  deepEqualNodes,
  stripRevision,
};
