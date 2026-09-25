// Pure node revision and snapshot-vs-draft helpers for the mutation pipeline.
//
// This module owns revision assignment and node comparison. It performs no
// I/O, so the kernel can finalize a draft without coupling revision semantics
// to locking or persistence.

// Deep equality on JSON-shaped values; sufficient for kernel diffs because
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

export function stripRevision(node) {
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "revision") continue;
    out[k] = v;
  }
  return out;
}

// Assign a node revision against the persisted state fence. Every recreated
// or modified node advances beyond both its own previous revision and the
// state revision; unchanged nodes retain their revision.
export function assignNodeRevision(stateRevision, previous, draft) {
  const draftNode = stripRevision(draft);
  const stateFloor = Number.isInteger(stateRevision) ? stateRevision : 0;
  if (!previous) {
    return {
      node: { ...draftNode, revision: Math.max(1, stateFloor + 1) },
      change: "created",
    };
  }

  const previousNode = stripRevision(previous);
  if (deepEqualNodes(previousNode, draftNode)) {
    return {
      node: { ...draftNode, revision: Number.isInteger(previous.revision) ? previous.revision : 1 },
      change: "unchanged",
    };
  }

  const previousRevision = Number.isInteger(previous.revision) ? previous.revision : 0;
  return {
    node: { ...draftNode, revision: Math.max(previousRevision + 1, stateFloor + 1) },
    change: "updated",
  };
}

// A committed state revision advances once per effective transaction and must
// never lag behind a node revision carried by that state.
export function deriveNextStateRevision(snapshot, nodes) {
  const currentRevision = snapshot && Number.isInteger(snapshot.revision) ? snapshot.revision : 0;
  const maximumNodeRevision = Object.values(nodes || {}).reduce(
    (maximum, node) => Number.isInteger(node && node.revision) ? Math.max(maximum, node.revision) : maximum,
    0,
  );
  return Math.max(currentRevision + 1, maximumNodeRevision);
}

// Assign node revisions and return the diff shape used by the kernel response
// plus removed nodes (snapshot ids absent from the draft).
export function assignRevisionsAndDiff(snapshot, draftView) {
  const snapNodes = (snapshot && snapshot.nodes) || {};
  const next = {};
  const created = [];
  const updated = [];
  for (const [id, draft] of Object.entries(draftView.nodes || {})) {
    const assigned = assignNodeRevision(snapshot && snapshot.revision, snapNodes[id], draft);
    next[id] = assigned.node;
    if (assigned.change === "created") created.push({ id, node: assigned.node });
    if (assigned.change === "updated") updated.push({ id, node: assigned.node });
  }
  const removed = [];
  for (const id of Object.keys(snapNodes)) {
    if (!Object.prototype.hasOwnProperty.call(draftView.nodes || {}, id)) {
      removed.push(id);
    }
  }
  return { next, removed, created, updated };
}

export function deriveTargetRevision(snapshot, plan, created, updated) {
  const targetId = plan.target.id;
  for (const c of created) if (c.id === targetId) return c.node.revision;
  for (const u of updated) if (u.id === targetId) return u.node.revision;
  const prev = snapshot && snapshot.nodes ? snapshot.nodes[targetId] : null;
  return prev && Number.isInteger(prev.revision) ? prev.revision : null;
}
