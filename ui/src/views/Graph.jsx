import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, For } from "solid-js";
import { useStore } from "../store.jsx";
import { Empty, AlertBanner } from "../components.jsx";
import {
  kindFor,
  computeLayout,
  fitTransform,
  abbreviate,
  buildEdgePath,
  shouldShowIsolationCallout,
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

// Node label inside the SVG: ID + abbreviated title + kind/status as text,
// so the direction and state are readable without relying on color alone.
function NodeShape(props) {
  const n = () => props.n;
  const pos = () => props.pos;
  const selected = () => props.selected;
  const meta = () => STATUS_COLORS[n().status] || STATUS_DEFAULT;
  const stroke = () => (selected() ? "#0284c7" : meta().stroke);
  const sw = () => (selected() ? 2 : 1.2);
  const label = (
    <g class="pointer-events-none">
      <text x={pos().x} y={pos().y - 17} text-anchor="middle" font-size="10" fill={meta().text} class="mono">{n().id}</text>
      <text x={pos().x} y={pos().y + 1} text-anchor="middle" font-size="11" fill="#27272a">{abbreviate(n().title, 32)}</text>
      <text x={pos().x} y={pos().y + 19} text-anchor="middle" font-size="9" fill="#71717a" class="mono">{kindFor(n())} · {n().status || "open"}</text>
    </g>
  );
  const click = () => props.onSelect(n().id);
  if (kindFor(n()) === "knowledge") {
    return (
      <g>
        <circle cx={pos().x} cy={pos().y} r={28} stroke={stroke()} stroke-width={sw()} fill="#f5f3ff" class="cursor-pointer" onClick={click} />
        {label}
      </g>
    );
  }
  if (kindFor(n()) === "gate") {
    const pts = `${pos().x},${pos().y - 28} ${pos().x + 96},${pos().y} ${pos().x},${pos().y + 28} ${pos().x - 96},${pos().y}`;
    return (
      <g>
        <polygon points={pts} stroke={stroke()} stroke-width={sw()} fill="#fff4e6" class="cursor-pointer" onClick={click} />
        {label}
      </g>
    );
  }
  return (
    <g>
      <rect x={pos().x - 96} y={pos().y - 28} width={192} height={56} rx={8} stroke={stroke()} stroke-width={sw()} fill="#f7f7f8" class="cursor-pointer" onClick={click} />
      {label}
    </g>
  );
}

export default function Graph() {
  const { snapshot, select, selectedId } = useStore();
  const s = () => snapshot();
  const [ini, setIni] = createSignal("");
  const [showHistory, setShowHistory] = createSignal(false);
  const [zoom, setZoom] = createSignal(0.9);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  const [drag, setDrag] = createSignal(null);
  const [viewport, setViewport] = createSignal({ w: 0, h: 0 });
  const [didFit, setDidFit] = createSignal(false);
  let moved = false;
  let host;

  const initiatives = createMemo(() => {
    const set = new Set();
    for (const n of Object.values(s()?.nodes || {})) if (n.initiative) set.add(n.initiative);
    return [...set].sort();
  });

  // A knowledge node with no incident edges is disconnected — it never
  // participates in a dependency relation, so it is hidden by default
  // (the "no disconnected knowledge" default from the plan).
  const hasIncidentEdge = (id) =>
    (s()?.edges || []).some((e) => e.from === id || e.to === id);

  const visible = createMemo(() => {
    const nodes = s()?.nodes || {};
    const out = {};
    for (const [id, n] of Object.entries(nodes)) {
      if (ini() && n.initiative !== ini()) continue;
      if (!showHistory() && ["done", "canceled", "resolved", "superseded", "deprecated"].includes(n.status)) continue;
      if (kindFor(n) === "knowledge" && !hasIncidentEdge(id)) continue;
      out[id] = n;
    }
    const edges = (s()?.edges || []).filter((e) => out[e.from] && out[e.to]);
    return { nodes: out, edges, layout: computeLayout(out, edges) };
  });

  const showIsolation = () =>
    shouldShowIsolationCallout(
      s()?.nodes || {},
      Object.keys(visible().nodes).length,
      visible().edges.length,
    );

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

  return (
    <div class="flex h-full flex-col">
      <div class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
        <h1 class="text-sm font-semibold">Graph</h1>
        <select class="rounded-lg border border-line bg-panel px-2 py-1 text-xs text-slate-700 outline-none" value={ini()} onChange={(e) => setIni(e.currentTarget.value)}>
          <option value="">All initiatives</option>
          <For each={initiatives()}>{(i) => <option value={i}>{i}</option>}</For>
        </select>
        <label class="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={showHistory()} onChange={(e) => setShowHistory(e.currentTarget.checked)} />
          Show history
        </label>
        <div class="ml-auto flex items-center gap-2 text-[11px] text-slate-600">
          <button type="button" class={BTN_CLS} onClick={fit}>Fit</button>
          <button type="button" class={BTN_CLS} onClick={reset}>Reset</button>
          <span class="mono w-12 text-right tabular-nums">{Math.round(zoom() * 100)}%</span>
        </div>
        <div class="flex items-center gap-3 text-[11px] text-slate-600">
          <span><span class="text-rose-600">→</span> BLOCKS</span>
          <span><span class="text-purple-600">→</span> SUPERSEDES</span>
          <span><span class="text-sky-600">→</span> DERIVED_FROM</span>
          <span>· drag to pan · wheel to zoom</span>
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
                      opacity={e.type === "BLOCKS" ? 0.9 : 0.65}
                    />
                  );
                }}
              </For>
              <For each={Object.entries(visible().nodes)}>
                {([id, n]) => {
                  const p = visible().layout.pos[id];
                  if (!p) return null;
                  const sel = selectedId() === id;
                  const faded = n.status === "done" || n.status === "resolved" || n.status === "superseded" || n.status === "deprecated";
                  return (
                    <g opacity={faded ? 0.55 : 1}>
                      <NodeShape n={n} pos={p} selected={sel} onSelect={onNodeSelect} />
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
