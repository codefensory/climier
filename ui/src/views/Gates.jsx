import { createMemo, createSignal, Show, For } from "solid-js";
import { useStore } from "../store.jsx";
import { StatusBadge, Chip, Empty } from "../components.jsx";

const PURPOSES = ["decision", "approval", "external-dependency", "research"];

export default function Gates() {
  const { snapshot, select } = useStore();
  const s = () => snapshot();
  const [q, setQ] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [purpose, setPurpose] = createSignal("");

  const list = createMemo(() => {
    let out = Object.values(s()?.nodes || {}).filter((n) => n.subkind === "gate");
    if (q()) {
      const needle = q().toLowerCase();
      out = out.filter((n) => `${n.id} ${n.title} ${n.purpose || ""}`.toLowerCase().includes(needle));
    }
    if (status()) out = out.filter((n) => (n.status || "open") === status());
    if (purpose()) out = out.filter((n) => n.purpose === purpose());
    return out.sort((a, b) => a.id.localeCompare(b.id));
  });

  return (
    <div class="flex h-full flex-col">
      <div class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
        <h1 class="text-sm font-semibold">Gates <span class="text-xs font-normal text-slate-500">({list().length})</span></h1>
        <input class="mono w-52 rounded-lg border border-line bg-panel px-2 py-1 text-xs outline-none focus:border-sky-600/50" placeholder="search…" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
        <select class="rounded-lg border border-line bg-panel px-2 py-1 text-xs text-slate-700 outline-none" value={status()} onChange={(e) => setStatus(e.currentTarget.value)}>
          <option value="">All statuses</option>
          <option value="open">open</option>
          <option value="resolved">resolved</option>
          <option value="superseded">superseded</option>
          <option value="canceled">canceled</option>
        </select>
        <select class="rounded-lg border border-line bg-panel px-2 py-1 text-xs text-slate-700 outline-none" value={purpose()} onChange={(e) => setPurpose(e.currentTarget.value)}>
          <option value="">All purposes</option>
          <For each={PURPOSES}>{(p) => <option value={p}>{p}</option>}</For>
        </select>
      </div>
      <div class="flex-1 space-y-2 overflow-auto p-4">
        <Show when={list().length} fallback={<Empty>No gates match.</Empty>}>
          <For each={list()}>
            {(g) => (
              <button class="w-full rounded-lg border border-line bg-panel p-3 text-left hover:border-amber-600/50" onClick={() => select(g.id)}>
                <div class="flex flex-wrap items-center gap-2">
                  <span class="mono text-xs text-amber-700">{g.id}</span>
                  <StatusBadge status={g.status || "open"} />
                  <Chip>{g.purpose || "decision"}</Chip>
                  <Show when={g.initiative}><Chip><span class="text-sky-700">{g.initiative}</span></Chip></Show>
                  <span class="ml-auto text-[11px] text-slate-500">notes {g.notes?.length || 0}</span>
                </div>
                <div class="mt-1.5 text-sm font-medium text-slate-900">{g.title}</div>
                <Show when={g.resolution}>
                  <div class="mt-1 text-xs text-teal-700">
                    choice: {g.resolution.choice} — {g.resolution.rationale}
                  </div>
                </Show>
              </button>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
