import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, For, Index } from "solid-js";
import { useStore } from "../store.jsx";
import { Empty, AlertBanner, FilterBar, PageHeader, PageLayout } from "../components.jsx";
import {
  kindFor,
  abbreviate,
  shouldShowIsolationCallout,
  filterGraph,
  uniqueStatuses,
  uniqueKinds,
  toCytoscapeElements,
} from "./graph-helpers.mjs";

// Cytoscape renderer for the DAG graph (T-ui-graph-cyto).
//
// The old renderer drew native SVG shapes; Cytoscape paints on <canvas>, so
// there are no DOM nodes to focus. Accessibility (the T-ui-a11y contract:
// every node is a focusable role="button" with aria-label + title, keyboard
// activation, visible focus) is preserved with a DOM overlay of real <button>
// elements positioned over each rendered node via renderedBoundingBox() and
// kept in sync on cy pan/zoom/render/resize.
//
// cytoscape + cytoscape-dagre are loaded with a dynamic import inside onMount
// (not at module top level) so the existing ui-graph-core smoke test, which
// compiles and imports Graph.jsx in plain Node, keeps passing untouched: the
// modules are only resolved when the component actually mounts in the browser.

// Colors and status palette are mapped 1:1 from the previous SVG renderer
// (Fase 5C). Cytoscape paints on canvas, so var(--ui-*) CSS variables cannot
// be used inside the stylesheet; the concrete hex values below mirror the
// design tokens from ui/src/index.css.
const EDGE_COLORS = {
  BLOCKS: "#be123c",
  SUPERSEDES: "#7157d9",
  DERIVED_FROM: "#1769e0",
  INFORMS: "#9aa1ad",
  RELATES_TO: "#9aa1ad",
  CONFLICTS_WITH: "#9aa1ad",
};

const STATUS_COLORS = {
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
};
const STATUS_DEFAULT = { stroke: "#d9dde5", text: "#3f4652" };

const NODE_W = 192;
const NODE_H = 56;
const KNOWLEDGE_D = 56; // circle diameter, matches the old r=28 knowledge node
const FIT_PADDING = 40;
// Wheel sensitivity calibrated so a typical mouse notch (~deltaY 100) zooms
// by ~1.12x, the same factor the old SVG wheel handler used (2^(100/250*0.4)).
const WHEEL_SENSITIVITY = 0.4;

// Cytoscape stylesheet. Class rules are ordered so dimming/focus overrides
// the per-status and per-kind base styles (cytoscape resolves ties by order).
const CY_STYLE = [
  {
    selector: "node",
    style: {
      width: NODE_W,
      height: NODE_H,
      shape: "round-rectangle",
      "corner-radius": 8,
      "background-color": "#fafbfc", // --ui-panel-muted
      "border-width": 1.2,
      "border-color": STATUS_DEFAULT.stroke,
      color: "#3f4652", // --ui-body (single canvas label keeps the title readable)
      "font-family": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      "font-size": 10,
      "text-wrap": "wrap",
      "text-max-width": 190,
      "text-valign": "center",
      "text-halign": "center",
      label: "data(label)",
    },
  },
  { selector: "node.gate", style: { shape: "diamond", "background-color": "#fff7e8" } }, // --ui-amber-soft
  { selector: "node.knowledge", style: { shape: "ellipse", width: KNOWLEDGE_D, height: KNOWLEDGE_D, "background-color": "#f2efff" } }, // --ui-violet-soft
  ...Object.keys(STATUS_COLORS).map((status) => ({
    selector: `node[status = "${status}"]`,
    style: { "border-color": STATUS_COLORS[status].stroke },
  })),
  { selector: "node.faded", style: { opacity: 0.55 } },
  { selector: "node.selected", style: { "border-width": 2, "border-color": "#1769e0" } },
  { selector: "node.focused", style: { "border-style": "dashed" } },
  { selector: "node.dimmed", style: { opacity: 0.25 } },
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
  { selector: "edge.BLOCKS", style: { "line-color": EDGE_COLORS.BLOCKS, "target-arrow-color": EDGE_COLORS.BLOCKS, "line-style": "solid", opacity: 0.9 } },
  { selector: "edge.SUPERSEDES", style: { "line-color": EDGE_COLORS.SUPERSEDES, "target-arrow-color": EDGE_COLORS.SUPERSEDES } },
  { selector: "edge.DERIVED_FROM", style: { "line-color": EDGE_COLORS.DERIVED_FROM, "target-arrow-color": EDGE_COLORS.DERIVED_FROM } },
  { selector: "edge.bright", style: { opacity: 0.9 } },
  { selector: "edge.dimmed", style: { opacity: 0.12 } },
];

