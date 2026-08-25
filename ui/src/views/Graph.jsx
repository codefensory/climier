import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, For, Index } from "solid-js";
import { useStore } from "../store.jsx";
import { Empty, AlertBanner, PageHeader, PageLayout } from "../components.jsx";
import {
  visibleSetForMode,
  applyGraphFilters,
  applyGraphSearch,
  upstreamBlockers,
  downstreamImpact,
  crossInitiativeEdges,
  isExecutionEmpty,
  GRAPH_VIEW_MODES,
} from "./graph-view-model.mjs";
import { computeExecutionLayout } from "./execution-layout.mjs";
import { readGraphPalette } from "./graph-palette.mjs";
import { abbreviate, kindFor } from "./graph-helpers.mjs";

// Execution Map renderer for Graph 2.0 (T-ui-graph-execution-renderer).
//
// Implements ADR-001 (§§Modos/Pipeline, §Foco, §Cruces entre initiatives)
// and ADR-002 (§§Algoritmo/Hash, §Cruces entre initiatives):
//   - source of truth for the visible graph is the new pipeline
//     visibleSetForMode → applyGraphFilters → applyGraphSearch;
//   - mode/focus live in the store (graphView: { mode, focus });
//   - positions come from computeExecutionLayout and are applied via
//     cytoscape's preset layout — dagre no longer decides geometry in
//     the Execution path;
//   - lanes render as light hairline bands + a small label per lane;
//   - cross-initiative edges get a thicker line and a focused-only
//     emphasis so the bridge reads as geometry, not just colour;
//   - selection, focus, title/status/claim updates never trigger a
//     relayout; only changes to the visible/topology set do.
//
// Constraints (from the task body):
//   - this file is the only allowed write path for this task;
//   - graph-helpers, store, NodeDetail, Finder, index.css, server,
//     package files and test/ are no-go and remain untouched;
//   - filters/search/history behaviour that used to live in
//     graph-helpers.filterGraph is now driven by the new pipeline.

// === Dimensions ============================================================
//
// Cytoscape positions are stored as the centre of the node; the layout
// helper returns the top-left corner of the NODE_W × NODE_H box. The
// preset path is the one place where the two coordinate systems meet —
// the constant below is the single offset every preset position goes
// through so the visible centre matches the layout's intended centre.
const NODE_W = 192;
const NODE_H = 56;
const KNOWLEDGE_D = 56;
const FIT_PADDING = 40;
const POS_OFFSET_X = NODE_W / 2;
const POS_OFFSET_Y = NODE_H / 2;
const WHEEL_SENSITIVITY = 0.4;
// A project can have hundreds of nodes distributed over many initiative
// lanes. 0.25 cannot fit that map in a normal workspace, so allow a true
// overview while keeping the semantic tier thresholds unchanged.
const MIN_ZOOM = 0.02;

// Lane chrome geometry. The hairline band uses a very large width so it
// stays under the visible viewport while the user pans; the label sits
// in the top-left corner of the band with a small font.
const LANE_BAND_WIDTH = 8000;
const LANE_LABEL_MARGIN = 6;
const LANE_LABEL_HEIGHT = 14;
const LANE_LABEL_WIDTH = 220;

// Statuses considered "closed" when deciding whether a node has any
// open blocker (used by the auto-upstream-on-blocked-selection path).
const CLOSED_FOR_BLOCKING = new Set([
  "done",
  "canceled",
  "resolved",
  "superseded",
  "deprecated",
]);

// === Tier model (ADR-003 §Tiers de zoom) ===================================
//
// Three discrete bands. Thresholds come from ADR-003; the hysteresis
// margin keeps the tier stable while the wheel oscillates near a
// boundary. The state lives in `tier()` (a signal); recompute happens
// only on zoom/Fit/Reset/resize, never on every render frame.
const TIER_OVERVIEW_MAX = 0.65; // exclusive upper bound of overview
const TIER_DETAIL_MIN = 1.15;   // inclusive lower bound of detail
const TIER_HYSTERESIS = 0.05;   // band around each frontier
const OVERLAY_MARGIN_PX = 96;   // viewport + margin for DOM buttons
const NARROW_VIEWPORT_PX = 768; // ADR-003 fallback threshold

// computeTier returns the new tier ("overview" | "compact" | "detail")
// given the previous tier and the current zoom. The first call (no
// previous tier) selects by raw threshold so the initial paint is
// deterministic. Subsequent calls apply hysteresis: a transition only
// fires after the zoom crosses the boundary by at least 0.05 in the
// direction of motion.
export function computeTier(currentTier, zoom) {
  const z = Number.isFinite(zoom) ? zoom : 1;
  if (currentTier !== "overview" && currentTier !== "compact" && currentTier !== "detail") {
    if (z < TIER_OVERVIEW_MAX) return "overview";
    if (z >= TIER_DETAIL_MIN) return "detail";
    return "compact";
  }
  if (currentTier === "overview") {
    // Stay overview until zoom reaches overview_max + hysteresis. Above
    // that we land in compact (or detail if also past detail_min).
    if (z < TIER_OVERVIEW_MAX + TIER_HYSTERESIS) return "overview";
    return z >= TIER_DETAIL_MIN ? "detail" : "compact";
  }
  if (currentTier === "detail") {
    // Stay detail until zoom drops below detail_min - hysteresis.
    if (z >= TIER_DETAIL_MIN - TIER_HYSTERESIS) return "detail";
    return z < TIER_OVERVIEW_MAX ? "overview" : "compact";
  }
  // currentTier === "compact"
  if (z < TIER_OVERVIEW_MAX - TIER_HYSTERESIS) return "overview";
  if (z >= TIER_DETAIL_MIN + TIER_HYSTERESIS) return "detail";
  return "compact";
}

