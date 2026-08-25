// Pure layout helper for the Execution view (T-ui-graph-layout-core).
//
// Implements ADR-002 (§§Algoritmo y Hash + §Cruces entre initiatives):
//   - rank X from BLOCKS edges only (non-BLOCKS do not alter positions);
//   - initiative lanes on Y, alphabetical with "(none)" last;
//   - stable order inside (rank, lane) buckets via previousPositionsById;
//   - deterministic SCCs with shared rank + backedges preserved;
//   - missing endpoints diagnosed without failure;
//   - topologyHash + positionedSetHash so the renderer can split
//     structural changes from style/visibility changes;
//   - gutter reserved between lanes; no unbounded crossing minimizer.
//
// Pure: no I/O, no DOM, no JSX. Reuses NODE_W/NODE_H/computeAdjacency
// from graph-helpers.mjs without mutating that module. Coexists with
// computeLayout (the legacy helper) — this file is the layout source of
// truth for Execution once integrated.

import { NODE_W, NODE_H, computeAdjacency } from "./graph-helpers.mjs";

// Spacing constants. ROW_H mirrors computeLayout so node boxes from
// both helpers remain interchangeable in size; COL_W gives enough room
// for edge labels and visual breathing. LANE_HEADER reserves space for
// the visual lane chrome above the first node of each lane; LANE_PADDING
// closes the lane; GUTTER is the cross-initiative reservation per ADR
// ("reserva un gutter fijo de 48 px entre lanes y deja que Cytoscape
// trace bezier/edge existente").
const COL_W = NODE_W + 70;
const ROW_H = NODE_H + 36;
const LANE_HEADER = 40;
const LANE_PADDING = 12;
const GUTTER = 48;
const TOP_MARGIN = 40;

// Sentinel used to push "(none)" to the end of the alphabetically sorted
// lane list. We pick a high-codepoint private char so plain localeCompare
// with the same prefix still does the right thing.
const NONE_SORT_SENTINEL = "\uffff";

function laneSortKey(name) {
  return name === "(none)" ? NONE_SORT_SENTINEL + name : name;
}

function compareLaneNames(a, b) {
  const ka = laneSortKey(a);
  const kb = laneSortKey(b);
  if (ka < kb) return -1;
  if (ka > kb) return 1;
  return 0;
}

function iniOf(node) {
  return node && node.initiative ? node.initiative : "(none)";
}

// Resolve visibility from options.previousPositionsById / visibleIds and
// keep only what the layout needs. Returns the visible node map, a
// stable id list (insertion order of `nodes`), and the previous-position
// map restricted to the visible set.
function resolveVisibility(nodes, options) {
  const visibleIds = options && options.visibleIds;
  const previousPositionsById = (options && options.previousPositionsById) || null;

  const visibleNodes = {};
  const idList = [];
  if (visibleIds && typeof visibleIds.has === "function") {
    for (const id of Object.keys(nodes)) {
      if (visibleIds.has(id)) {
        visibleNodes[id] = nodes[id];
        idList.push(id);
      }
    }
  } else {
    for (const id of Object.keys(nodes)) {
      visibleNodes[id] = nodes[id];
      idList.push(id);
    }
  }

  const previousVisible = {};
  if (previousPositionsById) {
    for (const id of idList) {
      if (previousPositionsById[id]) previousVisible[id] = previousPositionsById[id];
    }
  }

  return { visibleNodes, idList, previousVisible };
}

