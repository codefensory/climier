// Pure snapshot-vs-draft diff helpers for the kernel mutation pipeline.
//
// This module owns node revision assignment and comparison of nodes, edges,
// and initiatives. It performs no I/O and does not depend on the transaction
// or storage layers, so the mutation façade can keep the pipeline mechanics
// separate from its state-delta calculation.

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

function stripRevision(node) {
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "revision") continue;
    out[k] = v;
  }
  return out;
}

// Deep-equality on JSON-shaped values; sufficient for kernel diffs because
// v2 node and plugin values are JSON-serializable by construction. Keeps the
// result deterministic — same input → same comparison → same id list.
export function deepEqualNodes(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    const av = a[k];
    const bv = b[k];
    if (av === bv) continue;
    if (typeof av !== typeof bv) return false;
    if (av && bv && typeof av === "object") {
      try {
        if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
      } catch {
        return false;
      }
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}

// Assign the next revision per node: new → 1; modified → prev + 1;
// unchanged → keep prev (but apply the draft to drop the revision field,
// since draft nodes never carry it). Returns the diff shape used by the
// kernel response plus removed nodes (snapshot ids absent from the draft).
export function assignRevisionsAndDiff(snapshot, draftView) {
  const snapNodes = (snapshot && snapshot.nodes) || {};
  const next = {};
  const created = [];
  const updated = [];
  for (const [id, draft] of Object.entries(draftView.nodes || {})) {
    const prev = snapNodes[id];
    const draftStrip = stripRevision(draft);
    if (!prev) {
      next[id] = { ...draftStrip, revision: 1 };
      created.push({ id, node: next[id] });
      continue;
    }
    const prevStrip = stripRevision(prev);
    if (deepEqualNodes(prevStrip, draftStrip)) {
      next[id] = { ...draftStrip, revision: Number.isInteger(prev.revision) ? prev.revision : 1 };
    } else {
      next[id] = { ...draftStrip, revision: (Number.isInteger(prev.revision) ? prev.revision : 0) + 1 };
      updated.push({ id, node: next[id] });
    }
  }
  const removed = [];
  for (const id of Object.keys(snapNodes)) {
    if (!Object.prototype.hasOwnProperty.call(draftView.nodes || {}, id)) {
      removed.push(id);
    }
  }
  return { next, removed, created, updated };
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

export { asEdge, edgeKey, snapshotEdgeMap, draftEdgeMap, stripRevision, initiativesEqual };
