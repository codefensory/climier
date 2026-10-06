// Pure node revision and snapshot-vs-draft helpers for the mutation pipeline.
// This module owns revision assignment and node comparison. It performs no
// I/O, so the kernel can finalize a draft without coupling revision semantics
// to locking or persistence.

function deepEqualValue(a, b) {
  if (a === b) {return true;}
  if (typeof a !== typeof b) {return false;}
  if (!a || !b || typeof a !== "object") {return a === b;}
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function sameKeys(a, b) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length
    && aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key));
}


export function deepEqualNodes(a, b) {
  if (a === b) {return true;}
  if (!a || !b || typeof a !== "object" || typeof b !== "object") {return false;}
  return sameKeys(a, b) && Object.keys(a).every((key) => deepEqualValue(a[key], b[key]));
}

type RevisableNode = { revision?: number };

function maxNodeRevision(nodes) {
  let maximum = 0;
  for (const node of Object.values(nodes || {}) as RevisableNode[]) {
    if (typeof node.revision === "number" && Number.isInteger(node.revision)) {maximum = Math.max(maximum, node.revision);}
  }
  return maximum;
}

export function stripRevision(node) {
  if (!node || typeof node !== "object") {return node;}
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "revision") {continue;}
    out[k] = v;
  }
  return out;
}

// Assign a node revision against the persisted state fence. Every recreated

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
  const maximumNodeRevision = maxNodeRevision(nodes);
  return Math.max(currentRevision + 1, maximumNodeRevision);
}

// Assign node revisions and return the diff shape used by the kernel response
// plus removed nodes (snapshot ids absent from the draft).
function assignDraftNodes(snapshot, draftNodes, snapNodes) {
  const next: Record<string, unknown> = {};
  const created: unknown[] = [];
  const updated: unknown[] = [];
  for (const [id, draft] of Object.entries(draftNodes)) {
    const assigned = assignNodeRevision(snapshot && snapshot.revision, snapNodes[id], draft);
    next[id] = assigned.node;
    if (assigned.change === "created") {created.push({ id, node: assigned.node });}
    if (assigned.change === "updated") {updated.push({ id, node: assigned.node });}
  }
  return { next, created, updated };
}

function removedNodeIds(snapNodes, draftNodes) {
  return Object.keys(snapNodes).filter((id) => !Object.prototype.hasOwnProperty.call(draftNodes, id));
}

export function assignRevisionsAndDiff(snapshot, draftView) {
  const snapNodes = (snapshot && snapshot.nodes) || {};
  const draftNodes = draftView.nodes || {};
  const assigned = assignDraftNodes(snapshot, draftNodes, snapNodes);
  return { ...assigned, removed: removedNodeIds(snapNodes, draftNodes) };
}

function findTargetRevision(entries, targetId) {
  return entries.find((entry) => entry.id === targetId)?.node.revision;
}

export function deriveTargetRevision(snapshot, plan, created, updated) {
  const targetId = plan.target.id;
  const changedRevision = findTargetRevision(created, targetId) ?? findTargetRevision(updated, targetId);
  if (changedRevision !== undefined) {return changedRevision;}
  const previous = snapshot && snapshot.nodes ? snapshot.nodes[targetId] : null;
  return previous && Number.isInteger(previous.revision) ? previous.revision : null;
}
