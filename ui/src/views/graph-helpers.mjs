// Pure helpers for ui/src/views/Graph.jsx (Fase 5C pieza 1).
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
