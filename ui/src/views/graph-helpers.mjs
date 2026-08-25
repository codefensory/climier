// Pure helpers for ui/src/views/Graph.jsx (Fase 5C pieza 1 core + pieza 2 UX).
//
// Splitting the helpers out of the JSX file serves two purposes:
//   1. Testability — Node can import this file directly without babel.
//   2. Isolation — the helpers are pure functions over literal inputs and
//      have no JSX / DOM dependencies. Keeping them in a .mjs file
//      documents that contract.
//
// Helpers exposed:
//   - NODE_W, NODE_H              node rect dimensions (world coords)
//   - kindFor(node)               real dashboard kind (task / gate / knowledge)
//   - computeAdjacency(nodes, edges)
//                                 one-pass Map<id, Edge[]> for incoming/outgoing
//   - computeLayout(nodes, edges) layered DAG layout using adjacency maps
//   - nodeBox(pos)                axis-aligned bounding box for a node
//   - clipToBox(fx, fy, tx, ty, box)
//                                 clip a line segment to a box boundary
//   - fitTransform(layout, vw, vh)
//                                 scale + translate that fits the graph
//   - abbreviate(title, max)      title truncation with ellipsis
//   - buildEdgePath(from, to)     SVG `d` string clipped to the target boundary
//
// Fase 5C pieza 2 (UX) helpers:
//   - nodeMatchesQuery       search by id/title, case-insensitive
//   - historyChainIds        DERIVED_FROM/SUPERSEDES endpoints (history)
//   - neighborIds            direct neighbors in both directions
//   - edgeTouches            edge touches a focus set
//   - uniqueStatuses         sorted statuses for the filter <select>
//   - uniqueKinds            sorted dashboard kinds for the filter <select>
//   - filterGraph            full visible-set pipeline (filters + history)

export const NODE_W = 192;
export const NODE_H = 56;

export function kindFor(node) {
  if (!node) return "task";
  if (node.kind === "knowledge") return "knowledge";
  if (node.subkind === "gate") return "gate";
  return "task";
}

// Build adjacency maps in a single pass. Edges whose endpoints are not in
// `nodes` are kept (their effect is just to be ignored when the layout
// walks from a known node). The Map shape guarantees O(1) lookup during
// the depth walk in computeLayout.
export function computeAdjacency(nodes, edges) {
  const incoming = new Map();
  const outgoing = new Map();
  for (const id of Object.keys(nodes)) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const e of edges) {
    if (outgoing.has(e.from)) outgoing.get(e.from).push(e);
    if (incoming.has(e.to)) incoming.get(e.to).push(e);
  }
  return { incoming, outgoing };
}

// Layered DAG layout: depth via incoming BLOCKS edges, then nodes grouped
// by initiative in horizontal bands. Pre-computed adjacency means the
// depth walk never re-scans the edge list — the cost is O(V + E) instead
// of O(V × E).
export function computeLayout(nodes, edges) {
  const { incoming } = computeAdjacency(nodes, edges);
  const depth = {};
  const compute = (id, seen) => {
    if (depth[id] !== undefined) return depth[id];
    if (seen.has(id)) return 1; // cycle guard: keep members visible
    seen.add(id);
    const blockers = (incoming.get(id) || [])
      .filter((e) => e.type === "BLOCKS" && nodes[e.from])
      .map((e) => e.from);
    const d = blockers.length
      ? 1 + Math.max(...blockers.map((b) => compute(b, seen)))
      : 1;
    depth[id] = Math.min(d, 24);
    return depth[id];
  };
  for (const id of Object.keys(nodes)) compute(id, new Set());

  const byIni = new Map();
  for (const id of Object.keys(nodes)) {
    const ini = nodes[id].initiative || "(none)";
    if (!byIni.has(ini)) byIni.set(ini, []);
    byIni.get(ini).push(id);
  }

  const COL_W = NODE_W + 70;
  const ROW_H = NODE_H + 36;
  const pos = {};
  let y = 40;
  const iniRows = [];
  for (const [ini, ids] of byIni) {
    const counts = {};
    for (const id of ids) {
      const d = depth[id];
      const idx = counts[d] || 0;
      counts[d] = idx + 1;
      pos[id] = { x: d * COL_W, y: y + idx * ROW_H };
    }
    const rowH = Math.max(1, ...Object.values(counts)) * ROW_H;
    iniRows.push({ ini, y: y - 20, height: rowH + 24 });
    y += rowH + 44;
  }
  const maxDepth = Math.max(1, ...Object.values(depth));
  return {
    pos,
    depth,
    width: maxDepth * COL_W + 80,
    height: y + 30,
    iniRows,
  };
}

// Axis-aligned bounding box for a node centered at (x, y).
export function nodeBox(pos) {
  return {
    left: pos.x - NODE_W / 2,
    right: pos.x + NODE_W / 2,
    top: pos.y - NODE_H / 2,
    bottom: pos.y + NODE_H / 2,
  };
}