// boxesIntersect returns true when two axis-aligned rectangles overlap.
// Used by the overlay cull to decide whether a node's rendered bounding
// box intersects the viewport plus the 96 px margin. Touching edges do
// not count as overlapping (strict inequalities).
export function boxesIntersect(a, b) {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

// modeForNode returns the first GRAPH_VIEW_MODES entry whose visible
// set contains the given id. Used by the mode-mismatch banner when the
// user picks a node from the global Finder that the current mode
// hides. Returns null when the id is unknown to the snapshot.
function modeForNode(nodes, edges, id) {
  if (!id || !nodes || !nodes[id]) return null;
  for (const m of GRAPH_VIEW_MODES) {
    const set = visibleSetForMode(nodes, edges, m);
    if (set.nodes && set.nodes[id]) return m;
  }
  return null;
}

// === Palette bridge ========================================================
//
// Cytoscape paints on canvas and cannot consume CSS variables directly,
// so the stylesheet is built from a resolved palette. The bridge is
// imported from graph-palette.mjs and read at mount time; importing
// the module is DOM-free (the readGraphPalette call is what reads CSS).
function buildStyle(palette) {
  if (!palette) {
    palette = {
      nodeFill: "#fafbfc",
      gateFill: "#fff7e8",
      knowledgeFill: "#f2efff",
      nodeBorderDefault: "#d9dde5",
      nodeLabel: "#3f4652",
      focus: "#1769e0",
      status: {
        open:        { stroke: "#a86509", text: "#a86509" },
        in_progress: { stroke: "#1769e0", text: "#1769e0" },
        done:        { stroke: "#188a5b", text: "#188a5b" },
        canceled:    { stroke: "#d9dde5", text: "#717886" },
        blocked:     { stroke: "#be123c", text: "#be123c" },
        resolved:    { stroke: "#7157d9", text: "#7157d9" },
        superseded:  { stroke: "#7157d9", text: "#7157d9" },
        deprecated:  { stroke: "#d9dde5", text: "#717886" },
        active:      { stroke: "#7157d9", text: "#7157d9" },
        stale:       { stroke: "#a86509", text: "#a86509" },
      },
      edge: {
        BLOCKS: "#be123c",
        SUPERSEDES: "#7157d9",
        DERIVED_FROM: "#1769e0",
        INFORMS: "#9aa1ad",
        RELATES_TO: "#9aa1ad",
        CONFLICTS_WITH: "#9aa1ad",
      },
    };
  }
  const STATUS_COLORS = palette.status;
  const EDGE_COLORS = palette.edge;
  return [
    {
      selector: "node",
      style: {
        width: NODE_W,
        height: NODE_H,
        shape: "round-rectangle",
        "corner-radius": 8,
        "background-color": palette.nodeFill,
        "border-width": 1.2,
        "border-color": STATUS_COLORS.open.stroke,
        color: palette.nodeLabel,
        "font-family": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        "font-size": 10,
        "text-wrap": "wrap",
        "text-max-width": 190,
        "text-valign": "center",
        "text-halign": "center",
        label: "data(label)",
        "z-index": 1,
        events: "yes",
      },
    },
    { selector: "node.gate", style: { shape: "diamond", "background-color": palette.gateFill } },
    {
      selector: "node.knowledge",
      style: { shape: "ellipse", width: KNOWLEDGE_D, height: KNOWLEDGE_D, "background-color": palette.knowledgeFill },
    },
    ...Object.keys(STATUS_COLORS).map((status) => ({
      selector: `node[status = "${status}"]`,
      style: { "border-color": STATUS_COLORS[status].stroke },
    })),
    { selector: "node.faded", style: { opacity: 0.55 } },
    { selector: "node.selected", style: { "border-width": 2.2, "border-color": palette.focus, "z-index": 3 } },
    { selector: "node.focused", style: { "border-style": "dashed" } },
    { selector: "node.neighbor", style: { "border-width": 1.8 } },
    { selector: "node.in-focus", style: { "border-style": "dashed", "border-color": palette.focus, "border-width": 1.6, "z-index": 2 } },
    { selector: "node.dimmed", style: { opacity: 0.22 } },
    { selector: "node.lane-bg", style: { events: "no", "background-opacity": 0, "border-width": 1, "border-color": "#e7e9ee", "border-style": "solid", "z-index": 0, label: "" } },
    { selector: "node.lane-label", style: { events: "no", "background-opacity": 0, "border-width": 0, "text-valign": "top", "text-halign": "left", "text-margin-x": LANE_LABEL_MARGIN, "text-margin-y": 4, "font-size": 10, "font-weight": 600, color: "#717886", "text-wrap": "wrap", "text-max-width": LANE_LABEL_WIDTH - LANE_LABEL_MARGIN * 2, label: "data(label)", "z-index": 0 } },
    {
      selector: "edge",
      style: {
        width: 1.4,
        "line-color": EDGE_COLORS.INFORMS,
        "line-style": "dashed",
        opacity: 0.65,
        "curve-style": "bezier",
        "target-arrow-shape": "triangle",
        "target-arrow-fill": "filled",
        "target-arrow-color": EDGE_COLORS.INFORMS,
      },
    },
    { selector: "edge.BLOCKS", style: { "line-color": EDGE_COLORS.BLOCKS, "target-arrow-color": EDGE_COLORS.BLOCKS, "line-style": "solid", opacity: 0.9, "z-index": 1 } },
    { selector: "edge.SUPERSEDES", style: { "line-color": EDGE_COLORS.SUPERSEDES, "target-arrow-color": EDGE_COLORS.SUPERSEDES } },
    { selector: "edge.DERIVED_FROM", style: { "line-color": EDGE_COLORS.DERIVED_FROM, "target-arrow-color": EDGE_COLORS.DERIVED_FROM } },
    { selector: "edge.cross-initiative", style: { width: 2.4, opacity: 0.9 } },
    { selector: "edge.cross-initiative.focused", style: { "line-style": "solid", width: 3, opacity: 1 } },
    { selector: "edge.bright", style: { opacity: 0.95 } },
    { selector: "edge.dimmed", style: { opacity: 0.1 } },
  ];
}

// === Cytoscape factory ====================================================
//
// A small helper that converts a visible-set + a layout result into the
// element list cytoscape will own. Lane bands and lane labels are
// ordinary cytoscape nodes with reserved id prefixes; they are added
// before the real nodes so the default z-index places real nodes on top
// (the style table reinforces this with explicit z-index values).
function buildElements(visibleSet, layoutResult, crossInitiativeSet, allNodes, tier) {
  const elements = [];
  const lanes = layoutResult ? layoutResult.lanes : [];
  for (const lane of lanes) {
    const id = `__lane__${cssEscape(lane.initiative)}`;
    elements.push({
      group: "nodes",
      data: { id, kind: "lane", label: "" },
      position: { x: POS_OFFSET_X, y: lane.y + POS_OFFSET_Y + lane.height / 2 },
      classes: "lane-bg",
    });
    if (lane.initiative !== "(none)") {
      const labelId = `${id}__label`;
      elements.push({
        group: "nodes",
        data: { id: labelId, kind: "lane-label", label: lane.initiative },
        position: { x: POS_OFFSET_X, y: lane.y + POS_OFFSET_Y + LANE_LABEL_HEIGHT / 2 },
        classes: "lane-label",
      });
    }
  }
  for (const [id, n] of Object.entries(visibleSet.nodes || {})) {
    const status = n.status || "open";
    const k = kindFor(n);
    const classes = [k];
    if (k === "knowledge" || status === "done" || status === "resolved" || status === "superseded" || status === "deprecated") {
      classes.push("faded");
    }
    elements.push({
      group: "nodes",
      data: {
        id,
        label: formatLabel(id, n),
        kind: k,
        status,
        initiative: n.initiative || "",
      },
      classes,
    });
  }
  for (const e of visibleSet.edges || []) {
    const type = e.type || "default";
    const classes = [type];
    if (crossInitiativeSet && crossInitiativeSet.has(`${e.from}>${e.to}`)) {
      classes.push("cross-initiative");
    }
    elements.push({
      group: "edges",
      data: { id: `${e.from}>${e.to}`, source: e.from, target: e.to, type },
      classes,
    });
  }
  return elements;
}

function cssEscape(s) {
  // Cytoscape element ids must avoid certain characters; we only need to
  // escape characters that could break the id parsing (parenthesis and
  // whitespace). The lane id is prefixed with __lane__ and used as a
  // data-attribute look-up, not a CSS selector, so this stays light.
  return String(s).replace(/[()\s]/g, "_");
}

function formatLabel(id, node, tier) {
  // Tier-aware label (ADR-003 §Tiers). Overview paints no legible text;
  // compact carries id + short title; detail mirrors the full card
  // content the previous version rendered at every zoom.
  const t = tier === "overview" || tier === "compact" || tier === "detail" ? tier : "detail";
  const ini = node.initiative ? ` · ${node.initiative}` : "";
  if (t === "overview") return "";
  if (t === "compact") {
    return `${id}\n${abbreviate(node.title, 18)}\n${kindFor(node)} · ${node.status || "open"}`;
  }
  return `${id}\n${abbreviate(node.title, 32)}\n${kindFor(node)} · ${node.status || "open"}${ini}`;
}

// === Signatures ===========================================================
//
// Three signatures drive the renderer, matching the two-hash model in
// ADR-002 §Hash, actualizaciones y relayout:
//   - visibleSetKey: full (ids, edges) of the visible set, including
//     non-BLOCKS edge types. It changes on any mode / filter / new
//     edge / new node. It gates the cytoscape element rebuild.
//   - positionedKey: the layout helper's positionedSetHash. It only
//     changes when the BLOCKS skeleton that actually receives
//     positions changes. It gates the preset relayout (per ADR-002:
//     "Cambiar modo/filtro relayout solo si cambia positionedSetHash").
//   - topologyHash: the layout helper's own topologyHash. It changes
//     for any visible-id change and is exposed via the layout result
//     so the renderer can debug/observe the policy in the console.
//
// Title/status/claim/selection/focus updates leave the first two
// keys untouched, so a 2s poll that only mutates a node's metadata
// skips the cytoscape element rebuild and the preset relayout —
// only the label refresh fires.
function visibleSetKey(set) {
  if (!set) return "";
  const nodeIds = Object.keys(set.nodes).sort().join(",");
  const edgeKeys = (set.edges || [])
    .map((e) => `${e.from}>${e.to}:${e.type || "default"}`)
    .sort()
    .join(",");
  return `${nodeIds}|${edgeKeys}`;
}

function positionedKey(result) {
  if (!result) return "";
  return result.positionedSetHash;
}

// === Status text (mode segmented control labels) ==========================
// "Execution" / "History" / "All" — short labels rendered as buttons
// inside the FilterBar. Kept here so the segmented control and the
// store's mode list agree.
const MODE_LABEL = {
  execution: "Execution",
  history: "History",
  all: "All",
};

// === Node is blocked? ====================================================
//
// A node is considered derivadamente blocked when it has an incoming
// BLOCKS edge whose source is not closed. Computed against the
// snapshot's edge list (the full graph, not the visible set) so the
// auto-upstream rule works on operational state, not on the filtered
// set the user happens to be looking at.
function isBlockedInSnapshot(allEdges, allNodes, id) {
  if (!id) return false;
  for (const e of allEdges || []) {
    if (e.type !== "BLOCKS") continue;
    if (e.to !== id) continue;
    const src = allNodes[e.from];
    if (!src) continue;
    if (!CLOSED_FOR_BLOCKING.has(src.status || "open")) return true;
  }
  return false;
}

// === Focus set computation ================================================
//
// Pure helper. Given the graphView.focus object and the edge list, return
// the set of node ids that belong to the focus. The shape follows
// graph-view-model.mjs so the renderer never reaches into the model to
// re-implement BFS.
function focusNodeSet(edges, focus) {
  if (!focus) return new Set();
  if (focus.kind === "upstream") return upstreamBlockers(edges, focus.id);
  if (focus.kind === "downstream") return downstreamImpact(edges, focus.id);
  // "initiative" focus highlights the lane of the selected node; the
  // store decides the seed id and the renderer widens it to the same
  // initiative. Because the store also provides the selectedId, the
  // renderer can read the initiative from the snapshot directly.
  return new Set();
}

// === Focus initiative helpers =============================================
function initiativeFocusSet(visibleSet, focus) {
  if (!focus || focus.kind !== "initiative") return new Set();
  const seed = visibleSet.nodes[focus.id];
  if (!seed) return new Set();
  const ini = seed.initiative || "(none)";
  const out = new Set();
  for (const [id, n] of Object.entries(visibleSet.nodes)) {
    if ((n.initiative || "(none)") === ini) out.add(id);
  }
  return out;
}

// === Component =============================================================
const BTN_CLS =
  "ui-control inline-flex min-h-[36px] items-center rounded-control border border-line bg-panel px-3 text-[12px] font-medium text-body " +
  "hover:border-line-strong hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";

const MODE_BTN_CLS =
  "inline-flex min-h-[32px] items-center rounded-control border border-line bg-panel px-3 text-[12px] font-medium text-body " +
  "hover:border-line-strong hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";

const MODE_BTN_ACTIVE_CLS =
  "border-progress bg-progress-soft text-progress";

const OVERLAY_BTN_CLS =
  "graph-node-overlay absolute z-[5] cursor-pointer touch-none rounded-[8px] border-0 bg-transparent p-0 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";

export default function Graph() {
  const { snapshot, select, selectedId, graphView, setGraphViewMode, setGraphViewFocus, clearGraphViewFocus } = useStore();
  const s = () => snapshot();
  const [q, setQ] = createSignal("");
  const [ini, setIni] = createSignal("");
  const [statusFilter, setStatusFilter] = createSignal("");
  const [kindFilter, setKindFilter] = createSignal("");
  const [zoom, setZoom] = createSignal(1);
  const [overlay, setOverlay] = createSignal([]);
  // Tier (ADR-003 §Tiers) — "overview" | "compact" | "detail". Recomputed
  // on zoom/Fit/Reset/resize events, never on every render frame.
  const [tier, setTier] = createSignal(computeTier(null, 1));
  // Narrow viewport flag (ADR-003 §Overlay, teclado y fallback estrecho):
  // when the window is below NARROW_VIEWPORT_PX the canvas hides and the
  // Finder/NodeDetail fallback takes its place. Tracked locally because
  // the store does not own layout state.
  const [narrow, setNarrow] = createSignal(false);
  let cyHost;
  let cy = null;
  let palette = null;
  let lastPositionedKey = null;
  let lastVisibleIds = null;
  let dragState = null;
  let disposed = false;
  let fitRetries = 0;
  let fitTimer = null;
  // Initial render and an explicit mode change replace the positioned set,
  // so they must also reframe the camera. Polls and style-only updates do not.
  let fitOnNextTopology = true;
  // previousPositionsById feeds computeExecutionLayout so the layout
  // stays stable across re-runs that share the same visible set.
  const [previousPositionsById, setPreviousPositionsById] = createSignal(null);
  // Tracks whether the user has set focus manually since the last
  // selection change. Auto-upstream only fires on a selection change
  // when the user has not explicitly set a different focus.
  let userTouchedFocus = false;
  let lastAutoSeed = null;

  const allNodes = () => s()?.nodes || {};
  const allEdges = () => s()?.edges || [];

  const initiatives = createMemo(() => {
    const set = new Set();
    for (const n of Object.values(allNodes())) if (n.initiative) set.add(n.initiative);
    return [...set].sort();
  });

  // === Visible set (mode + filters + search) ==============================
  // Source of truth for the canvas. The new pipeline is:
  //   snapshot -> visibleSetForMode -> applyGraphFilters -> applyGraphSearch
  // The same memo feeds the layout, the cytoscape elements and the
  // overlay list, so there is no risk of the three views disagreeing.
  const visibleSet = createMemo(() => {
    const base = visibleSetForMode(allNodes(), allEdges(), graphView().mode);
    const filtered = applyGraphFilters(base, {
      initiative: ini(),
      kind: kindFilter(),
      status: statusFilter(),
    });
    const searched = applyGraphSearch(filtered, q());
    return searched;
  });

  const visibleNodeCount = createMemo(() => Object.keys(visibleSet().nodes).length);
  const hasNodes = () => visibleNodeCount() > 0;
  const visibleEdgeCount = createMemo(() => visibleSet().edges.length);

  // === Layout (preset positions + lane descriptors) ======================
  // computeExecutionLayout is called from the createMemo so any change
  // to the visible set or the previousPositionsById cache invalidates
  // the layout. The helper's own hashes form the topology signature
  // the renderer compares to decide whether to relayout cytoscape.
  const layoutResult = createMemo(() => {
    const set = visibleSet();
    const visibleIds = new Set(Object.keys(set.nodes));
    return computeExecutionLayout(set.nodes, set.edges, {
      previousPositionsById: previousPositionsById() || undefined,
      visibleIds,
    });
  });

  const positionedKeyMemo = createMemo(() => positionedKey(layoutResult()));
  const visibleSetKeyMemo = createMemo(() => visibleSetKey(visibleSet()));

  // === Cross-initiative edges =============================================
  // Computed once per visible set. Used both for class tagging and for
  // the bridge/label when a cross-initiative edge is selected or
  // focused.
  const crossInitiative = createMemo(() => {
    const set = new Set();
    for (const e of crossInitiativeEdges(visibleSet().nodes, visibleSet().edges)) {
      set.add(`${e.from}>${e.to}`);
    }
    return set;
  });

  // === Cytoscape element list ============================================
  // Memoised so the createEffect that reacts to topology changes only
  // re-runs cy work when something structural actually changed.
  const elements = createMemo(() => {
    const r = layoutResult();
    return buildElements(visibleSet(), r, crossInitiative(), allNodes(), tier());
  });

  // === Auto-upstream on selection of a blocked node =====================
  // Watches selectedId and graphView.mode; when the selection is a
  // blocked task/gate in Execution, replaces the focus with
  // { kind: "upstream", id }. The user can still override with the
  // focus buttons, which mark userTouchedFocus and prevent the next
  // re-render from clobbering the manual focus.
  createEffect(() => {
    const id = selectedId();
    const mode = graphView().mode;
    if (!id || mode !== "execution") {
      lastAutoSeed = null;
      return;
    }
    if (userTouchedFocus) return;
    if (lastAutoSeed === id) return;
    lastAutoSeed = id;
    if (isBlockedInSnapshot(allEdges(), allNodes(), id)) {
      setGraphViewFocus({ kind: "upstream", id });
    } else {
      clearGraphViewFocus();
    }
  });

  // When the user selects a different node, the focus on the previous
  // selection is replaced (per ADR-001 §Estado y ciclo de vida). The
  // next createEffect run will recompute auto-upstream for the new id.
  createEffect(() => {
    selectedId();
    userTouchedFocus = false;
  });

  function handleModeChange(next) {
    if (next !== graphView().mode) fitOnNextTopology = true;
    userTouchedFocus = false;
    lastAutoSeed = null;
    setGraphViewMode(next);
  }

  function handleFocusClick(kind) {
    const id = selectedId();
    if (!id) return;
    userTouchedFocus = true;
    if (graphView().focus && graphView().focus.kind === kind && graphView().focus.id === id) {
      clearGraphViewFocus();
    } else {
      setGraphViewFocus({ kind, id });
    }
  }

  function clearFilters() {
    setQ("");
    setIni("");
    setStatusFilter("");
    setKindFilter("");
  }

  const filtersActive = () => Boolean(q() || ini() || statusFilter() || kindFilter());

  // === Cytoscape lifecycle ===============================================

  function applyTopology() {
    if (!cy) return;
    const els = elements();
    const posKey = positionedKeyMemo();
    const visKey = visibleSetKeyMemo();
    // Always rebuild cytoscape elements when the visible set changes
    // (mode, filter, new edge, removed node). Only re-run the preset
    // layout when the BLOCKS skeleton — the layout's positionedSetHash
    // — actually changes. A 2s poll that mutates only title/status/claim
    // leaves both keys untouched: this path is skipped entirely.
    const visibleIds = new Set();
    for (const el of els) {
      if (el.group === "nodes" && !String(el.data.id).startsWith("__lane__")) {
        visibleIds.add(el.data.id);
      }
    }
    cy.elements().remove();
    cy.add(els);
    const shouldFit = fitOnNextTopology;
    const didRunPreset = posKey !== lastPositionedKey;
    if (didRunPreset) {
      lastPositionedKey = posKey;
      const positions = {};
      for (const [id, p] of Object.entries(layoutResult().positions)) {
        positions[id] = { x: p.x + POS_OFFSET_X, y: p.y + POS_OFFSET_Y };
      }
      const preset = cy.layout({ name: "preset", positions, fit: false, animate: false });
      // Preset applies positions asynchronously in browser Cytoscape. Fit only
      // after layoutstop; fitting before then sees every new node at (0, 0).
      if (shouldFit) {
        preset.one("layoutstop", () => {
          if (!disposed) fitWhenSized();
        });
      }
      preset.run();
      const prev = {};
      for (const [id, p] of Object.entries(layoutResult().positions)) prev[id] = p;
      setPreviousPositionsById(prev);
    }
    fitOnNextTopology = false;
    lastVisibleIds = visibleIds;
    applyStyleClasses();
    syncOverlay();
    // A mode may change non-positioned history edges while preserving the
    // BLOCKS skeleton. There is no preset event in that case, so fit directly.
    if (shouldFit && !didRunPreset) fitWhenSized();
  }

  function applyStyleClasses() {
    if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass("selected neighbor bright dimmed in-focus focused");
      const id = selectedId();
      const focus = graphView().focus;
      const focusSet = focusNodeSet(allEdges(), focus);
      if (focus && focus.kind === "initiative") {
        for (const x of initiativeFocusSet(visibleSet(), focus)) focusSet.add(x);
      }
      if (id) {
        const n = cy.getElementById(id);
        if (n && n.length > 0) {
          n.addClass("selected");
          const hood = n.neighborhood();
          hood.addClass("neighbor");
          hood.edges().addClass("bright");
          // Edges that are in the focus set also become bright.
          if (focusSet.size > 0) {
            for (const e of cy.edges()) {
              if (focusSet.has(e.data("source")) || focusSet.has(e.data("target"))) {
                e.addClass("bright");
              }
            }
          }
          if (focusSet.size > 0) {
            const focusEles = cy.collection();
            for (const fid of focusSet) {
              const fn = cy.getElementById(fid);
              if (fn && fn.length > 0) {
                fn.addClass("in-focus");
                focusEles.merge(fn);
              }
            }
            cy.elements()
              .not(n)
              .not(hood)
              .not(focusEles)
              .addClass("dimmed");
          } else {
            cy.elements().not(n).not(hood).addClass("dimmed");
          }
        }
      } else if (focusSet.size > 0) {
        const focusEles = cy.collection();
        for (const fid of focusSet) {
          const fn = cy.getElementById(fid);
          if (fn && fn.length > 0) {
            fn.addClass("in-focus");
            focusEles.merge(fn);
          }
        }
        cy.elements().not(focusEles).addClass("dimmed");
      }
    });
  }

  // Title/status updates from the 2s poll do not change topology, so
  // they don't re-run applyTopology. They DO need to update the
  // rendered labels (cytoscape reads data.label) so the next paint
  // shows the new title. We batch label updates per poll tick.
  function refreshLabels() {
    if (!cy) return;
    const currentTier = tier();
    cy.batch(() => {
      const set = visibleSet();
      for (const [id, n] of Object.entries(set.nodes)) {
        const ele = cy.getElementById(id);
        if (!ele || ele.length === 0) continue;
        const newLabel = formatLabel(id, n, currentTier);
        if (ele.data("label") !== newLabel) ele.data("label", newLabel);
        const status = n.status || "open";
        if (ele.data("status") !== status) ele.data("status", status);
      }
    });
  }

  function syncOverlay() {
    if (!cy) return;
    // At an overview zoom the canvas glyphs are the useful aggregate view.
    // Do not create hundreds of transparent DOM buttons; Finder remains the
    // canonical keyboard route for offscreen/overview nodes.
    if (tier() === "overview") {
      setOverlay([]);
      return;
    }
    const nodes = visibleSet().nodes;
    // Viewport in cytoscape container pixels plus the ADR-003 margin.
    // Nodes whose rendered bounding box does not intersect the
    // expanded viewport are skipped; they remain in cytoscape and
    // stay reachable via Finder, but no DOM button is rendered for
    // them (ADR-003 §Overlay, teclado y fallback estrecho).
    const container = cy.container();
    const cw = container ? container.clientWidth : 0;
    const ch = container ? container.clientHeight : 0;
    const viewportBox = {
      x1: -OVERLAY_MARGIN_PX,
      y1: -OVERLAY_MARGIN_PX,
      x2: cw + OVERLAY_MARGIN_PX,
      y2: ch + OVERLAY_MARGIN_PX,
    };
    const items = [];
    for (const n of cy.nodes()) {
      const id = n.id();
      if (typeof id === "string" && id.startsWith("__lane__")) continue;
      const node = nodes[id];
      if (!node) continue;
      const bb = n.renderedBoundingBox({ includeLabels: false });
      if (!boxesIntersect(bb, viewportBox)) continue;
      items.push({ id, node, x: bb.x1, y: bb.y1, w: bb.w, h: bb.h });
    }
    setOverlay(items);
  }

  function fitGraph() {
    if (!cy) return;
    // Fit to the real nodes only — lane backgrounds extend off-screen
    // and would otherwise zoom out the graph.
    const real = cy.nodes().filter((n) => !n.id().startsWith("__lane__"));
    if (real.length === 0) return;
    cy.fit(real, FIT_PADDING);
  }

  function fitWhenSized() {
    if (disposed || !cy) return;
    if (cyHost && cyHost.clientWidth > 0 && cyHost.clientHeight > 0) {
      cy.resize();
      fitGraph();
      syncOverlay();
      return;
    }
    if (fitRetries < 40) {
      fitRetries += 1;
      fitTimer = setTimeout(fitWhenSized, 50);
    }
  }

  function resetGraph() {
    if (!cy) return;
    cy.zoom(1);
    cy.pan({ x: 0, y: 0 });
  }

  function onCyZoom() {
    if (!cy) return;
    const z = cy.zoom();
    setZoom(z);
    // Tier recompute happens on zoom (per ADR-003 §Tiers: only zoom/Fit/
    // Reset/resize events, never per-frame). The setTier call is a no-op
    // when the tier stays the same; the canvas label effect re-runs when
    // it changes.
    const next = computeTier(tier(), z);
    if (next !== tier()) setTier(next);
  }

  function onCyPan() {
    // Pan changes the visible viewport but does not change the zoom
    // tier. The overlay list still needs a refresh so buttons move with
    // the graph.
    syncOverlay();
  }

  function onWindowResize() {
    if (cy) cy.resize();
    // Container size drives the overlay viewport box, so the cull must
    // refresh on resize even when the user has not interacted with cytoscape.
    syncOverlay();
    if (typeof window !== "undefined") {
      setNarrow(window.innerWidth < NARROW_VIEWPORT_PX);
    }
  }

  function onNarrowUpdate() {
    if (typeof window === "undefined") return;
    setNarrow(window.innerWidth < NARROW_VIEWPORT_PX);
  }

  function onNodeFocus(id) {
    if (cy) {
      cy.elements().removeClass("focused");
      const ele = cy.getElementById(id);
      if (ele && ele.length > 0) ele.addClass("focused");
    }
  }

  function onNodeBlur(id) {
    if (cy) {
      const ele = cy.getElementById(id);
      if (ele && ele.length > 0) ele.removeClass("focused");
    }
  }

  // Drag on an overlay button delegates to the cytoscape pan (same gesture as
  // dragging the canvas background); a click without drag selects the node.
  function onNodePointerDown(e, id) {
    if (!cy) return;
    dragState = {
      id,
      x: e.clientX,
      y: e.clientY,
      px: cy.pan().x,
      py: cy.pan().y,
      moved: false,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onNodePointerMove(e) {
    if (!dragState) return;
    const dx = e.clientX - dragState.x;
    const dy = e.clientY - dragState.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragState.moved = true;
    cy.pan({ x: dragState.px + dx, y: dragState.py + dy });
  }

  function onNodePointerUp(e, id) {
    if (!dragState || dragState.id !== id) return;
    const wasDrag = dragState.moved;
    dragState = null;
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {}
    if (!wasDrag) {
      e.currentTarget.focus?.();
      select(id);
    }
  }

  function onNodeKeyDown(e, id) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      select(id);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      const el = e.currentTarget;
      if (typeof el.blur === "function") el.blur();
      else if (document.activeElement === el) document.activeElement.blur?.();
      if (selectedId() === id) select(null);
    }
  }

  // Topology change → rebuild elements + (re)apply preset layout.
  // The effect re-runs on every visible-set or positioned-set change
  // so a new edge of any type (e.g. DERIVED_FROM, which the
  // positionedSetHash ignores) still becomes visible in the canvas.
  // The `lastPositionedKey` gate inside applyTopology then decides
  // whether to re-run the preset layout.
  createEffect(() => {
    // Read reactive keys before the Cytoscape guard. Effects run once before
    // onMount creates `cy`; reading them first subscribes this effect so mode,
    // filter and snapshot changes still rebuild the renderer afterwards.
    visibleSetKeyMemo();
    positionedKeyMemo();
    if (!cy) return;
    applyTopology();
  });

  // Style change → re-apply classes only, no relayout.
  createEffect(() => {
    // As above, subscribe before Cytoscape exists on the initial pass.
    selectedId();
    graphView().focus;
    if (!cy) return;
    applyStyleClasses();
  });

  // Title/status updates from polling → refresh labels in place. Tier
  // is also a dependency: when the zoom crosses a frontier, the
  // canvas label content must change without rebuilding the cytoscape
  // elements (ADR-003 §Tiers).
  createEffect(() => {
    // Keep polling labels and semantic-zoom overlays reactive after mount.
    allNodes();
    tier();
    if (!cy) return;
    refreshLabels();
    syncOverlay();
  });

  onMount(async () => {
    // Dynamic import keeps the ui-graph-core smoke test (which compiles
    // and imports Graph.jsx in plain Node) passing without modification.
    const cytoscape = (await import("cytoscape")).default;
    if (disposed) return;
    // readGraphPalette runs in the browser only (getComputedStyle);
    // graph-palette's import is DOM-free so the line below is safe
    // even if this module were ever imported in Node.
    if (typeof document !== "undefined") {
      try {
        palette = readGraphPalette();
      } catch {
        palette = null;
      }
    }
    cy = cytoscape({
      container: cyHost,
      headless: false,
      autoungrabify: true,
      minZoom: MIN_ZOOM,
      maxZoom: 2.5,
      wheelSensitivity: WHEEL_SENSITIVITY,
      style: buildStyle(palette),
    });
    cy.on("zoom", onCyZoom);
    cy.on("pan", onCyPan);
    cy.on("tap", (e) => {
      if (e.target === cy) select(null);
    });
    cy.on("tap", "node", (e) => {
      const id = e.target.id();
      if (typeof id === "string" && id.startsWith("__lane__")) return;
      select(id);
    });
    onNarrowUpdate();
    window.addEventListener("resize", onWindowResize);
    applyTopology();
  });

  onCleanup(() => {
    disposed = true;
    if (fitTimer) clearTimeout(fitTimer);
    window.removeEventListener("resize", onWindowResize);
    if (cy) {
      cy.removeListener("zoom", onCyZoom);
      cy.removeListener("pan", onCyPan);
      cy.destroy();
      cy = null;
    }
  });

  // === Mode segmented control: keyboard navigation =======================
  function onModeKeyDown(e) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const idx = GRAPH_VIEW_MODES.indexOf(graphView().mode);
    let next = idx;
    if (e.key === "ArrowLeft") next = (idx - 1 + GRAPH_VIEW_MODES.length) % GRAPH_VIEW_MODES.length;
    else if (e.key === "ArrowRight") next = (idx + 1) % GRAPH_VIEW_MODES.length;
    else if (e.key === "Home") next = 0;
    else next = GRAPH_VIEW_MODES.length - 1;
    handleModeChange(GRAPH_VIEW_MODES[next]);
  }

  // === Legend: small colour chip for each edge type =====================
  const controlCls =
    "min-h-[36px] rounded-control border border-line bg-panel-2 px-3 text-[13px] text-body outline-none " +
    "focus:border-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";

  // === Empty / cross-initiative helpers ==================================
  const executionEmpty = createMemo(() => isExecutionEmpty(allNodes(), allEdges()));

  // === Mode-mismatch (Finder → Graph selection) ==========================
  // When Finder selects a node that the current mode hides, surface an
  // offer to switch to the mode that includes it (ADR-003 §Overlay,
  // teclado y fallback estrecho: "si no pertenece, informa y ofrece
  // cambiar al modo correspondiente"). Pure derivation from the
  // snapshot + current mode; no cytoscape work involved.
  const modeMismatch = createMemo(() => {
    const id = selectedId();
    if (!id) return null;
    const set = visibleSet();
    if (set.nodes && set.nodes[id]) return null;
    return modeForNode(allNodes(), allEdges(), id);
  });

  // === Camera-fit on Finder selection ====================================
  // ADR-003 §Overlay: when the user picks a result from Finder, Graph
  // centers the selected node without changing zoom. The effect waits
  // for cytoscape to settle (queueMicrotask) so the rendered bounding
  // box reflects the latest layout. We only center when the node is
  // materially off-screen; in-viewport selections stay where the user
  // left them.
  createEffect(() => {
    const id = selectedId();
    if (!id || disposed) return;
    queueMicrotask(() => {
      if (!cy || disposed) return;
      const set = visibleSet();
      if (!set.nodes || !set.nodes[id]) return;
      const ele = cy.getElementById(id);
      if (!ele || ele.length === 0) return;
      const bb = ele.renderedBoundingBox({ includeLabels: false });
      const container = cy.container();
      const cw = container ? container.clientWidth : 0;
      const ch = container ? container.clientHeight : 0;
      const offLeft = bb.x1 < 0;
      const offRight = bb.x2 > cw;
      const offTop = bb.y1 < 0;
      const offBottom = bb.y2 > ch;
      if (!offLeft && !offRight && !offTop && !offBottom) return;
      cy.animate({ center: { eles: ele }, duration: 220 });
    });
  });

  return (
    <PageLayout mode="workspace">
      <div class="ui-workspace-header">
        <PageHeader
          eyebrow="Monitor"
          title="Graph"
          subtitle="Trace blockers, derivations and superseding relationships across registered work."
          meta={`${visibleNodeCount()} node(s) · ${visibleEdgeCount()} edge(s)`}
        />
        <div class="pt-4">
          <div class="ui-filter-bar flex min-h-[36px] flex-wrap items-center gap-2 rounded-control border border-line bg-panel px-3 py-2">
            <span class="mono text-[12px] uppercase tracking-wider text-mute">View</span>
            <div role="group" aria-label="Graph view mode" class="inline-flex items-center gap-1 rounded-control border border-line bg-panel-2 p-0.5" onKeyDown={onModeKeyDown}>
              <For each={GRAPH_VIEW_MODES}>
                {(m) => {
                  const active = () => graphView().mode === m;
                  return (
                    <button
                      type="button"
                      class={MODE_BTN_CLS}
                      classList={{ [MODE_BTN_ACTIVE_CLS]: active() }}
                      aria-pressed={active()}
                      aria-label={`${MODE_LABEL[m]} view`}
                      onClick={() => handleModeChange(m)}
                    >
                      {MODE_LABEL[m]}
                    </button>
                  );
                }}
              </For>
            </div>
            <input
              type="search"
              class="min-h-[36px] min-w-[200px] flex-1 rounded-control border border-line bg-panel-2 px-3 text-[13px] text-ink outline-none placeholder:text-mute focus:border-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
              placeholder="Search id / title…"
              value={q()}
              onInput={(e) => setQ(e.currentTarget.value)}
              aria-label="Search graph nodes"
            />
            <select
              class={controlCls}
              value={ini()}
              onChange={(e) => setIni(e.currentTarget.value)}
              aria-label="Filter by initiative"
            >
              <option value="">All initiatives</option>
              <For each={initiatives()}>{(i) => <option value={i}>{i}</option>}</For>
            </select>
            <select
              class={controlCls}
              value={statusFilter()}
              onChange={(e) => setStatusFilter(e.currentTarget.value)}
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              <For each={uniqueStatusesIn(allNodes())}>{(st) => <option value={st}>{st}</option>}</For>
            </select>
            <select
              class={controlCls}
              value={kindFilter()}
              onChange={(e) => setKindFilter(e.currentTarget.value)}
              aria-label="Filter by kind"
            >
              <option value="">All kinds</option>
              <For each={uniqueKindsIn(allNodes())}>
                {(k) => <option value={k}>{k === "knowledge" ? "Knowledge" : k === "gate" ? "Gates" : "Tasks"}</option>}
              </For>
            </select>
            <Show when={filtersActive()}>
              <button
                type="button"
                class="ml-auto inline-flex min-h-[36px] items-center rounded-control border border-line bg-panel-2 px-3 text-[12px] text-body hover:bg-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            </Show>
            <Show when={selectedId()}>
              <div role="group" aria-label="Focus" class="ml-auto inline-flex items-center gap-1 rounded-control border border-line bg-panel-2 p-0.5">
                <For each={[
                  { kind: "upstream", label: "Upstream" },
                  { kind: "downstream", label: "Downstream" },
                  { kind: "initiative", label: "Initiative" },
                ]}>
                  {(opt) => {
                    const active = () => {
                      const f = graphView().focus;
                      return Boolean(f) && f.kind === opt.kind && f.id === selectedId();
                    };
                    return (
                      <button
                        type="button"
                        class={MODE_BTN_CLS}
                        classList={{ [MODE_BTN_ACTIVE_CLS]: active() }}
                        aria-pressed={active()}
                        aria-label={`Focus ${opt.label.toLowerCase()}`}
                        onClick={() => handleFocusClick(opt.kind)}
                      >
                        {opt.label}
                      </button>
                    );
                  }}
                </For>
              </div>
            </Show>
            <div class="ml-auto flex items-center gap-2 text-[12px] text-mute">
              <button type="button" class={BTN_CLS} onClick={fitGraph}>Fit</button>
              <button type="button" class={BTN_CLS} onClick={resetGraph}>Reset</button>
              <span class="mono w-12 text-right tabular-nums">{Math.round(zoom() * 100)}%</span>
            </div>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-[12px] text-mute">
          <span><span class="text-blocked">→</span> BLOCKS</span>
          <span><span class="text-knowledge">→</span> SUPERSEDES</span>
          <span><span class="text-progress">→</span> DERIVED_FROM</span>
          <span class="ml-auto">drag to pan · wheel to zoom · tab to focus nodes</span>
        </div>
      </div>

      <div class="ui-workspace-body ui-graph-canvas relative flex-1 overflow-hidden [background-size:24px_24px]">
        <Show when={!narrow()} fallback={<NarrowFallback />}>
          <div class="absolute inset-0">
            {/* Cytoscape mutates its container to position: relative. Keep that
                mutable host separate from the absolute overlay frame; otherwise
                its height collapses to zero and the canvas renders blank. */}
            <div ref={cyHost} style={{ width: "100%", height: "100%", touchAction: "none" }} />
            <Index each={overlay()}>
              {(item) => (
                <button
                  type="button"
                  class={OVERLAY_BTN_CLS}
                  tabindex="0"
                  aria-label={`${item().id}: ${item().node.title || ""} (${kindFor(item().node)}, ${item().node.status || "open"})`}
                  title={item().node.title || ""}
                  style={{
                    left: `${item().x}px`,
                    top: `${item().y}px`,
                    width: `${item().w}px`,
                    height: `${item().h}px`,
                  }}
                  onPointerDown={(e) => onNodePointerDown(e, item().id)}
                  onPointerMove={onNodePointerMove}
                  onPointerUp={(e) => onNodePointerUp(e, item().id)}
                  onPointerCancel={() => { dragState = null; }}
                  onKeyDown={(e) => onNodeKeyDown(e, item().id)}
                  onFocus={() => onNodeFocus(item().id)}
                  onBlur={() => onNodeBlur(item().id)}
                />
              )}
            </Index>
          </div>
          <Show when={modeMismatch()}>
            <div class="absolute inset-x-0 top-3 z-10 px-4">
              <AlertBanner tone="info" title="Node no visible en este modo">
                <span>
                  El nodo seleccionado pertenece al modo{" "}
                  <strong>{MODE_LABEL[modeMismatch()]}</strong>. Cambiá de modo para inspeccionarlo en el grafo, o usá NodeDetail.
                </span>{" "}
                <button
                  type="button"
                  class={MODE_BTN_CLS}
                  aria-label={`Switch to ${MODE_LABEL[modeMismatch()]} view`}
                  onClick={() => handleModeChange(modeMismatch())}
                >
                  Switch to {MODE_LABEL[modeMismatch()]}
                </button>
              </AlertBanner>
            </div>
          </Show>
          <Show when={hasNodes() && visibleEdgeCount() === 0 && Object.keys(allNodes()).length > 0}>
            <div class="absolute inset-x-0 top-3 z-10 px-4">
              <AlertBanner tone="info" title="Sin relaciones visibles">
                Hay nodos en el grafo pero ninguna dependencia visible entre ellos.
              </AlertBanner>
            </div>
          </Show>
          <Show when={!hasNodes() && graphView().mode === "execution" && executionEmpty()}>
            <div class="absolute inset-0 z-10 overflow-auto p-8">
              <Empty>No active operational work. Switch to History to inspect superseded decisions and derivations.</Empty>
              <div class="mt-3 flex justify-center">
                <button
                  type="button"
                  class={BTN_CLS}
                  onClick={() => handleModeChange("history")}
                >
                  Switch to History
                </button>
              </div>
            </div>
          </Show>
          <Show when={!hasNodes() && !(graphView().mode === "execution" && executionEmpty())}>
            <div class="absolute inset-0 z-10 overflow-auto p-8">
              <Empty>No nodes match the current filters.</Empty>
            </div>
          </Show>
        </Show>
      </div>
    </PageLayout>
  );
}

