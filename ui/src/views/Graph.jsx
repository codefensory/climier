import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, For } from "solid-js";
import { useStore } from "../store.jsx";
import { Empty, AlertBanner, FilterBar } from "../components.jsx";
import {
  kindFor,
  computeLayout,
  fitTransform,
  abbreviate,
  buildEdgePath,
  shouldShowIsolationCallout,
  filterGraph,
  neighborIds,
  edgeTouches,
  uniqueStatuses,
  uniqueKinds,
} from "./graph-helpers.mjs";

const EDGE_COLORS = {
  BLOCKS: "#e11d48",
  SUPERSEDES: "#9333ea",
  DERIVED_FROM: "#0284c7",
  INFORMS: "#94a3b8",
  RELATES_TO: "#94a3b8",
  CONFLICTS_WITH: "#94a3b8",
};

const STATUS_COLORS = {
  open:        { stroke: "#38bdf8", text: "#0369a1" },
  in_progress: { stroke: "#fbbf24", text: "#92400e" },
  done:        { stroke: "#34d399", text: "#065f46" },
  canceled:    { stroke: "#cbd5e1", text: "#64748b" },
  blocked:     { stroke: "#f87171", text: "#b91c1c" },
  resolved:    { stroke: "#a78bfa", text: "#6d28d9" },
  superseded:  { stroke: "#c084fc", text: "#7e22ce" },
  deprecated:  { stroke: "#cbd5e1", text: "#64748b" },
  active:      { stroke: "#34d399", text: "#065f46" },
  stale:       { stroke: "#fb923c", text: "#c2410c" },
};
const STATUS_DEFAULT = { stroke: "#d4d4d8", text: "#3f3f46" };

const BTN_CLS =
  "rounded-control border border-line bg-panel px-2.5 py-1 text-[11px] font-medium text-slate-700 " +
  "hover:border-sky-600/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";

const SEL_COLORS = { stroke: "#0284c7", halo: "rgba(2,132,199,0.55)", ring: "#0284c7" };
const NEI_COLORS = { stroke: null, halo: "rgba(2,132,199,0.3)", ring: null };

// Node label inside the SVG: ID + abbreviated title + kind/status as text,
// so the direction and state are readable without relying on color alone.
//
// Fase 5C pieza 2 keyboard + focus support: every shape is a focusable
// role="button" (tabIndex=0). Enter/Space activates the same action as a
// click; Escape blurs the node (and deselects it when it was the selected
// node — see Graph.onNodeKeyDown). Focused nodes render a dashed ring, the
// selected node and its direct neighbors render a soft halo behind the
// shape so the focus-of-neighbors state is readable without color alone.
function NodeShape(props) {
  const n = () => props.n;
  const pos = () => props.pos;
  const selected = () => props.selected;
  const focused = () => props.focused;
  const neighbor = () => props.neighbor;
  const meta = () => STATUS_COLORS[n().status] || STATUS_DEFAULT;
  const stroke = () => (selected() ? SEL_COLORS.stroke : meta().stroke);
  const sw = () => (selected() ? 2 : 1.2);
  const label = (
    <g class="pointer-events-none">
      <text x={pos().x} y={pos().y - 17} text-anchor="middle" font-size="10" fill={meta().text} class="mono">{n().id}</text>
      <text x={pos().x} y={pos().y + 1} text-anchor="middle" font-size="11" fill="#27272a">{abbreviate(n().title, 32)}</text>
      <text x={pos().x} y={pos().y + 19} text-anchor="middle" font-size="9" fill="#71717a" class="mono">{kindFor(n())} · {n().status || "open"}</text>
    </g>
  );
  const haloColor = () => (selected() ? SEL_COLORS.halo : NEI_COLORS.halo);
  const halo = () => selected() || neighbor();
  const ring = () => focused() && !selected();
  const click = () => props.onSelect(n().id);
  const keydown = (e) => props.onKeyDown?.(e, n().id);
  const shapeProps = {
    role: "button",
    tabindex: 0,
    "aria-label": `${n().id}: ${n().title || ""} (${kindFor(n())}, ${n().status || "open"})`,
    onClick: click,
    onKeyDown: keydown,
    onFocus: props.onFocus,
    onBlur: props.onBlur,
  };
  if (kindFor(n()) === "knowledge") {
    return (
      <g>
        {halo() && <circle cx={pos().x} cy={pos().y} r={33} fill="none" stroke={haloColor()} stroke-width="3" class="pointer-events-none" />}
        {ring() && <circle cx={pos().x} cy={pos().y} r={32} fill="none" stroke={SEL_COLORS.ring} stroke-width="1.5" stroke-dasharray="4 3" class="pointer-events-none" />}
        <circle cx={pos().x} cy={pos().y} r={28} stroke={stroke()} stroke-width={sw()} fill="#f5f3ff" class="cursor-pointer" {...shapeProps} />
        {label}
      </g>
    );
  }
  if (kindFor(n()) === "gate") {
    const pts = `${pos().x},${pos().y - 28} ${pos().x + 96},${pos().y} ${pos().x},${pos().y + 28} ${pos().x - 96},${pos().y}`;
    const haloPts = `${pos().x},${pos().y - 34} ${pos().x + 102},${pos().y} ${pos().x},${pos().y + 34} ${pos().x - 102},${pos().y}`;
    const ringPts = `${pos().x},${pos().y - 32} ${pos().x + 100},${pos().y} ${pos().x},${pos().y + 32} ${pos().x - 100},${pos().y}`;
    return (
      <g>
        {halo() && <polygon points={haloPts} fill="none" stroke={haloColor()} stroke-width="3" class="pointer-events-none" />}
        {ring() && <polygon points={ringPts} fill="none" stroke={SEL_COLORS.ring} stroke-width="1.5" stroke-dasharray="4 3" class="pointer-events-none" />}
        <polygon points={pts} stroke={stroke()} stroke-width={sw()} fill="#fff4e6" class="cursor-pointer" {...shapeProps} />
        {label}
      </g>
    );
  }
  return (
    <g>
      {halo() && <rect x={pos().x - 102} y={pos().y - 34} width={204} height={68} rx={10} fill="none" stroke={haloColor()} stroke-width="3" class="pointer-events-none" />}
      {ring() && <rect x={pos().x - 101} y={pos().y - 33} width={202} height={66} rx={9} fill="none" stroke={SEL_COLORS.ring} stroke-width="1.5" stroke-dasharray="4 3" class="pointer-events-none" />}
      <rect x={pos().x - 96} y={pos().y - 28} width={192} height={56} rx={8} stroke={stroke()} stroke-width={sw()} fill="#f7f7f8" class="cursor-pointer" {...shapeProps} />
      {label}
    </g>
  );
}