// Clip a line segment from (fx, fy) toward (tx, ty) so the endpoint sits
// on the boundary of an axis-aligned box. Used so arrow markers land on
// the edge of the target node, not buried under the shape. The candidate
// crossing parameter is the first positive t in (0, 1] — that's the side
// the line crosses to ENTER the box (when the endpoint is inside) or to
// EXIT the box (when the start is inside). If both endpoints lie inside
// the box, the candidate set is empty and the endpoint is returned
// unchanged.
export function clipToBox(fx, fy, tx, ty, box) {
  const dx = tx - fx;
  const dy = ty - fy;
  if (dx === 0 && dy === 0) return { x: tx, y: ty };
  const candidates = [];
  if (dx !== 0) {
    candidates.push((box.left - fx) / dx);
    candidates.push((box.right - fx) / dx);
  }
  if (dy !== 0) {
    candidates.push((box.top - fy) / dy);
    candidates.push((box.bottom - fy) / dy);
  }
  let t = 1;
  for (const c of candidates) if (c > 0 && c <= 1 && c < t) t = c;
  return { x: fx + dx * t, y: fy + dy * t };
}

// Compute the zoom + translate that fit the entire laid-out graph inside
// a viewport of (vw, vh) with a margin. Scale is clamped so a single
// deep node can't blow the rest of the graph off-screen at low viewports.
export function fitTransform(layout, vw, vh, margin = 40) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id in layout.pos) {
    const box = nodeBox(layout.pos[id]);
    if (box.left < minX) minX = box.left;
    if (box.top < minY) minY = box.top;
    if (box.right > maxX) maxX = box.right;
    if (box.bottom > maxY) maxY = box.bottom;
  }
  if (!Number.isFinite(minX)) return { scale: 1, tx: 0, ty: 0 };
  const w = maxX - minX;
  const h = maxY - minY;
  if (w === 0 || h === 0) {
    return {
      scale: 1,
      tx: (vw - w) / 2 - minX,
      ty: (vh - h) / 2 - minY,
    };
  }
  const scale = Math.min((vw - 2 * margin) / w, (vh - 2 * margin) / h, 2.5);
  const tx = (vw - w * scale) / 2 - minX * scale;
  const ty = (vh - h * scale) / 2 - minY * scale;
  return { scale, tx, ty };
}

// Abbreviate a long title to fit inside the 192 px node body. Keeps the
// head and appends a horizontal ellipsis. Empty / null inputs become "".
export function abbreviate(title, max = 36) {
  if (!title) return "";
  if (title.length <= max) return title;
  return title.slice(0, max - 1).trimEnd() + "\u2026";
}

// Build the SVG `d` string for the edge between two node centers, clipped
// so the endpoint sits on the target box boundary. The path is shaped as
// a horizontal / vertical / diagonal segment depending on the relative
// angle — a one-corner L for axis-aligned edges, a straight line for the
// diagonal case. Cheap to render and matches what users expect from a DAG.
export function buildEdgePath(from, to) {
  const f = clipToBox(from.x, from.y, to.x, to.y, nodeBox(from));
  const t = clipToBox(from.x, from.y, to.x, to.y, nodeBox(to));
  const dx = Math.abs(t.x - f.x);
  const dy = Math.abs(t.y - f.y);
  const mx = (f.x + t.x) / 2;
  const my = (f.y + t.y) / 2;
  if (dx > dy * 1.4) {
    return `M ${f.x} ${f.y} L ${mx} ${f.y} L ${mx} ${t.y} L ${t.x} ${t.y}`;
  }
  if (dy > dx * 1.4) {
    return `M ${f.x} ${f.y} L ${f.x} ${my} L ${t.x} ${my} L ${t.x} ${t.y}`;
  }
  return `M ${f.x} ${f.y} L ${t.x} ${t.y}`;
}

// Decide whether the component should surface the "no visible
// relationships" callout: there are nodes to show, but every node in the
// full graph is an orphan (no edges) and the visible set is therefore
// disconnected. Used by Graph.jsx to render the AlertBanner.
export function shouldShowIsolationCallout(allNodes, visibleNodeCount, visibleEdgeCount) {
  if (visibleNodeCount === 0) return false;
  if (visibleEdgeCount > 0) return false;
  return Object.values(allNodes || {}).length > 0;
}

// ---------------------------------------------------------------------------
// Fase 5C pieza 2 (UX) helpers — search, filters, history chain, focus.
// All pure functions over literal inputs so Node can test them directly.
// ---------------------------------------------------------------------------

// Case-insensitive search over node id or title. A blank query matches
// everything. Missing/empty title falls back to id-only matching.
export function nodeMatchesQuery(node, q) {
  const query = (q || "").trim().toLowerCase();
  if (!query) return true;
  const id = (node.id || "").toLowerCase();
  const title = (node.title || "").toLowerCase();
  return id.includes(query) || title.includes(query);
}

// The "Show history" reveal set: ids of nodes that are endpoints of a
// DERIVED_FROM or SUPERSEDES edge — the historical chain of the project.
// BLOCKS and other edge types are not history; endpoints that are not in
// `nodes` are ignored.
export function historyChainIds(nodes, edges) {
  const ids = new Set();
  for (const e of edges || []) {
    if (e.type !== "DERIVED_FROM" && e.type !== "SUPERSEDES") continue;
    if (nodes[e.from]) ids.add(e.from);
    if (nodes[e.to]) ids.add(e.to);
  }
  return ids;
}

