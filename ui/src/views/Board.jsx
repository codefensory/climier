import { createMemo, createSignal, Show, For } from "solid-js";
import { useStore } from "../store.jsx";
import { StatusBadge, KindBadge, Chip, Empty, fmtTime, lastActionLabel } from "../components.jsx";

function blockersOf(edges, id) {
  return edges.filter((e) => e.type === "BLOCKS" && e.to === id).length;
}
function dependentsOf(edges, id) {
  return edges.filter((e) => e.type === "BLOCKS" && e.from === id).length;
}

function NodeCard(props) {
  const { select } = useStore();
  const n = () => props.node;
  const last = () => props.last;
  return (
    <button
      class="w-full rounded-lg border border-line bg-panel p-2.5 text-left transition-colors hover:border-sky-600/50"
      onClick={() => select(n().id)}
    >
      <div class="flex items-center justify-between gap-2">
        <span class="mono text-[11px] text-slate-500">{n().id}</span>
        <StatusBadge status={props.status} />
      </div>
      <div class="mt-1 line-clamp-2 text-[13px] font-medium leading-snug text-slate-900">{n().title}</div>
      <div class="mt-1.5 flex flex-wrap items-center gap-1">
        <Show when={n().initiative}><Chip><span class="text-sky-700">{n().initiative}</span></Chip></Show>
        <Show when={n().domain}><Chip>{n().domain}</Chip></Show>
      </div>
      <div class="mt-2 flex items-center gap-2 text-[11px] text-slate-500">
        <Show when={n().claim && n().claim.by}>
          <span class="rounded-full bg-sky-500/10 px-1 py-0.5 text-sky-700">⚑ {n().claim.by}</span>
        </Show>
        <span>notes {n().notes?.length || 0}</span>
        <span>blockers {blockersOf(props.edges, n().id)}</span>
        <span>dependents {dependentsOf(props.edges, n().id)}</span>
      </div>
      <Show when={last()}>
        <div class="mt-1 truncate text-[11px] text-slate-500">
          <span class="text-slate-600">{lastActionLabel(last().action)}</span> · {last().agent} · {fmtTime(last().ts)}
        </div>
      </Show>
    </button>
  );
}

export default function Board() {
  const { snapshot, select } = useStore();
  const s = () => snapshot();
  const [initiative, setInitiative] = createSignal("");
  const [q, setQ] = createSignal("");
  const [showHistory, setShowHistory] = createSignal(false);

  const edges = () => s()?.edges || [];
  const nodes = () => s()?.nodes || {};

  const filter = (id) => {
    if (initiative() && nodes()[id]?.initiative !== initiative()) return false;
    if (q()) {
      const n = nodes()[id];
      const hay = `${n.id} ${n.title} ${n.domain || ""} ${(n.tags || []).join(" ")}`.toLowerCase();
      if (!hay.includes(q().toLowerCase())) return false;
    }
    return true;
  };

  const pool = (list) => list?.filter(filter).map((id) => nodes()[id]).filter(Boolean) || [];
  const inProgress = () => Object.values(nodes()).filter((n) => n.subkind === "task" && n.status === "in_progress" && filter(n.id));
  const gatesOpen = () => Object.values(nodes()).filter((n) => n.subkind === "gate" && n.status === "open" && filter(n.id));
  const historyNodes = () =>
    showHistory()
      ? Object.values(nodes())
          .filter((n) => ["done", "canceled", "superseded", "resolved", "deprecated"].includes(n.status) && filter(n.id))
          .sort((a, b) => (b.notes?.length || 0) - (a.notes?.length || 0))
      : [];

  const initiatives = createMemo(() => {
    const set = new Set();
    for (const n of Object.values(nodes())) if (n.initiative) set.add(n.initiative);
    return [...set].sort();
  });

  const columns = createMemo(() => [
    { key: "ready", label: "Ready", ids: s()?.derived?.ready || [], tone: "border-emerald-500/30" },
    { key: "in_progress", label: "In progress", ids: null, tone: "border-sky-500/30" },
    { key: "blocked", label: "Blocked", ids: s()?.derived?.blocked || [], tone: "border-rose-500/30" },
    { key: "backlog", label: "Backlog", ids: s()?.derived?.backlog || [], tone: "border-slate-500/30" },
  ]);

  return (
    <div class="flex h-full flex-col">
      <div class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
        <h1 class="text-sm font-semibold">Board</h1>
        <input
          class="mono w-56 rounded-lg border border-line bg-panel px-2 py-1 text-xs outline-none focus:border-sky-600/50"
          placeholder="search id / title / domain…"
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
        <select class="rounded-lg border border-line bg-panel px-2 py-1 text-xs text-slate-700 outline-none" value={initiative()} onChange={(e) => setInitiative(e.currentTarget.value)}>
          <option value="">All initiatives</option>
          <For each={initiatives()}>{(i) => <option value={i}>{i}</option>}</For>
        </select>
        <label class="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={showHistory()} onChange={(e) => setShowHistory(e.currentTarget.checked)} />
          Show history (done / canceled / superseded)
        </label>
      </div>

      <div class="grid flex-1 grid-cols-4 gap-3 overflow-auto p-4">
        <For each={columns()}>
          {(col) => (
            <div class={`flex min-h-full flex-col rounded-lg border bg-panel/60 ${col.tone}`}>
              <div class="flex items-center justify-between border-b border-line px-3 py-2">
                <span class="mono text-[11px] font-semibold uppercase tracking-wider text-slate-600">{col.label}</span>
                <span class="text-xs tabular-nums text-slate-500">
                  {col.ids ? pool(col.ids).length : inProgress().length}
                </span>
              </div>
              <div class="flex-1 space-y-2 p-2">
                <Show
                  when={col.ids ? pool(col.ids).length : inProgress().length}
                  fallback={<Empty>Nothing here.</Empty>}
                >
                  <For each={col.ids ? pool(col.ids) : inProgress()}>
                    {(n) => <NodeCard node={n} status={col.key} edges={edges()} last={s()?.last_activity?.[n.id]} />}
                  </For>
                </Show>
              </div>
            </div>
          )}
        </For>
      </div>

      <Show when={gatesOpen().length}>
        <div class="border-t border-line px-4 py-2">
          <div class="mb-2 mono text-[11px] font-semibold uppercase tracking-wider text-amber-700">Gates · open</div>
          <div class="flex gap-2 overflow-x-auto pb-1">
            <For each={gatesOpen()}>
              {(g) => (
                <button class="w-64 shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-left hover:border-amber-600/60" onClick={() => select(g.id)}>
                  <div class="flex items-center justify-between">
                    <span class="mono text-[11px] text-amber-700">{g.id}</span>
                    <Chip>{g.purpose || "decision"}</Chip>
                  </div>
                  <div class="mt-1 text-[13px] font-medium text-slate-900">{g.title}</div>
                  <div class="mt-1 text-[11px] text-slate-500">blocks {dependentsOf(edges(), g.id)} task(s)</div>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={historyNodes().length}>
        <div class="border-t border-line px-4 py-2">
          <div class="mb-2 mono text-[11px] font-semibold uppercase tracking-wider text-slate-500">History · {historyNodes().length} node(s)</div>
          <div class="grid grid-cols-2 gap-2 opacity-70 lg:grid-cols-4">
            <For each={historyNodes().slice(0, 16)}>
              {(n) => <NodeCard node={n} status={n.status} edges={edges()} last={s()?.last_activity?.[n.id]} />}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