const BTN_CLS =
  "ui-control inline-flex min-h-[36px] items-center rounded-control border border-line bg-panel px-3 text-[12px] font-medium text-body " +
  "hover:border-line-strong hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";

// Overlay button: a real <button> (keyboard reachable, accessible name) that
// covers the rendered node box. pointer-events stay enabled so a click without
// drag selects the node; a drag that starts on the button is delegated to the
// cytoscape pan (Graph keeps pan/zoom fully operable over nodes).
const OVERLAY_BTN_CLS =
  "graph-node-overlay absolute z-[5] cursor-pointer touch-none rounded-[8px] border-0 bg-transparent p-0 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";

function nodeLabelText(data) {
  const [id, title, meta] = data.label;
  const ini = data.initiative ? ` · ${data.initiative}` : "";
  return `${id}\n${title}\n${meta}${ini}`;
}

// Stable signature of the cytoscape elements so the 2s snapshot polling does
// not churn the layout when nothing about the visible graph actually changed.
function graphSignature(elements) {
  const nodes = [];
  const edges = [];
  for (const el of elements) {
    if (el.data && el.data.source === undefined) {
      const d = el.data;
      nodes.push(`${d.id}|${d.status}|${d.initiative}|${d.label.join("\u0001")}`);
    } else if (el.data) {
      edges.push(`${el.data.source}>${el.data.target}|${el.data.type}`);
    }
  }
  nodes.sort();
  edges.sort();
  return `${nodes.join(";")}::${edges.join(";")}`;
}

