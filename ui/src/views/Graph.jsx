import { createMemo, createSignal, Show, For } from "solid-js";
import { useStore } from "../store.jsx";
import { StatusBadge, Empty } from "../components.jsx";

const EDGE_COLORS = {
  BLOCKS: "#e11d48",
  SUPERSEDES: "#9333ea",
  DERIVED_FROM: "#0284c7",
  INFORMS: "#94a3b8",
  RELATES_TO: "#94a3b8",
  CONFLICTS_WITH: "#94a3b8",
};

const ACTIVE_STATUSES = new Set(["open", "in_progress", "done", "canceled", "resolved", "superseded", "deprecated"]);

function computeLayout(nodes, edges) {
  const blockersOf = (id) => edges.filter((e) => e.type === "BLOCKS" && e.to === id).map((e) => e.from);
  const depth = {};
  const compute = (id, seen) => {
    if (depth[id] !== undefined) return depth[id];
    if (seen.has(id)) return 1; // cycle guard: keep members visible
    seen.add(id);
    const bs = blockersOf(id).filter((b) => nodes[b]);
    const d = bs.length ? 1 + Math.max(...bs.map((b) => compute(b, seen))) : 1;
    depth[id] = Math.min(d, 24);
    return depth[id];
  };
  for (const id of Object.keys(nodes)) compute(id, new Set());

  const byIni = {};
  for (const id of Object.keys(nodes)) {
    const ini = nodes[id].initiative || "(none)";
    (byIni[ini] ||= []).push(id);
  }

  const pos = {};
  let y = 30;
  const iniRows = [];
  for (const [ini, ids] of Object.entries(byIni)) {
    const counts = {};
    for (const id of ids) {
      const d = depth[id];
      const idx = counts[d] || 0;
      counts[d] = idx + 1;
      pos[id] = { x: d * 230 + 40, y: y + idx * 58 };
    }
    const rowH = Math.max(1, ...Object.values(counts)) * 58;
    iniRows.push({ ini, y: y - 14, height: rowH + 18 });
    y += rowH + 34;
  }
  const maxDepth = Math.max(1, ...Object.values(depth));
  return { pos, depth, width: maxDepth * 230 + 160, height: y + 20, iniRows };
}

export default function Graph() {
  const { snapshot, select, selectedId } = useStore();
  const s = () => snapshot();
  const [ini, setIni] = createSignal("");
  const [showHistory, setShowHistory] = createSignal(false);
  const [zoom, setZoom] = createSignal(0.9);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  const [drag, setDrag] = createSignal(null);

  const initiatives = createMemo(() => {
    const set = new Set();
    for (const n of Object.values(s()?.nodes || {})) if (n.initiative) set.add(n.initiative);
    return [...set].sort();
  });

  const visible = createMemo(() => {
    const nodes = s()?.nodes || {};
    const out = {};
    for (const [id, n] of Object.entries(nodes)) {
      if (ini() && n.initiative !== ini()) continue;
      if (!showHistory() && ["done", "canceled", "resolved", "superseded", "deprecated"].includes(n.status)) continue;
      out[id] = n;
    }
    const edges = (s()?.edges || []).filter((e) => out[e.from] && out[e.to]);
    return { nodes: out, edges, layout: computeLayout(out, edges) };
  });

  const onWheel = (e) => {
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    setZoom((z) => Math.min(2.5, Math.max(0.25, z * factor)));
  };

  const onPointerDown = (e) => setDrag({ x: e.clientX, y: e.clientY, px: pan().x, py: pan().y });
  const onPointerMove = (e) => {
    if (!drag()) return;
    setPan({ x: drag().px + (e.clientX - drag().x), y: drag().py + (e.clientY - drag().y) });
  };
  const onPointerUp = () => setDrag(null);

  const shapeFor = (n, pos, selected) => {
    const common = {
      stroke: selected ? "#0284c7" : "#d4d4d8",
      "stroke-width": selected ? 2 : 1.2,
      fill: "#f7f7f8",
      class: "cursor-pointer",
      onClick: () => select(n.id),
    };
    const label = (
      <text x={pos.x} y={pos.y + (n.kind === "knowledge" ? 4 : 22)} text-anchor="middle" font-size="10" fill={n.kind === "knowledge" ? "#7c3aed" : n.subkind === "gate" ? "#9a3412" : "#3f3f46"} class="mono pointer-events-none">
        {n.id}
      </text>
    );
    if (n.kind === "knowledge") {
      return (
        <g>
          <circle cx={pos.x} cy={pos.y} r={9} {...common} fill="#ede9fe" />
          {label}
        </g>
      );
    }
    if (n.subkind === "gate") {
      const r = 26;
      const pts = `${pos.x},${pos.y - r} ${pos.x + r},${pos.y} ${pos.x},${pos.y + r} ${pos.x - r},${pos.y}`;
      return (
        <g>
          <polygon points={pts} {...common} fill="#fff4e6" />
          {label}
        </g>
      );
    }
    return (
      <g>
        <rect x={pos.x - 68} y={pos.y - 13} width={136} height={26} rx={5} {...common} />
        {label}
      </g>
    );
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
        <div class="ml-auto flex items-center gap-3 text-[11px] text-slate-600">
          <span><span class="text-rose-600">━</span> BLOCKS</span>
          <span><span class="text-purple-600">╌</span> SUPERSEDES</span>
          <span><span class="text-sky-600">╌</span> DERIVED_FROM</span>
          <span>· drag to pan · wheel to zoom</span>
        </div>
      </div>

      <div class="flex-1 overflow-auto bg-[radial-gradient(circle,#d4d4d8_1px,transparent_1px)] [background-size:24px_24px]">
        <Show when={Object.keys(visible().nodes).length} fallback={<div class="p-8"><Empty>No nodes match the current filters.</Empty></div>}>
          <svg
            width={visible().layout.width * zoom()}
            height={visible().layout.height * zoom()}
            class="min-h-full min-w-full select-none"
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            style={{ transform: `translate(${pan().x}px, ${pan().y}px)` }}
          >
            <g>
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
                  const mx = (a.x + b.x) / 2;
                  const my = (a.y + b.y) / 2;
                  const color = EDGE_COLORS[e.type] || "#64748b";
                  const dash = e.type === "BLOCKS" ? "" : "6 4";
                  return (
                    <g>
                      <path d={`M ${a.x} ${a.y} Q ${mx} ${a.y} ${mx} ${my} Q ${mx} ${b.y} ${b.x} ${b.y}`} fill="none" stroke={color} stroke-width="1.4" stroke-dasharray={dash} opacity={e.type === "BLOCKS" ? 0.9 : 0.65} />
                      <circle cx={b.x} cy={b.y} r={3} fill={color} opacity={0.8} />
                    </g>
                  );
                }}
              </For>
              <For each={Object.entries(visible().nodes)}>
                {([id, n]) => {
                  const p = visible().layout.pos[id];
                  if (!p) return null;
                  const sel = selectedId() === id;
                  return (
                    <g opacity={n.status === "done" || n.status === "resolved" || n.status === "superseded" || n.status === "deprecated" ? 0.55 : 1}>
                      {shapeFor(n, p, sel)}
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