// === Narrow viewport fallback =========================================
//
// ADR-003 §Overlay, teclado y fallback estrecho: en pantalla estrecha
// no se miniaturiza el canvas; en su lugar, se ofrece Finder +
// NodeDetail como ruta accesible. Finder vive en App.jsx (global, / o
// Ctrl/Cmd+K) y NodeDetail lo monta App.jsx también; aquí sólo dejamos
// un panel que explique al usuario cómo usarlos desde este modo.
function NarrowFallback() {
  return (
    <div class="absolute inset-0 z-10 overflow-auto p-8">
      <Empty>Vista de grafo no disponible en pantalla estrecha.</Empty>
      <p class="mt-3 text-center text-[13px] text-body">
        Usá el buscador global (<kbd class="rounded border border-line bg-panel-2 px-1 text-[12px]">/</kbd> o{" "}
        <kbd class="rounded border border-line bg-panel-2 px-1 text-[12px]">Ctrl/Cmd+K</kbd>) para abrir Finder y seleccionar
        un nodo; su detalle aparece en NodeDetail.
      </p>
    </div>
  );
}

// === Local helpers ========================================================
//
// These are tiny inlined re-implementations of the unique-status and
// unique-kind selectors. The model module is DOM-free and lives in
// graph-view-model.mjs; the renderer owns the dropdowns and we keep
// them here to avoid re-importing the model just for two trivial
// derivations. The behaviour matches graph-helpers.mjs:uniqueStatuses
// / uniqueKinds so the dropdowns read identically.
function uniqueStatusesIn(nodes) {
  const set = new Set();
  for (const n of Object.values(nodes || {})) set.add(n.status || "open");
  return [...set].sort();
}

function uniqueKindsIn(nodes) {
  const set = new Set();
  for (const n of Object.values(nodes || {})) set.add(kindFor(n));
  return [...set].sort();
}