export default function Graph() {
  const { snapshot, select, selectedId } = useStore();
  const s = () => snapshot();
  const [q, setQ] = createSignal("");
  const [ini, setIni] = createSignal("");
  const [statusFilter, setStatusFilter] = createSignal("");
  const [kindFilter, setKindFilter] = createSignal("");
  const [showHistory, setShowHistory] = createSignal(false);
  const [zoom, setZoom] = createSignal(1);
  const [overlay, setOverlay] = createSignal([]);
  let cyHost;
  let cy = null;
  let lastSig = null;
  let dragState = null;
  let disposed = false;
  let fitRetries = 0;
  let fitTimer = null;

  const initiatives = createMemo(() => {
    const set = new Set();
    for (const n of Object.values(s()?.nodes || {})) if (n.initiative) set.add(n.initiative);
    return [...set].sort();
  });
  const statuses = createMemo(() => uniqueStatuses(s()?.nodes || {}));
  const kinds = createMemo(() => uniqueKinds(s()?.nodes || {}));

  const filtersActive = () => Boolean(q() || ini() || statusFilter() || kindFilter());

  function clearFilters() {
    setQ("");
    setIni("");
    setStatusFilter("");
    setKindFilter("");
  }

  const visible = createMemo(() => {
    const { nodes: vn, edges: ve } = filterGraph(s()?.nodes || {}, s()?.edges || [], {
      ini: ini(),
      search: q(),
      status: statusFilter(),
      kind: kindFilter(),
      showHistory: showHistory(),
    });
    return { nodes: vn, edges: ve };
  });

  const hasNodes = () => Object.keys(visible().nodes).length > 0;

  const showIsolation = () =>
    shouldShowIsolationCallout(
      s()?.nodes || {},
      Object.keys(visible().nodes).length,
      visible().edges.length,
    );

  const graphElements = createMemo(() => toCytoscapeElements(visible().nodes, visible().edges));

  // --- Cytoscape lifecycle -------------------------------------------------

  function applyElements() {
    const { elements } = graphElements();
    cy.elements().remove();
    cy.add(
      elements.map((el) =>
        el.data.source === undefined
          ? { ...el, data: { ...el.data, label: nodeLabelText(el.data) } }
          : el,
      ),
    );
    // Flat dagre LR layout: blocker -> blocked flows left to right. The
    // initiative is rendered as a label chip on each node instead of compound
    // initiative bands (cytoscape-dagre v4 does not support compound nodes).
    cy.layout({ name: "dagre", rankDir: "LR", fit: false }).run();
    applyFocusClasses();
    syncOverlay();
  }

  function applyFocusClasses() {
    if (!cy) return;
    cy.elements().removeClass("selected neighbor bright dimmed");
    const id = selectedId();
    if (!id) return;
    const n = cy.getElementById(id);
    if (!n || n.length === 0) return;
    n.addClass("selected");
    const hood = n.neighborhood();
    hood.addClass("neighbor");
    hood.edges().addClass("bright");
    cy.elements().not(n).not(hood).addClass("dimmed");
  }

  function syncOverlay() {
    if (!cy) return;
    const nodes = visible().nodes;
    const items = [];
    for (const n of cy.nodes()) {
      const id = n.id();
      const node = nodes[id];
      if (!node) continue;
      const bb = n.renderedBoundingBox({ includeLabels: false });
      items.push({ id, node, x: bb.x1, y: bb.y1, w: bb.w, h: bb.h });
    }
    setOverlay(items);
  }

  function fitGraph() {
    if (!cy) return;
    cy.fit(cy.elements(), FIT_PADDING);
  }

  // Auto-fit once the container has known dimensions (same first-measure
  // intent as the old didFit). If the container is still zero-sized when the
  // first layout stops, retry briefly until layout/paint settles.
  function fitWhenSized() {
    if (disposed || !cy) return;
    if (cyHost && cyHost.clientWidth > 0 && cyHost.clientHeight > 0) {
      cy.fit(cy.elements(), FIT_PADDING);
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
    setZoom(cy.zoom());
  }

  function onWindowResize() {
    if (cy) cy.resize();
  }

  function onNodeFocus(id) {
    if (cy) {
      cy.elements().removeClass("focused");
      cy.getElementById(id).addClass("focused");
    }
  }

  function onNodeBlur(id) {
    if (cy) cy.getElementById(id).removeClass("focused");
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
      // Stop propagation so NodeDetail's window-level Escape handler
      // doesn't double-handle the same keypress.
      e.stopPropagation();
      const el = e.currentTarget;
      if (typeof el.blur === "function") el.blur();
      else if (document.activeElement === el) document.activeElement.blur?.();
      if (selectedId() === id) select(null);
    }
  }

  // Rebuild cytoscape elements when the visible graph content changes
  // (filters, snapshot updates). Skipped when the signature is unchanged so
  // the 2s polling does not re-run the layout over an identical graph.
  createEffect(() => {
    if (!cy) return;
    const sig = graphSignature(graphElements().elements);
    if (sig === lastSig) return;
    lastSig = sig;
    applyElements();
  });

  // Re-apply the focus-of-neighbors classes when the selection changes.
  createEffect(() => {
    selectedId();
    applyFocusClasses();
  });

  onMount(async () => {
    // Dynamic import keeps the ui-graph-core smoke test (which compiles and
    // imports Graph.jsx in plain Node) passing without modification.
    const cytoscape = (await import("cytoscape")).default;
    const dagre = (await import("cytoscape-dagre")).default;
    cytoscape.use(dagre);
    if (disposed) return;
    cy = cytoscape({
      container: cyHost,
      headless: false,
      autoungrabify: true, // read-only: dragging over a node pans, never moves it
      minZoom: 0.25,
      maxZoom: 2.5,
      wheelSensitivity: WHEEL_SENSITIVITY,
      style: CY_STYLE,
    });
    cy.on("render", syncOverlay);
    cy.on("zoom", onCyZoom);
    cy.on("tap", (e) => {
      // Tap on the background deselects. Cytoscape only fires "tap" when the
      // pointer did not drag, so this doubles as the moved guard.
      if (e.target === cy) select(null);
    });
    cy.on("tap", "node", (e) => select(e.target.id()));
    window.addEventListener("resize", onWindowResize);
    // One automatic fit after the first layout; afterwards the user drives
    // zoom/pan via Fit/Reset (same behavior as the old didFit).
    cy.one("layoutstop", () => {
      if (disposed) return;
      fitWhenSized();
    });
    lastSig = graphSignature(graphElements().elements);
    applyElements();
  });

  onCleanup(() => {
    disposed = true;
    if (fitTimer) clearTimeout(fitTimer);
    window.removeEventListener("resize", onWindowResize);
    if (cy) {
      cy.removeListener("render", syncOverlay);
      cy.removeListener("zoom", onCyZoom);
      cy.destroy();
      cy = null;
    }
  });

  const controlCls =
    "min-h-[36px] rounded-control border border-line bg-panel-2 px-3 text-[13px] text-body outline-none " +
    "focus:border-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";

  return (
    <PageLayout mode="workspace">
      <div class="ui-workspace-header">
        <PageHeader
          eyebrow="Monitor"
          title="Graph"
          subtitle="Trace blockers, derivations and superseding relationships across registered work."
          meta={`${Object.keys(visible().nodes).length} nodes`}
        />
        <div class="pt-4">
        <FilterBar
          label="Graph"
          hint={filtersActive() ? `${Object.keys(visible().nodes).length} node(s)` : undefined}
          onClear={filtersActive() ? clearFilters : undefined}
        >
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
            <For each={statuses()}>{(st) => <option value={st}>{st}</option>}</For>
          </select>
          <select
            class={controlCls}
            value={kindFilter()}
            onChange={(e) => setKindFilter(e.currentTarget.value)}
            aria-label="Filter by kind"
          >
            <option value="">All kinds</option>
            <For each={kinds()}>
              {(k) => <option value={k}>{k === "knowledge" ? "Knowledge" : k === "gate" ? "Gates" : "Tasks"}</option>}
            </For>
          </select>
          <label class="flex items-center gap-1.5 text-[12px] text-body">
            <input type="checkbox" checked={showHistory()} onChange={(e) => setShowHistory(e.currentTarget.checked)} />
            Show history
          </label>
          <div class="ml-auto flex items-center gap-2 text-[12px] text-mute">
            <button type="button" class={BTN_CLS} onClick={fitGraph}>Fit</button>
            <button type="button" class={BTN_CLS} onClick={resetGraph}>Reset</button>
            <span class="mono w-12 text-right tabular-nums">{Math.round(zoom() * 100)}%</span>
          </div>
        </FilterBar>
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-[12px] text-mute">
          <span><span class="text-blocked">→</span> BLOCKS</span>
          <span><span class="text-knowledge">→</span> SUPERSEDES</span>
          <span><span class="text-progress">→</span> DERIVED_FROM</span>
          <span class="ml-auto">drag to pan · wheel to zoom · tab to focus nodes</span>
        </div>
      </div>

      <div class="ui-workspace-body ui-graph-canvas relative flex-1 overflow-hidden [background-size:24px_24px]">
        <div ref={cyHost} class="absolute inset-0" style={{ touchAction: "none" }}>
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
        <Show when={hasNodes() && showIsolation()}>
          <div class="absolute inset-x-0 top-3 z-10 px-4">
            <AlertBanner tone="info" title="Sin relaciones visibles">
              Hay nodos en el grafo pero ninguna dependencia visible entre ellos.
            </AlertBanner>
          </div>
        </Show>
        <Show when={!hasNodes()}>
          <div class="absolute inset-0 z-10 overflow-auto p-8">
            <Empty>No nodes match the current filters.</Empty>
          </div>
        </Show>
      </div>
    </PageLayout>
  );
}