// Tarjan's strongly connected components, deterministic. Visits nodes in
// sorted id order and emits SCCs sorted by their smallest member (so the
// SCC DAG iteration in buildSCCDag is reproducible across runs). Members
// inside each SCC are returned in lexicographic order — that's the order
// the rank loop will use as a stable tie-break.
function tarjanSCC(outgoing, ids) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowlinks = new Map();
  const sccs = [];

  function strongconnect(v) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    const succs = outgoing.get(v) || [];
    for (const w of succs) {
      if (!indices.has(w)) {
        strongconnect(w);
        if (lowlinks.get(w) < lowlinks.get(v)) lowlinks.set(v, lowlinks.get(w));
      } else if (onStack.has(w)) {
        if (indices.get(w) < lowlinks.get(v)) lowlinks.set(v, indices.get(w));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      scc.sort();
      sccs.push(scc);
    }
  }

  const sortedIds = ids.slice().sort();
  for (const id of sortedIds) {
    if (!indices.has(id)) strongconnect(id);
  }

  sccs.sort((a, b) => {
    const minA = a[0];
    const minB = b[0];
    if (minA !== minB) return minA < minB ? -1 : 1;
    if (a.length !== b.length) return a.length - b.length;
    return 0;
  });

  return sccs;
}

// Build the SCC DAG: maps each node to its SCC index and gives successor
// / predecessor SCC sets for the rank computation.
function buildSCCDag(sccs, blocksEdges, nodeSet) {
  const sccOfNode = new Map();
  sccs.forEach((scc, i) => {
    for (const id of scc) sccOfNode.set(id, i);
  });

  const succOfScc = new Map();
  const predOfScc = new Map();
  for (let i = 0; i < sccs.length; i++) {
    succOfScc.set(i, new Set());
    predOfScc.set(i, new Set());
  }

  for (const e of blocksEdges) {
    if (!nodeSet.has(e.from) || !nodeSet.has(e.to)) continue;
    const fromScc = sccOfNode.get(e.from);
    const toScc = sccOfNode.get(e.to);
    if (fromScc !== toScc) {
      succOfScc.get(fromScc).add(toScc);
      predOfScc.get(toScc).add(fromScc);
    }
  }

  return { sccOfNode, succOfScc, predOfScc };
}

// Compute rank per SCC. rank(scc) = 0 when no predecessors, else
// 1 + max(rank of predecessors). Iteration is a Kahn-style topological
// pass on the SCC DAG (sources first) so each SCC sees only ranks that
// have already been computed. Tie-breaks on queue insertion keep the
// order deterministic across runs.
function computeRanks(succOfScc, predOfScc) {
  const ranks = new Map();
  const sccIds = [...succOfScc.keys()].sort((a, b) => a - b);

  const inDegree = new Map();
  for (const scc of sccIds) inDegree.set(scc, predOfScc.get(scc).size);

  const queue = [];
  for (const scc of sccIds) {
    if ((inDegree.get(scc) || 0) === 0) queue.push(scc);
  }
  queue.sort((a, b) => a - b);

  const topoOrder = [];
  while (queue.length) {
    const scc = queue.shift();
    topoOrder.push(scc);
    const succs = [...(succOfScc.get(scc) || new Set())].sort((a, b) => a - b);
    for (const next of succs) {
      const d = (inDegree.get(next) || 0) - 1;
      inDegree.set(next, d);
      if (d === 0) {
        const idx = queue.findIndex((q) => q > next);
        if (idx === -1) queue.push(next);
        else queue.splice(idx, 0, next);
      }
    }
  }

  for (const scc of topoOrder) {
    const preds = predOfScc.get(scc);
    if (preds.size === 0) {
      ranks.set(scc, 0);
      continue;
    }
    let best = -1;
    for (const p of preds) {
      const r = ranks.get(p);
      if (typeof r === "number" && r > best) best = r;
    }
    ranks.set(scc, best >= 0 ? best + 1 : 0);
  }

  return ranks;
}