// Direct neighbors of `id` across any edge type, in both directions.
// Used for the focus-of-neighbors highlight.
export function neighborIds(edges, id) {
  const out = new Set();
  for (const e of edges || []) {
    if (e.from === id) out.add(e.to);
    if (e.to === id) out.add(e.from);
  }
  return out;
}

// True when an edge touches any id in the focus set (selected node + its
// neighbors). Used to keep related edges bright and dim unrelated ones.
export function edgeTouches(edge, ids) {
  return ids.has(edge.from) || ids.has(edge.to);
}

// Sorted unique persisted statuses across the nodes (missing status
// defaults to "open" — the schema default). Drives the status <select>.
export function uniqueStatuses(nodes) {
  const set = new Set();
  for (const n of Object.values(nodes || {})) set.add(n.status || "open");
  return [...set].sort();
}

// Sorted unique dashboard kinds (task / gate / knowledge) across the
// nodes. Drives the kind <select>.
export function uniqueKinds(nodes) {
  const set = new Set();
  for (const n of Object.values(nodes || {})) set.add(kindFor(n));
  return [...set].sort();
}

// The full visible-set pipeline for Graph.jsx. Applies every active filter
// with AND semantics and prunes edges to endpoints that remain visible.
//
// Filters:
//   - ini:          node.initiative === ini
//   - kind:         dashboard kind (task/gate/knowledge) === kind
//   - status:       explicit persisted status; overrides the closed-status
//                   default hiding (an explicit filter is user intent)
//   - search:       id/title match via nodeMatchesQuery
//   - showHistory:  reveal closed-status nodes that are endpoints of a
//                   DERIVED_FROM / SUPERSEDES edge (the historical chain)
//
// Defaults kept from the plan:
//   - closed-status nodes are hidden unless showHistory or an explicit
//     status filter reveals them;
//   - disconnected knowledge nodes are always hidden.
export function filterGraph(nodes, edges, filters = {}) {
  const { ini = "", search = "", status = "", kind = "", showHistory = false } = filters;
  const CLOSED = new Set(["done", "canceled", "resolved", "superseded", "deprecated"]);
  const chain = showHistory ? historyChainIds(nodes, edges) : new Set();
  const incident = new Set();
  for (const e of edges || []) {
    incident.add(e.from);
    incident.add(e.to);
  }
  const out = {};
  for (const [id, n] of Object.entries(nodes || {})) {
    if (ini && n.initiative !== ini) continue;
    if (kind && kindFor(n) !== kind) continue;
    const st = n.status || "open";
    if (status) {
      if (st !== status) continue;
    } else if (CLOSED.has(st) && !chain.has(id)) {
      continue;
    }
    if (search && !nodeMatchesQuery(n, search)) continue;
    if (kindFor(n) === "knowledge" && !incident.has(id)) continue;
    out[id] = n;
  }
  return {
    nodes: out,
    edges: (edges || []).filter((e) => out[e.from] && out[e.to]),
  };
}

// ---------------------------------------------------------------------------
// Cytoscape renderer (T-ui-graph-cyto)
// ---------------------------------------------------------------------------

// Statuses that render faded in the graph (mirrors the old SVG nodeOpacity).
const FADED_STATUSES = new Set(["done", "resolved", "superseded", "deprecated"]);

// Convert the visible graph (filterGraph output) into Cytoscape elements.
// Pure, no I/O, no DOM: literal nodes/edges in, cytoscape-shaped data out so
// Graph.jsx can feed it straight to `cy.add()`.
//
// Returns { elements, parents }:
//   - elements: node entries `{ data: { id, label: [id, title, kind · status],
//     kind, status, initiative }, classes: [kind, ...] }` and edge entries
//     `{ data: { id: "from>to", source, target, type }, classes: [type] }`.
//   - parents: per-initiative compound parent descriptors `{ id, label }`.
//     Empty today: cytoscape-dagre v4 does not support compound nodes (parents
//     stay pinned at the origin and never contain their children), so the
//     renderer uses the flat dagre layout and renders the initiative as a
//     label chip on each node instead of compound initiative bands.
export function toCytoscapeElements(nodes, edges) {
  const elements = [];
  const parents = [];
  for (const [id, n] of Object.entries(nodes || {})) {
    const status = n.status || "open";
    const kind = kindFor(n);
    const classes = [kind];
    if (FADED_STATUSES.has(status)) classes.push("faded");
    elements.push({
      data: {
        id,
        label: [id, abbreviate(n.title, 32), `${kind} · ${status}`],
        kind,
        status,
        initiative: n.initiative || "",
      },
      classes,
    });
  }
  for (const e of edges || []) {
    const type = e.type || "default";
    elements.push({
      data: { id: `${e.from}>${e.to}`, source: e.from, target: e.to, type },
      classes: [type],
    });
  }
  return { elements, parents };
}