export default function Graph() {
  const { snapshot, select, selectedId } = useStore();
  const s = () => snapshot();
  const [q, setQ] = createSignal("");
  const [ini, setIni] = createSignal("");
  const [statusFilter, setStatusFilter] = createSignal("");
  const [kindFilter, setKindFilter] = createSignal("");
  const [showHistory, setShowHistory] = createSignal(false);
  const [zoom, setZoom] = createSignal(0.9);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  const [drag, setDrag] = createSignal(null);
  const [viewport, setViewport] = createSignal({ w: 0, h: 0 });
  const [didFit, setDidFit] = createSignal(false);
  const [focusedId, setFocusedId] = createSignal(null);
  let moved = false;
  let host;

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
    return { nodes: vn, edges: ve, layout: computeLayout(vn, ve) };
  });

  const showIsolation = () =>
    shouldShowIsolationCallout(
      s()?.nodes || {},
      Object.keys(visible().nodes).length,
      visible().edges.length,
    );

  // Focus-of-neighbors: when a node is selected, the highlight set is the
  // selected node plus its direct neighbors in the visible graph. Every
  // other visible node and every unrelated edge is dimmed.
  const focusIds = createMemo(() => {
    const id = selectedId();
    if (!id) return null;
    const set = neighborIds(visible().edges, id);
    set.add(id);
    return set;
  });

  function nodeOpacity(n) {
    const faded = ["done", "resolved", "superseded", "deprecated"].includes(n.status) ? 0.55 : 1;
    if (!focusIds()) return faded;
    return focusIds().has(n.id) ? 1 : 0.25;
  }

  function edgeOpacity(e) {
    if (!focusIds()) return e.type === "BLOCKS" ? 0.9 : 0.65;
    return edgeTouches(e, focusIds()) ? 0.9 : 0.12;
  }

  function measure() {
    if (!host) return;
    const r = host.getBoundingClientRect();
    setViewport({ w: r.width, h: r.height });
  }

  function onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const vp = viewport();
    const cx = vp.w / 2;
    const cy = vp.h / 2;
    const next = Math.min(2.5, Math.max(0.25, zoom() * factor));
    // Keep the world point under the viewport center fixed while scaling.
    const wx = (cx - pan().x) / zoom();
    const wy = (cy - pan().y) / zoom();
    setPan({ x: cx - wx * next, y: cy - wy * next });
    setZoom(next);
  }

  function fit() {
    const vp = viewport();
    if (!vp.w || !vp.h) return;
    const t = fitTransform(visible().layout, vp.w, vp.h, 40);
    setZoom(t.scale);
    setPan({ x: t.tx, y: t.ty });
  }

  function reset() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  onMount(() => {
    measure();
    window.addEventListener("resize", measure);
    host?.addEventListener("wheel", onWheel, { passive: false });
  });
  onCleanup(() => {
    window.removeEventListener("resize", measure);
    host?.removeEventListener("wheel", onWheel);
  });

  // One automatic fit after the first measure so the initial view shows
  // the whole graph; afterwards the user drives zoom/pan via Fit/Reset.
  createEffect(() => {
    if (viewport().w > 0 && viewport().h > 0 && !didFit()) {
      fit();
      setDidFit(true);
    }
  });

  const onPointerDown = (e) => {
    moved = false;
    setDrag({ x: e.clientX, y: e.clientY, px: pan().x, py: pan().y });
  };
  const onPointerMove = (e) => {
    if (!drag()) return;
    const dx = e.clientX - drag().x;
    const dy = e.clientY - drag().y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    setPan({ x: drag().px + dx, y: drag().py + dy });
  };
  const onPointerUp = () => setDrag(null);
  const onNodeSelect = (id) => {
    if (!moved) select(id);
  };
  const onNodeKeyDown = (e, id) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select(id);
    } else if (e.key === "Escape") {
      // Stop propagation so NodeDetail's window-level Escape handler
      // doesn't double-handle the same keypress.
      e.stopPropagation();
      // SVGElement does not expose HTMLElement.blur() in every browser;
      // fall back to blurring whatever is focused when it does not.
      const el = e.currentTarget;
      if (typeof el.blur === "function") el.blur();
      else if (document.activeElement === el) document.activeElement.blur?.();
      if (selectedId() === id) select(null);
    }
  };

  const controlCls =
    "min-h-[36px] rounded-control border border-line bg-panel-2 px-3 text-[13px] text-body outline-none " +
    "focus:border-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";

  return (
    <div class="flex h-full flex-col">
      <div class="border-b border-line px-4 py-2">
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
          <label class="flex items-center gap-1.5 text-xs text-body">
            <input type="checkbox" checked={showHistory()} onChange={(e) => setShowHistory(e.currentTarget.checked)} />
            Show history
          </label>
          <div class="ml-auto flex items-center gap-2 text-[11px] text-mute">
            <button type="button" class={BTN_CLS} onClick={fit}>Fit</button>
            <button type="button" class={BTN_CLS} onClick={reset}>Reset</button>
            <span class="mono w-12 text-right tabular-nums">{Math.round(zoom() * 100)}%</span>
          </div>
        </FilterBar>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5 text-[11px] text-mute">
          <span><span class="text-rose-600">→</span> BLOCKS</span>
          <span><span class="text-purple-600">→</span> SUPERSEDES</span>
          <span><span class="text-sky-600">→</span> DERIVED_FROM</span>
          <span class="ml-auto">drag to pan · wheel to zoom · tab to focus nodes</span>
        </div>
      </div>

      <div class="relative flex-1 overflow-hidden bg-[radial-gradient(circle,#d4d4d8_1px,transparent_1px)] [background-size:24px_24px]">
        <Show when={Object.keys(visible().nodes).length} fallback={<div class="p-8"><Empty>No nodes match the current filters.</Empty></div>}>
          <Show when={showIsolation()}>
            <div class="absolute inset-x-0 top-3 z-10 px-4">
              <AlertBanner tone="info" title="Sin relaciones visibles">
                Hay nodos en el grafo pero ninguna dependencia visible entre ellos.
              </AlertBanner>
            </div>
          </Show>
          <svg
            ref={host}
            width="100%"
            height="100%"
            class="block select-none"
            style={{ touchAction: "none" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            <defs>
              {Object.entries(EDGE_COLORS).map(([type, color]) => (
                <marker key={type} id={`arrow-${type}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
                </marker>
              ))}
              <marker id="arrow-default" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
              </marker>
            </defs>
            <g transform={`translate(${pan().x} ${pan().y}) scale(${zoom()})`}>
              <For each={visible().layout.iniRows}>
                {(row) => (
                  <text x={8} y={row.y} font-size="11" fill="#71717a" class="mono">{row.ini}</text>
                )}
              </For>
              <For each={visible().edges}>
                {(e) => {
                  const a = visible().layout.pos[e.from];
                  const b = visible().layout.pos[e.to];
                  if (!a || !b) return null;
                  const color = EDGE_COLORS[e.type] || "#64748b";
                  const dash = e.type === "BLOCKS" ? "" : "6 4";
                  const marker = EDGE_COLORS[e.type] ? `url(#arrow-${e.type})` : "url(#arrow-default)";
                  return (
                    <path
                      d={buildEdgePath(a, b)}
                      fill="none"
                      stroke={color}
                      stroke-width="1.4"
                      stroke-dasharray={dash}
                      marker-end={marker}
                      opacity={edgeOpacity(e)}
                    />
                  );
                }}
              </For>
              <For each={Object.entries(visible().nodes)}>
                {([id, n]) => {
                  const p = visible().layout.pos[id];
                  if (!p) return null;
                  const sel = selectedId() === id;
                  return (
                    <g opacity={nodeOpacity(n)}>
                      <NodeShape
                        n={n}
                        pos={p}
                        selected={sel}
                        focused={focusedId() === id}
                        neighbor={!sel && focusIds()?.has(id)}
                        onSelect={onNodeSelect}
                        onKeyDown={onNodeKeyDown}
                        onFocus={() => setFocusedId(id)}
                        onBlur={() => setFocusedId((cur) => (cur === id ? null : cur))}
                      />
                    </g>
                  );
                }}
              </For>
            </g>
          </svg>
        </Show>
      </div>
    </div>
  );
}