// Stable comparator for ids inside a (rank, lane) bucket. Previous
// positions come first in (y, x) order — top-to-bottom within a lane,
// left-to-right as tie-break. Items without previous positions go after
// in lexicographic id order. This gives nodes a stable slot as long as
// their bucket doesn't change, which is exactly the ADR's "orden estable"
// requirement.
function stableOrder(a, b, previousVisible) {
  const pa = previousVisible[a];
  const pb = previousVisible[b];
  if (pa && !pb) return -1;
  if (!pa && pb) return 1;
  if (pa && pb) {
    if (pa.y !== pb.y) return pa.y - pb.y;
    if (pa.x !== pb.x) return pa.x - pb.x;
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// FNV-1a 32-bit. Deterministic across runs, no deps, fast on small
// strings. The hash is built over a fixed-shape key list, so any change
// to ids, lane assignment, or BLOCKS edges flips it.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ("00000000" + (h >>> 0).toString(16)).slice(-8);
}

// Group visible nodes into (lane -> ids). Lane name = node.initiative
// or "(none)" — the empty-string value emitted by toCytoscapeElements
// normalizes to "(none)" here, so both code paths agree on the lane key.
function groupByLane(visibleNodes, idList) {
  const lanes = new Map();
  for (const id of idList) {
    const ini = iniOf(visibleNodes[id]);
    if (!lanes.has(ini)) lanes.set(ini, []);
    lanes.get(ini).push(id);
  }
  return lanes;
}

// Detect cycles among visible BLOCKS edges. Returns one entry per SCC:
//   - SCC size > 1: a true cycle, all members listed;
//   - SCC size 1 with a self-loop on the outgoing map: also a cycle.
// Single-node SCCs without a self-loop are not cycles and are skipped.
function detectCycles(sccs, outgoing) {
  const cycles = [];
  for (const scc of sccs) {
    if (scc.length > 1) {
      cycles.push(scc.slice());
      continue;
    }
    if (scc.length === 1) {
      const id = scc[0];
      const succs = outgoing.get(id) || [];
      if (succs.indexOf(id) !== -1) cycles.push([id]);
    }
  }
  return cycles;
}

// Endpoints of BLOCKS edges that point outside the visible node set are
// surfaced as string diagnostics. Non-BLOCKS edges are ignored for layout
// — they may still be present in `edges` for the renderer; the helper
// does not need to track them here.
function detectMissingEndpoints(edges, nodeSet) {
  const missing = [];
  for (const e of edges || []) {
    if (!e || e.type !== "BLOCKS") continue;
    const fromMissing = !nodeSet.has(e.from);
    const toMissing = !nodeSet.has(e.to);
    if (fromMissing || toMissing) {
      missing.push(`${e.from}>${e.to}`);
    }
  }
  return missing;
}

// Public entry point. Returns the documented shape:
//
//   {
//     positions:       { [id]: { x, y } },
//     lanes:           [{ initiative, y, height, nodeIds }],
//     topologyHash:    string,
//     positionedSetHash: string,
//     diagnostics:     { cycles: string[][], missingEndpoints: string[] },
//   }
//
// The helper is pure: identical inputs produce identical output. It does
// not touch the DOM, the network, the file system, or any global state.
export function computeExecutionLayout(nodes, edges, options = {}) {
  const { visibleNodes, idList, previousVisible } = resolveVisibility(nodes || {}, options);
  const nodeSet = new Set(idList);

  // Filter BLOCKS edges to the visible set. Non-BLOCKS edges are kept in
  // `edges` for the renderer's own use but do not affect geometry.
  const blocksEdges = (edges || []).filter(
    (e) => e && e.type === "BLOCKS" && nodeSet.has(e.from) && nodeSet.has(e.to),
  );

  // Outgoing adjacency restricted to visible BLOCKS edges, for Tarjan.
  const outgoing = new Map();
  for (const id of idList) outgoing.set(id, []);
  for (const e of blocksEdges) outgoing.get(e.from).push(e.to);

  const sccs = tarjanSCC(outgoing, idList);
  const { sccOfNode, succOfScc, predOfScc } = buildSCCDag(sccs, blocksEdges, nodeSet);
  const sccRanks = computeRanks(succOfScc, predOfScc);

  // Lane assignment: alphabetical with "(none)" last.
  const lanesByName = groupByLane(visibleNodes, idList);
  const laneNames = [...lanesByName.keys()].sort(compareLaneNames);

  const positions = {};
  const laneDescriptors = [];
  let maxRank = 0;
  let y = TOP_MARGIN;

  for (const name of laneNames) {
    const idsInLane = lanesByName.get(name);

    const byRank = new Map();
    for (const id of idsInLane) {
      const sccIdx = sccOfNode.get(id);
      const rank = sccRanks.has(sccIdx) ? sccRanks.get(sccIdx) : 0;
      if (!byRank.has(rank)) byRank.set(rank, []);
      byRank.get(rank).push(id);
    }

    for (const ids of byRank.values()) {
      ids.sort((a, b) => stableOrder(a, b, previousVisible));
    }

    const laneTopY = y;
    let laneDeepestCount = 0;
    const ranks = [...byRank.keys()].sort((a, b) => a - b);
    for (const r of ranks) {
      if (r > maxRank) maxRank = r;
      const ids = byRank.get(r);
      ids.forEach((id, idx) => {
        positions[id] = { x: r * COL_W, y: y + LANE_HEADER + idx * ROW_H };
      });
      if (ids.length > laneDeepestCount) laneDeepestCount = ids.length;
    }

    const laneHeight = LANE_HEADER + Math.max(0, laneDeepestCount - 1) * ROW_H + NODE_H + LANE_PADDING;
    laneDescriptors.push({
      initiative: name,
      y: laneTopY,
      height: laneHeight,
      nodeIds: idsInLane.slice().sort(),
    });

    y += laneHeight + GUTTER;
  }

  const cycles = detectCycles(sccs, outgoing);
  const missingEndpoints = detectMissingEndpoints(edges || [], nodeSet);

  // topologyHash — visible ids + their lane key + visible BLOCKS edges,
  // all sorted. Title, status, claim, selection, focus never enter here:
  // they belong to the style hash consumed by the renderer.
  const topoKeyParts = [];
  const sortedIds = idList.slice().sort();
  for (const id of sortedIds) topoKeyParts.push(`${id}\u0001${iniOf(visibleNodes[id])}`);
  const sortedBlocks = blocksEdges.map((e) => `${e.from}>${e.to}`).sort();
  for (const k of sortedBlocks) topoKeyParts.push(`e\u0001${k}`);
  const topologyHash = fnv1a(topoKeyParts.join("\n"));

  // positionedSetHash — ids and edges that actually received positions.
  // This is the key the renderer compares to decide whether to relayout
  // when the mode/filtro changes without a topology change.
  const positionedIds = Object.keys(positions).sort();
  const positionedEdgeKeys = [];
  for (const e of blocksEdges) {
    if (positions[e.from] && positions[e.to]) positionedEdgeKeys.push(`${e.from}>${e.to}`);
  }
  positionedEdgeKeys.sort();
  const positionedSetHash = fnv1a([...positionedIds, ...positionedEdgeKeys].join("\n"));

  return {
    positions,
    lanes: laneDescriptors,
    topologyHash,
    positionedSetHash,
    diagnostics: {
      cycles,
      missingEndpoints,
    },
  };
}

// Exposed constants — useful for tests / integration in Graph.jsx without
// re-importing from graph-helpers.mjs. Kept in sync with the values above.
export const EXECUTION_LAYOUT_CONSTANTS = Object.freeze({
  COL_W,
  ROW_H,
  LANE_HEADER,
  LANE_PADDING,
  GUTTER,
  TOP_MARGIN,
});

// Exposed for direct unit-level testing of the pure pieces (Tarjan, ranks,
// lane sort). Production code paths should only need computeExecutionLayout.
export const __internals = Object.freeze({
  resolveVisibility,
  tarjanSCC,
  buildSCCDag,
  computeRanks,
  stableOrder,
  compareLaneNames,
  fnv1a,
  detectCycles,
  detectMissingEndpoints,
});

// Touch computeAdjacency so tree-shakers keep the import live for code
// paths that may extend the helper later (e.g., adding weighted BLOCKS).
// Cheap no-op reference; never executed.
if (typeof computeAdjacency !== "function") {
  throw new Error("execution-layout: graph-helpers.computeAdjacency is missing");
}