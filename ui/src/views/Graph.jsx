import { createEffect, createMemo, createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { useStore } from "../store.jsx";
import { AlertBanner, Empty, PageHeader, PageLayout } from "../components.jsx";
import {
  GRAPH_VIEW_MODES,
  applyGraphFilters,
  applyGraphSearch,
  crossInitiativeEdges,
  downstreamImpact,
  isExecutionEmpty,
  upstreamBlockers,
  visibleSetForMode,
} from "./graph-view-model.mjs";
import { computeExecutionLayout } from "./execution-layout.mjs";
import { abbreviate, kindFor } from "./graph-helpers.mjs";
import { readGraphPalette } from "./graph-palette.mjs";

/*
 * Graph is deliberately a renderer, not a second source of truth. Snapshot,
 * selection and view mode remain in the store; this view only derives a
 * legible projection for Cytoscape.
 *
 * The projections have different jobs:
 * - Execution is a spacious ranked dependency map, with initiative lanes.
 * - History is a ranked lineage map for DERIVED_FROM/SUPERSEDES.
 * - All is a compact, deterministic initiative atlas. It never puts 234
 *   titles on a canvas at once; selection and the detail drawer disclose them.
 */

const EXECUTION_NODE = { width: 184, height: 58 };
const HISTORY_NODE = { width: 164, height: 52 };
const ALL_NODE = 22;
const FIT_PADDING = 36;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2.8;
const MODE_LABEL = { execution: "Execution", history: "History", all: "All" };
const MODE_HINT = {
  execution: "Ranked by active blockers. Initiative lanes make ownership and hand-offs easy to scan.",
  history: "Lineage only: derivations and superseding decisions, ordered left to right.",
  all: "Compact initiative atlas. Select a node to reveal its relationships without turning the overview into a hairball.",
};
const CLOSED = new Set(["done", "canceled", "resolved", "superseded", "deprecated"]);

const CONTROL =
  "ui-control min-h-[36px] rounded-control border border-line bg-panel-2 px-3 text-[13px] text-body outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";
const BUTTON =
  "ui-control inline-flex min-h-[36px] items-center rounded-control border border-line bg-panel px-3 text-[12px] font-medium text-body hover:border-line-strong hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";
const MODE_BUTTON =
  "inline-flex min-h-[32px] items-center rounded-[7px] border border-transparent px-3 text-[12px] font-medium text-body hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

function stableIds(nodes) {
  return Object.keys(nodes || {}).sort((a, b) => {
    const left = nodes[a] || {};
    const right = nodes[b] || {};
    const leftOpen = CLOSED.has(left.status || "open") ? 1 : 0;
    const rightOpen = CLOSED.has(right.status || "open") ? 1 : 0;
    return leftOpen - rightOpen || a.localeCompare(b);
  });
}

function initiativeOf(node) {
  return node?.initiative || "Unassigned";
}

function edgeId(edge, index) {
  return `${edge.from}>${edge.to}:${edge.type || "RELATES_TO"}:${index}`;
}

function graphKey(set, mode, relationMode) {
  const ids = Object.keys(set.nodes || {}).sort().join(",");
  const edges = (set.edges || []).map((e) => `${e.from}>${e.to}:${e.type || ""}`).sort().join(",");
  return `${mode}|${relationMode}|${ids}|${edges}`;
}

function rankNodes(nodes, edges) {
  const ids = Object.keys(nodes || {});
  const incoming = new Map(ids.map((id) => [id, []]));
  const outgoing = new Map(ids.map((id) => [id, []]));
  for (const edge of edges || []) {
    if (!incoming.has(edge.to) || !outgoing.has(edge.from)) continue;
    incoming.get(edge.to).push(edge.from);
    outgoing.get(edge.from).push(edge.to);
  }
  const inDegree = new Map(ids.map((id) => [id, incoming.get(id).length]));
  const queue = ids.filter((id) => inDegree.get(id) === 0).sort();
  const rank = new Map(ids.map((id) => [id, 0]));
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    seen.add(id);
    for (const next of (outgoing.get(id) || []).slice().sort()) {
      rank.set(next, Math.max(rank.get(next) || 0, (rank.get(id) || 0) + 1));
      const degree = (inDegree.get(next) || 0) - 1;
      inDegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
    queue.sort();
  }
  // Cycles have no source. Give each member a deterministic rank rather
  // than allowing a layout loop or piling them at the origin.
  for (const id of ids.sort()) if (!seen.has(id)) rank.set(id, rank.get(id) || 0);
  return rank;
}

function laneLayout(nodes, edges, mode) {
  const size = mode === "history" ? HISTORY_NODE : EXECUTION_NODE;
  const rank = rankNodes(nodes, edges);
  const lanes = new Map();
  for (const id of stableIds(nodes)) {
    const initiative = initiativeOf(nodes[id]);
    if (!lanes.has(initiative)) lanes.set(initiative, []);
    lanes.get(initiative).push(id);
  }
  const positions = {};
  const groups = [];
  const names = [...lanes.keys()].sort((a, b) => a.localeCompare(b));
  let y = 42;
  let maxRank = 0;
  for (const name of names) {
    const buckets = new Map();
    for (const id of lanes.get(name)) {
      const value = rank.get(id) || 0;
      maxRank = Math.max(maxRank, value);
      if (!buckets.has(value)) buckets.set(value, []);
      buckets.get(value).push(id);
    }
    let rows = 1;
    for (const bucket of buckets.values()) rows = Math.max(rows, bucket.length);
    const height = 48 + rows * (size.height + 28) + 18;
    const width = Math.max(420, (maxRank + 1) * (size.width + 92) + 80);
    groups.push({ id: `__group__${safeId(name)}`, label: name, x: width / 2, y: y + height / 2, width, height });
    for (const [column, bucket] of buckets) {
      bucket.forEach((id, row) => {
        positions[id] = {
          x: 58 + column * (size.width + 92) + size.width / 2,
          y: y + 48 + row * (size.height + 28) + size.height / 2,
        };
      });
    }
    y += height + 34;
  }
  // Lanes share a stable world width. It prevents lane labels moving when a
  // filter happens to remove the deepest dependency from one initiative.
  const worldWidth = Math.max(420, (maxRank + 1) * (size.width + 92) + 80);
  for (const group of groups) {
    group.width = worldWidth;
    group.x = worldWidth / 2;
  }
  return { positions, groups, size };
}

function executionProjection(nodes, edges) {
  // The execution helper handles SCCs and preserves rank stability across
  // active dependency updates. Convert its lane descriptors into bounded
  // background cards; unlike the old infinite lane bands they never affect
  // the perceived scale of the map.
  const result = computeExecutionLayout(nodes, edges, { visibleIds: new Set(Object.keys(nodes)) });
  const positions = {};
  for (const [id, point] of Object.entries(result.positions)) {
    positions[id] = { x: point.x + EXECUTION_NODE.width / 2 + 38, y: point.y + EXECUTION_NODE.height / 2 };
  }
  const maxX = Math.max(620, ...Object.values(positions).map((point) => point.x + EXECUTION_NODE.width / 2 + 46));
  const groups = result.lanes.map((lane) => ({
    id: `__group__${safeId(lane.initiative === "(none)" ? "Unassigned" : lane.initiative)}`,
    label: lane.initiative === "(none)" ? "Unassigned" : lane.initiative,
    x: maxX / 2,
    y: lane.y + lane.height / 2,
    width: maxX,
    height: lane.height,
  }));
  return { positions, groups, size: EXECUTION_NODE };
}

function atlasProjection(nodes) {
  const byInitiative = new Map();
  for (const id of stableIds(nodes)) {
    const initiative = initiativeOf(nodes[id]);
    if (!byInitiative.has(initiative)) byInitiative.set(initiative, []);
    byInitiative.get(initiative).push(id);
  }

  // This is deliberately a small masonry, rather than a rectangular grid.
  // A single dense initiative must not create three empty rows beside it and
  // force the whole atlas into an unusably low zoom level.
  const sections = [...byInitiative.entries()]
    .map(([label, ids]) => ({ label, ids }))
    .sort((a, b) => b.ids.length - a.ids.length || a.label.localeCompare(b.label));
  const columns = Math.max(1, Math.min(4, sections.length));
  const tileWidth = 392;
  const tileGap = 28;
  const headerHeight = 54;
  const nodeStep = 27;
  const positions = {};
  const groups = [];
  const columnHeights = Array(columns).fill(28);

  sections.forEach((section, index) => {
    const count = section.ids.length;
    // Dense initiatives use more columns inside their card. The nodes still
    // retain a clear 5 px gap at native scale, but the card grows downward
    // slowly enough for Fit to use a meaningful desktop zoom.
    const gridColumns = Math.max(4, Math.min(14, Math.ceil(Math.sqrt(count * 1.7))));
    const gridRows = Math.max(1, Math.ceil(count / gridColumns));
    const height = headerHeight + gridRows * nodeStep + 22;
    const column = columnHeights.reduce((best, value, candidate) => value < columnHeights[best] ? candidate : best, 0);
    const left = column * (tileWidth + tileGap);
    const top = columnHeights[column];
    const statusCounts = section.ids.reduce((counts, id) => {
      const current = nodes[id]?.status || "open";
      counts[current] = (counts[current] || 0) + 1;
      return counts;
    }, {});
    const openCount = statusCounts.open || 0;
    groups.push({
      id: `__group__${safeId(section.label)}`,
      label: section.label,
      metric: `${count} nodes · ${openCount} open`,
      x: left + tileWidth / 2,
      y: top + height / 2,
      width: tileWidth,
      height,
      tone: index % 6,
      ids: section.ids,
      gridColumns,
    });
    columnHeights[column] += height + tileGap;
  });

  for (const group of groups) {
    group.ids.forEach((id, index) => {
      const col = index % group.gridColumns;
      const row = Math.floor(index / group.gridColumns);
      positions[id] = {
        x: group.x - group.width / 2 + 25 + col * nodeStep,
        y: group.y - group.height / 2 + headerHeight + 11 + row * nodeStep,
      };
    });
    delete group.ids;
    delete group.gridColumns;
  }
  return { positions, groups, size: { width: ALL_NODE, height: ALL_NODE } };
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function projectionFor(nodes, edges, mode) {
  if (mode === "all") return atlasProjection(nodes);
  if (mode === "history") return laneLayout(nodes, edges.filter((edge) => edge.type === "DERIVED_FROM" || edge.type === "SUPERSEDES"), "history");
  return executionProjection(nodes, edges);
}

function labelFor(id, node, mode, zoom) {
  if (mode === "all") return "";
  if (mode === "execution" && zoom < 0.42) return abbreviate(id, 15);
  if (mode === "history" && zoom < 0.56) return abbreviate(id, 16);
  if (zoom < 0.95) return `${abbreviate(id, 18)}\n${abbreviate(node.title, 20)}`;
  return `${id}\n${abbreviate(node.title, mode === "history" ? 30 : 34)}\n${kindFor(node)} · ${node.status || "open"}`;
}

function buildStyle(palette) {
  const status = palette.status;
  const edge = palette.edge;
  return [
    {
      selector: "node",
      style: {
        width: EXECUTION_NODE.width,
        height: EXECUTION_NODE.height,
        shape: "round-rectangle",
        "background-color": palette.nodeFill,
        "border-color": palette.nodeBorderDefault,
        "border-width": 1.5,
        color: palette.nodeLabel,
        label: "data(label)",
        "font-family": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        "font-size": 10,
        "font-weight": 500,
        "text-wrap": "wrap",
        "text-max-width": 156,
        "text-valign": "center",
        "text-halign": "center",
        "overlay-opacity": 0,
      },
    },
    { selector: "node.history-node", style: { width: HISTORY_NODE.width, height: HISTORY_NODE.height, "text-max-width": 138 } },
    { selector: "node.all-node", style: { width: ALL_NODE, height: ALL_NODE, label: "", "border-width": 1.65, "background-opacity": 0.2 } },
    ...Object.entries(status).map(([name, value]) => ({ selector: `node.all-node[status = "${name}"]`, style: { "background-color": value.stroke, "border-color": value.stroke } })),
    { selector: "node.all-node.closed", style: { opacity: 0.76 } },
    { selector: "node.gate", style: { shape: "diamond", "background-color": palette.gateFill } },
    { selector: "node.knowledge", style: { shape: "ellipse", "background-color": palette.knowledgeFill } },
    ...Object.entries(status).map(([name, value]) => ({ selector: `node[status = "${name}"]`, style: { "border-color": value.stroke } })),
    { selector: "node.closed", style: { opacity: 0.62 } },
    { selector: "node.selected", style: { "border-color": palette.focus, "border-width": 3, opacity: 1, "z-index": 6 } },
    { selector: "node.all-node.selected", style: { width: 30, height: 30 } },
    { selector: "node.neighbor", style: { "border-width": 2.5, opacity: 1, "z-index": 5 } },
    { selector: "node.dimmed", style: { opacity: 0.16 } },
    {
      selector: "node.group",
      style: {
        width: "data(width)", height: "data(height)", label: "data(label)",
        shape: "round-rectangle", "background-color": "#ffffff", "background-opacity": 0.72,
        "border-color": "#cfd5df", "border-width": 1.25, "border-style": "solid",
        color: "#596171", "font-size": 12, "font-weight": 700,
        "text-valign": "top", "text-halign": "left", "text-margin-x": 14, "text-margin-y": 10,
        "z-index": 0, events: "no",
      },
    },
    { selector: "node.group.all-group", style: { label: "", "background-opacity": 0.9 } },
    { selector: "node.group.all-group.tone-0", style: { "background-color": "#edf5ff", "border-color": "#b9d4ff" } },
    { selector: "node.group.all-group.tone-1", style: { "background-color": "#f2efff", "border-color": "#d5cbff" } },
    { selector: "node.group.all-group.tone-2", style: { "background-color": "#ebfbf3", "border-color": "#b9e8d0" } },
    { selector: "node.group.all-group.tone-3", style: { "background-color": "#fff7e8", "border-color": "#f0d39c" } },
    { selector: "node.group.all-group.tone-4", style: { "background-color": "#fff1f3", "border-color": "#fecdd6" } },
    { selector: "node.group.all-group.tone-5", style: { "background-color": "#eef7f8", "border-color": "#b9e2e7" } },
    {
      selector: "edge",
      style: {
        width: 1.25, "line-color": edge.RELATES_TO, "target-arrow-color": edge.RELATES_TO,
        "target-arrow-shape": "triangle", "arrow-scale": 0.72,
        "curve-style": "bezier", opacity: 0.34, label: "data(label)",
        color: palette.nodeLabelMuted, "font-size": 9, "font-weight": 600,
        "text-rotation": "autorotate", "text-background-color": "#ffffff",
        "text-background-opacity": 0.9, "text-background-padding": 2,
      },
    },
    { selector: "edge.BLOCKS", style: { "line-color": edge.BLOCKS, "target-arrow-color": edge.BLOCKS, "line-style": "solid", opacity: 0.56 } },
    { selector: "edge.SUPERSEDES", style: { "line-color": edge.SUPERSEDES, "target-arrow-color": edge.SUPERSEDES, "line-style": "dashed", opacity: 0.56 } },
    { selector: "edge.DERIVED_FROM", style: { "line-color": edge.DERIVED_FROM, "target-arrow-color": edge.DERIVED_FROM, "line-style": "solid", opacity: 0.56 } },
    { selector: "edge.cross", style: { width: 2, "line-style": "dashed" } },
    { selector: "edge.context", style: { opacity: 0.96, width: 2.4, "z-index": 5 } },
    { selector: "edge.hidden", style: { display: "none" } },
    { selector: "edge.dimmed", style: { opacity: 0.06 } },
  ];
}

function fallbackPalette() {
  return {
    nodeFill: "#fafbfc", gateFill: "#fff7e8", knowledgeFill: "#f2efff", nodeBorderDefault: "#d9dde5", nodeLabel: "#3f4652", nodeLabelMuted: "#717886", focus: "#1769e0",
    status: {
      open: { stroke: "#a86509" }, in_progress: { stroke: "#1769e0" }, done: { stroke: "#188a5b" }, canceled: { stroke: "#9aa1ad" }, blocked: { stroke: "#be123c" }, resolved: { stroke: "#7157d9" }, superseded: { stroke: "#7157d9" }, deprecated: { stroke: "#9aa1ad" }, active: { stroke: "#7157d9" }, stale: { stroke: "#a86509" },
    },
    edge: { BLOCKS: "#be123c", SUPERSEDES: "#7157d9", DERIVED_FROM: "#1769e0", RELATES_TO: "#9aa1ad" },
  };
}

function overviewEdges(nodes, edges) {
  // All can contain hundreds of BLOCKS edges. Drawing all of them answers
  // nothing: the map turns into a red knot. Keep a representative backbone:
  // bridges between initiatives first, then a few high-signal local links per
  // card. Selecting a node always adds its complete incident set below.
  const initiatives = new Set(Object.values(nodes).map(initiativeOf));
  const budget = Math.min(42, Math.max(16, initiatives.size * 3));
  const activity = (node) => CLOSED.has(node?.status || "open") ? 0 : 1;
  const sorted = [...edges].sort((left, right) => {
    const leftCross = initiativeOf(nodes[left.from]) !== initiativeOf(nodes[left.to]) ? 1 : 0;
    const rightCross = initiativeOf(nodes[right.from]) !== initiativeOf(nodes[right.to]) ? 1 : 0;
    const leftScore = leftCross * 8 + activity(nodes[left.from]) + activity(nodes[left.to]);
    const rightScore = rightCross * 8 + activity(nodes[right.from]) + activity(nodes[right.to]);
    return rightScore - leftScore || `${left.from}>${left.to}:${left.type || ""}`.localeCompare(`${right.from}>${right.to}:${right.type || ""}`);
  });
  const picked = [];
  const seen = new Set();
  const localCounts = new Map();
  const add = (edge) => {
    const key = `${edge.from}>${edge.to}:${edge.type || ""}`;
    if (seen.has(key) || picked.length >= budget) return false;
    seen.add(key); picked.push(edge); return true;
  };

  // Cross-initiative links explain hand-offs, but are capped so they cannot
  // dominate a dense snapshot.
  for (const edge of sorted) {
    if (initiativeOf(nodes[edge.from]) !== initiativeOf(nodes[edge.to])) add(edge);
    if (picked.length >= Math.min(16, budget)) break;
  }
  for (const edge of sorted) {
    const sourceInitiative = initiativeOf(nodes[edge.from]);
    if (initiativeOf(nodes[edge.to]) !== sourceInitiative) continue;
    if ((localCounts.get(sourceInitiative) || 0) >= 3) continue;
    if (add(edge)) localCounts.set(sourceInitiative, (localCounts.get(sourceInitiative) || 0) + 1);
  }
  for (const edge of sorted) {
    if (picked.length >= budget) break;
    add(edge);
  }
  return picked;
}

function relationshipEdges(nodes, edges, mode, selected, relationMode) {
  if (relationMode === "all") return edges;
  if (relationMode === "selected") return selected ? edges.filter((edge) => edge.from === selected || edge.to === selected) : [];
  if (mode === "all") {
    const core = overviewEdges(nodes, edges);
    // Detail is progressive: the atlas stays quiet until a node is selected,
    // then all of that node's relationships become visible without asking the
    // user to change a control.
    if (!selected) return core;
    const coreKeys = new Set(core.map((edge) => `${edge.from}>${edge.to}:${edge.type || ""}`));
    return [...core, ...edges.filter((edge) => (edge.from === selected || edge.to === selected) && !coreKeys.has(`${edge.from}>${edge.to}:${edge.type || ""}`))];
  }
  return edges.filter((edge) => edge.type === "BLOCKS" || (mode === "history" && (edge.type === "SUPERSEDES" || edge.type === "DERIVED_FROM")));
}

function modeForNode(nodes, edges, id) {
  if (!id || !nodes[id]) return null;
  for (const mode of GRAPH_VIEW_MODES) {
    if (visibleSetForMode(nodes, edges, mode).nodes[id]) return mode;
  }
  return null;
}

export default function Graph() {
  const { snapshot, select, selectedId, graphView, setGraphViewMode, setGraphViewFocus, clearGraphViewFocus } = useStore();
  const [query, setQuery] = createSignal("");
  const [initiative, setInitiative] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [kind, setKind] = createSignal("");
  const [relationMode, setRelationMode] = createSignal("overview");
  const [zoom, setZoom] = createSignal(1);
  const [narrow, setNarrow] = createSignal(false);
  const [atlasHeaders, setAtlasHeaders] = createSignal([]);
  let host;
  let cy;
  let resizeObserver;
  let onWindowResize;
  let disposed = false;
  let topologyKey = "";
  let shouldFit = true;
  let atlasHeaderFrame;

  const nodes = () => snapshot()?.nodes || {};
  const edges = () => snapshot()?.edges || [];
  const mode = () => graphView().mode;
  const baseSet = createMemo(() => visibleSetForMode(nodes(), edges(), mode()));
  const filteredSet = createMemo(() => applyGraphSearch(applyGraphFilters(baseSet(), { initiative: initiative(), status: status(), kind: kind() }, kindFor), query()));
  const validSet = createMemo(() => {
    const set = filteredSet();
    return { nodes: set.nodes, edges: set.edges.filter((edge) => set.nodes[edge.from] && set.nodes[edge.to]) };
  });
  const displayEdges = createMemo(() => relationshipEdges(validSet().nodes, validSet().edges, mode(), selectedId(), relationMode()));
  const projection = createMemo(() => projectionFor(validSet().nodes, validSet().edges, mode()));
  const nodeCount = createMemo(() => Object.keys(validSet().nodes).length);
  const initiatives = createMemo(() => [...new Set(Object.values(nodes()).map(initiativeOf))].sort((a, b) => a.localeCompare(b)));
  const statuses = createMemo(() => [...new Set(Object.values(nodes()).map((node) => node.status || "open"))].sort());
  const kinds = createMemo(() => [...new Set(Object.values(nodes()).map(kindFor))].sort());
  const crossEdges = createMemo(() => new Set(crossInitiativeEdges(validSet().nodes, displayEdges()).map((edge) => `${edge.from}>${edge.to}:${edge.type || ""}`)));
  const activeFilters = () => Boolean(query() || initiative() || status() || kind());
  const mismatch = createMemo(() => modeForNode(nodes(), edges(), selectedId()));
  const executionEmpty = createMemo(() => isExecutionEmpty(nodes(), edges()));

  function makeElements() {
    const current = validSet();
    const layout = projection();
    const currentZoom = zoom();
    const elements = layout.groups.map((group) => ({
      group: "nodes",
      data: { id: group.id, label: mode() === "all" ? "" : group.label, width: group.width, height: group.height },
      position: { x: group.x, y: group.y }, classes: `group ${mode() === "all" ? `all-group tone-${group.tone}` : ""}`, selectable: false, grabbable: false, locked: true,
    }));
    for (const [id, node] of Object.entries(current.nodes)) {
      const nodeKind = kindFor(node);
      const classes = [nodeKind, `${mode()}-node`];
      if (mode() === "all") classes.push("all-node");
      if (CLOSED.has(node.status || "open")) classes.push("closed");
      elements.push({
        group: "nodes",
        data: { id, status: node.status || "open", label: labelFor(id, node, mode(), currentZoom) },
        position: layout.positions[id], classes: classes.join(" "), locked: true,
      });
    }
    displayEdges().forEach((edge, index) => {
      const type = edge.type || "RELATES_TO";
      const key = `${edge.from}>${edge.to}:${type}`;
      elements.push({
        group: "edges",
        data: { id: edgeId(edge, index), source: edge.from, target: edge.to, type, label: "" },
        classes: `${type} ${crossEdges().has(key) ? "cross" : ""}`,
      });
    });
    return elements;
  }

  function realNodes() {
    return cy?.nodes().filter((node) => !node.hasClass("group"));
  }

  function syncAtlasHeaders() {
    if (!cy || mode() !== "all") { setAtlasHeaders([]); return; }
    const pan = cy.pan();
    const currentZoom = cy.zoom();
    const { width: hostWidth, height: hostHeight } = host.getBoundingClientRect();
    const headers = projection().groups.map((group) => {
      const left = (group.x - group.width / 2) * currentZoom + pan.x;
      const top = (group.y - group.height / 2) * currentZoom + pan.y;
      const width = group.width * currentZoom;
      return { ...group, left, top, width, visible: left + width > 0 && left < hostWidth && top + 34 > 0 && top < hostHeight };
    }).filter((group) => group.visible && group.width > 84);
    setAtlasHeaders(headers);
  }

  function scheduleAtlasHeaders() {
    cancelAnimationFrame(atlasHeaderFrame);
    atlasHeaderFrame = requestAnimationFrame(syncAtlasHeaders);
  }

  function fitGraph() {
    // In All the cards carry essential grouping context, so include their
    // finite bounds in Fit. Other modes retain their node-only camera to keep
    // execution/history lanes from adding decorative empty space.
    if (!cy) return;
    const fitElements = mode() === "all" ? cy.nodes() : realNodes();
    if (!fitElements?.length) return;
    cy.resize();
    cy.fit(fitElements, FIT_PADDING);
    setZoom(cy.zoom());
    scheduleAtlasHeaders();
  }

  function centerNode(id) {
    if (!cy || !id) return;
    const node = cy.getElementById(id);
    if (!node?.length) return;
    cy.animate({ center: { eles: node }, duration: 180 });
  }

  function refreshLabels() {
    if (!cy) return;
    const current = validSet().nodes;
    cy.batch(() => {
      for (const [id, node] of Object.entries(current)) {
        const element = cy.getElementById(id);
        if (!element?.length) continue;
        element.data("label", labelFor(id, node, mode(), zoom()));
        element.data("status", node.status || "open");
        if (CLOSED.has(node.status || "open")) element.addClass("closed");
        else element.removeClass("closed");
      }
    });
  }

  function applySelection() {
    if (!cy) return;
    const selected = selectedId();
    const focus = graphView().focus;
    const focusSet = new Set();
    if (focus?.kind === "upstream") for (const id of upstreamBlockers(edges(), focus.id)) focusSet.add(id);
    if (focus?.kind === "downstream") for (const id of downstreamImpact(edges(), focus.id)) focusSet.add(id);
    if (focus?.kind === "initiative") {
      const selectedNode = nodes()[focus.id];
      if (selectedNode) for (const [id, node] of Object.entries(validSet().nodes)) if (initiativeOf(node) === initiativeOf(selectedNode)) focusSet.add(id);
    }
    cy.batch(() => {
      cy.elements().removeClass("selected neighbor dimmed context");
      cy.edges().data("label", "");
      if (!selected) return;
      const element = cy.getElementById(selected);
      if (!element?.length) return;
      element.addClass("selected");
      const neighborhood = element.neighborhood();
      neighborhood.nodes().addClass("neighbor");
      neighborhood.edges().addClass("context").data("label", (edge) => edge.data("type"));
      for (const id of focusSet) cy.getElementById(id).addClass("neighbor");
      const keep = new Set([selected, ...focusSet]);
      neighborhood.nodes().forEach((node) => keep.add(node.id()));
      cy.nodes().filter((node) => !node.hasClass("group") && !keep.has(node.id())).addClass("dimmed");
    });
  }

  function rebuild() {
    if (!cy) return;
    cy.elements().remove();
    cy.add(makeElements());
    applySelection();
    refreshLabels();
    scheduleAtlasHeaders();
    if (shouldFit) requestAnimationFrame(fitGraph);
    shouldFit = false;
  }

  function changeMode(next) {
    if (next === mode()) return;
    shouldFit = true;
    setRelationMode(next === "all" ? "overview" : "overview");
    setGraphViewMode(next);
  }

  function clearFilters() {
    setQuery(""); setInitiative(""); setStatus(""); setKind("");
    shouldFit = true;
  }

  function resetGraph() {
    clearFilters();
    setRelationMode("overview");
    clearGraphViewFocus();
    select(null);
    shouldFit = true;
    requestAnimationFrame(fitGraph);
  }

  function focus(kindName) {
    const id = selectedId();
    if (!id) return;
    const current = graphView().focus;
    if (current?.kind === kindName && current.id === id) clearGraphViewFocus();
    else setGraphViewFocus({ kind: kindName, id });
  }

  function onZoom() {
    if (!cy) return;
    const next = cy.zoom();
    if (Math.abs(next - zoom()) > 0.03) setZoom(next);
    scheduleAtlasHeaders();
  }

  createEffect(() => {
    // Relation disclosure is a first-class projection. In "selected" mode,
    // the selected id changes the actual edge collection and must rebuild it.
    const key = graphKey({ nodes: validSet().nodes, edges: displayEdges() }, mode(), relationMode());
    projection();
    if (!cy || key === topologyKey) return;
    topologyKey = key;
    rebuild();
  });

  createEffect(() => {
    selectedId(); graphView().focus;
    if (!cy) return;
    applySelection();
  });

  createEffect(() => {
    // Polling changes titles/statuses without changing graph topology. Keep
    // the rendered data fresh in place rather than resetting the camera.
    validSet(); zoom(); mode();
    if (cy) refreshLabels();
  });

  createEffect(() => {
    const id = selectedId();
    if (!id || !cy || !validSet().nodes[id]) return;
    queueMicrotask(() => centerNode(id));
  });

  onMount(async () => {
    const cytoscape = (await import("cytoscape")).default;
    if (disposed) return;
    let palette;
    try { palette = readGraphPalette(); } catch { palette = fallbackPalette(); }
    cy = cytoscape({
      container: host, style: buildStyle(palette), minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM,
      wheelSensitivity: 0.28, autoungrabify: true, boxSelectionEnabled: false,
    });
    cy.on("zoom", onZoom);
    cy.on("pan", scheduleAtlasHeaders);
    cy.on("tap", (event) => { if (event.target === cy) select(null); });
    cy.on("tap", "node", (event) => { if (!event.target.hasClass("group")) select(event.target.id()); });
    resizeObserver = new ResizeObserver(() => { if (cy) { cy.resize(); fitGraph(); } });
    resizeObserver.observe(host);
    onWindowResize = () => setNarrow(window.innerWidth < 768);
    onWindowResize();
    window.addEventListener("resize", onWindowResize);
    topologyKey = graphKey({ nodes: validSet().nodes, edges: displayEdges() }, mode(), relationMode());
    rebuild();
  });

  onCleanup(() => {
    disposed = true;
    resizeObserver?.disconnect();
    cancelAnimationFrame(atlasHeaderFrame);
    if (onWindowResize) window.removeEventListener("resize", onWindowResize);
    if (cy) { cy.destroy(); cy = null; }
  });

  return (
    <PageLayout mode="workspace">
      <div class="ui-workspace-header">
        <PageHeader
          eyebrow="Monitor"
          title="Graph"
          subtitle={MODE_HINT[mode()]}
          meta={mode() === "all" ? `${nodeCount()} nodes · ${displayEdges().length} highlighted / ${validSet().edges.length} total relations` : `${nodeCount()} nodes · ${displayEdges().length}/${validSet().edges.length} relations`}
        />
        <div class="mt-4 ui-filter-bar flex flex-wrap items-center gap-2 rounded-control border border-line bg-panel p-2">
          <div class="inline-flex items-center rounded-control bg-mid p-0.5" role="group" aria-label="Graph view mode">
            <For each={GRAPH_VIEW_MODES}>{(item) => (
              <button type="button" class={MODE_BUTTON} classList={{ "bg-panel text-ink shadow-sm": mode() === item }} aria-pressed={mode() === item} onClick={() => changeMode(item)}>
                {MODE_LABEL[item]}
              </button>
            )}</For>
          </div>
          <input class={`${CONTROL} min-w-[180px] flex-1`} type="search" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Search id or title" aria-label="Search visible graph nodes" />
          <select class={CONTROL} value={initiative()} onChange={(event) => setInitiative(event.currentTarget.value)} aria-label="Filter by initiative">
            <option value="">All initiatives</option>
            <For each={initiatives()}>{(item) => <option value={item}>{item}</option>}</For>
          </select>
          <select class={CONTROL} value={status()} onChange={(event) => setStatus(event.currentTarget.value)} aria-label="Filter by status">
            <option value="">All statuses</option>
            <For each={statuses()}>{(item) => <option value={item}>{item}</option>}</For>
          </select>
          <select class={CONTROL} value={kind()} onChange={(event) => setKind(event.currentTarget.value)} aria-label="Filter by kind">
            <option value="">All kinds</option>
            <For each={kinds()}>{(item) => <option value={item}>{item}</option>}</For>
          </select>
          <select class={CONTROL} value={relationMode()} onChange={(event) => { shouldFit = false; setRelationMode(event.currentTarget.value); }} aria-label="Relationship disclosure">
            <option value="overview">Overview links</option>
            <option value="selected">Selected node only</option>
            <option value="all">All relations</option>
          </select>
          <Show when={activeFilters()}><button type="button" class={BUTTON} onClick={clearFilters}>Clear filters</button></Show>
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-mute">
          <span><span class="text-blocked">━</span> BLOCKS</span><span><span class="text-knowledge">┄</span> SUPERSEDES</span><span><span class="text-progress">━</span> DERIVED_FROM</span>
          <Show when={selectedId()}>
            <span class="ml-1 border-l border-line pl-3">Focus</span>
            <For each={["upstream", "downstream", "initiative"]}>{(item) => <button type="button" class="rounded px-1.5 py-0.5 hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" classList={{ "bg-progress-soft text-progress": graphView().focus?.kind === item && graphView().focus?.id === selectedId() }} onClick={() => focus(item)}>{item}</button>}</For>
          </Show>
          <div class="ml-auto flex items-center gap-2">
            <select class="max-w-[180px] rounded border border-line bg-panel px-2 py-1 text-[12px] text-body" value={selectedId() || ""} onChange={(event) => select(event.currentTarget.value || null)} aria-label="Select a visible graph node">
              <option value="">Jump to node…</option>
              <For each={stableIds(validSet().nodes)}>{(id) => <option value={id}>{id} · {abbreviate(validSet().nodes[id].title, 36)}</option>}</For>
            </select>
            <button type="button" class={BUTTON} onClick={fitGraph} aria-label="Fit visible graph">Fit</button>
            <button type="button" class={BUTTON} onClick={resetGraph} aria-label="Reset graph view">Reset</button>
            <span class="mono w-11 text-right tabular-nums" aria-live="polite">{Math.round(zoom() * 100)}%</span>
          </div>
        </div>
      </div>

      <div class="ui-workspace-body flex min-h-0 flex-1 pt-4">
        <div class="ui-graph-canvas ui-graph-premium relative min-h-0 flex-1 overflow-hidden rounded-card border border-line" role="region" aria-label={`${MODE_LABEL[mode()]} graph. Select a node to open its read-only detail.`}>
          {/* Cytoscape mutates its container (including positioning). Keep the
              geometric absolute frame separate so that mutation cannot collapse
              the canvas height. */}
          <div class="absolute inset-0">
            <div ref={host} style={{ width: "100%", height: "100%", touchAction: "none" }} />
          </div>
          <Show when={mode() === "all" && atlasHeaders().length}>
            <div class="pointer-events-none absolute inset-0 z-[1] overflow-hidden" aria-hidden="true">
              <For each={atlasHeaders()}>{(header) => (
                <div class={`ui-graph-atlas-header tone-${header.tone}`} style={{ left: `${header.left + 10}px`, top: `${header.top + 9}px`, width: `${Math.max(74, header.width - 20)}px` }}>
                  <span class="ui-graph-atlas-title">{header.label}</span>
                  <span class="ui-graph-atlas-metric">{header.metric}</span>
                </div>
              )}</For>
            </div>
          </Show>
          <Show when={narrow()} fallback={<>
            <Show when={mismatch() && !validSet().nodes[selectedId()]}>
              <div class="absolute left-3 top-3 z-10 max-w-xl"><AlertBanner tone="info" title="Selected node is outside this view"><button type="button" class="underline" onClick={() => changeMode(mismatch())}>Switch to {MODE_LABEL[mismatch()]} to inspect it in the graph.</button></AlertBanner></div>
            </Show>
            <Show when={nodeCount() === 0 && mode() === "execution" && executionEmpty()}>
              <div class="absolute inset-0 grid place-items-center p-8"><Empty>No active operational work. Switch to History to inspect the decision lineage.</Empty></div>
            </Show>
            <Show when={nodeCount() === 0 && !(mode() === "execution" && executionEmpty())}>
              <div class="absolute inset-0 grid place-items-center p-8"><Empty>No nodes match the current view and filters.</Empty></div>
            </Show>
            <div class="pointer-events-none absolute bottom-3 left-3 rounded-control border border-line bg-panel/90 px-2.5 py-1.5 text-[11px] text-mute shadow-sm backdrop-blur" aria-hidden="true">
              Drag to pan · wheel to zoom · select a node for detail
            </div>
          </>}>
            <NarrowGraphFallback />
          </Show>
        </div>
      </div>
    </PageLayout>
  );
}

function NarrowGraphFallback() {
  return <div class="absolute inset-0 grid place-items-center p-8"><Empty>Graph canvas is available on screens 768 px and wider. Use the node selector or global Finder to open read-only detail.</Empty></div>;
}
