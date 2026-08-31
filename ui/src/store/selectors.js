// ui/src/store/selectors.js
//
// Pure selectors over normalized entities. Selectors never mutate inputs
// and never reach for the snapshot shape; callers feed them the entities
// produced by `normalizeSnapshot` and the derived pools from the snapshot.
//
// Contract:
//   - `tasksByStatus(entities, derived)` returns node IDs grouped by
//     board column. `ready` / `blocked` / `backlog` come from the
//     snapshot's derived pools, filtered to tasks actually present in
//     `entities.nodes`. `in_progress` is scanned from `entities.nodes`
//     because the snapshot doesn't expose that pool; `submitted` comes from
//     the explicit lifecycle pool and stays separate from readiness buckets.
//     All lifecycle pools are deduped against the others. The returned arrays
//     preserve the derived order; in_progress is sorted by id for determinism.
//   - `openGates(entities, derived)` returns IDs of gates currently open.
//     Backed by `derived.openGates`; filtered to gates actually present.
//   - `nodesMap(entities)` returns the entity map by id. Trivial accessor
//     kept here so consumers import from one place, not from `normalize.js`.
//
// See .adrs/010-ui-live-store.md §3.2 / §3.3 / §3.4 and
// docs/plans/ui-live-store-execution.md §3.3 / §3.4 / §11.1.

function isTaskNode(node) {
  return !!node && typeof node === "object" && node.subkind === "task";
}

function isGateNode(node) {
  return !!node && typeof node === "object" && node.subkind === "gate";
}

function entitiesNodes(entities) {
  if (!entities || typeof entities !== "object") return {};
  const nodes = entities.nodes;
  return nodes && typeof nodes === "object" ? nodes : {};
}

// Walk a derived ID pool, keeping only IDs whose node is present and
// passes `predicate`. Preserves the order of the source list so callers
// that want "first blocker first" don't have to re-sort.
function stableFromDerived(pool, nodes, predicate) {
  if (!Array.isArray(pool)) return [];
  const out = [];
  for (const id of pool) {
    if (id == null) continue;
    const n = nodes[id];
    if (!n) continue;
    if (predicate && !predicate(n)) continue;
    out.push(id);
  }
  return out;
}

export function tasksByStatus(entities, derived) {
  const nodes = entitiesNodes(entities);
  const d = derived && typeof derived === "object" ? derived : {};
  const ready = stableFromDerived(d.ready, nodes, isTaskNode);
  const submitted = Array.isArray(d.submitted)
    ? stableFromDerived(d.submitted, nodes, isTaskNode)
    : Object.keys(nodes)
      .sort()
      .filter((id) => isTaskNode(nodes[id]) && (nodes[id].status || "open") === "submitted");
  const blocked = stableFromDerived(d.blocked, nodes, isTaskNode);
  const backlog = stableFromDerived(d.backlog, nodes, isTaskNode);

  const seen = new Set();
  for (const id of ready) seen.add(id);
  for (const id of submitted) seen.add(id);
  for (const id of blocked) seen.add(id);
  for (const id of backlog) seen.add(id);

  // in_progress is not exposed by the server; scan entities.nodes sorted
  // by id so the order is stable across polls.
  const inProgress = [];
  const ids = Object.keys(nodes).sort();
  for (const id of ids) {
    const n = nodes[id];
    if (!isTaskNode(n)) continue;
    if ((n.status || "open") !== "in_progress") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    inProgress.push(id);
  }

  return { ready, in_progress: inProgress, submitted, blocked, backlog };
}

export function openGates(entities, derived) {
  const nodes = entitiesNodes(entities);
  const d = derived && typeof derived === "object" ? derived : {};
  return stableFromDerived(d.openGates, nodes, isGateNode);
}

export function nodesMap(entities) {
  return entitiesNodes(entities);
}
