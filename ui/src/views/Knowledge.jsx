import { createMemo, createSignal, Show, For } from "solid-js";
import { useStore } from "../store.jsx";
import { StatusBadge, Chip, Empty } from "../components.jsx";

export default function Knowledge() {
  const { snapshot, select } = useStore();
  const s = () => snapshot();
  const [q, setQ] = createSignal("");
  const [showDeprecated, setShowDeprecated] = createSignal(false);

  const list = createMemo(() => {
    let out = Object.values(s()?.nodes || {}).filter((n) => n.kind === "knowledge");
    if (!showDeprecated()) out = out.filter((n) => n.status !== "deprecated");
    if (q()) {
      const needle = q().toLowerCase();
      out = out.filter((n) => `${n.id} ${n.title} ${n.body || ""} ${n.knowledge_type || ""}`.toLowerCase().includes(needle));
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  });

  const scopeChips = (k) => {
    const sc = k.scope || {};
    const chips = [];
    for (const d of sc.domains || []) chips.push([d, "domain"]);
    for (const i of sc.initiatives || []) chips.push([i, "initiative"]);
    for (const t of sc.tags || []) chips.push([`#${t}`, "tag"]);
    for (const n of sc.node_ids || []) chips.push([n, "node"]);
    return chips;
  };

  return (
    <div class="flex h-full flex-col">
      <div class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
        <h1 class="text-sm font-semibold">Knowledge <span class="text-xs font-normal text-slate-500">({list().length})</span></h1>
        <input class="mono w-52 rounded-lg border border-line bg-panel px-2 py-1 text-xs outline-none focus:border-sky-600/50" placeholder="search…" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
        <label class="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={showDeprecated()} onChange={(e) => setShowDeprecated(e.currentTarget.checked)} />
          Include deprecated
        </label>
      </div>
      <div class="flex-1 space-y-2 overflow-auto p-4">
        <Show when={list().length} fallback={<Empty>No knowledge nodes match.</Empty>}>
          <For each={list()}>
            {(k) => (
              <button class="w-full rounded-lg border border-violet-600/30 bg-panel p-3 text-left hover:border-violet-600/60" onClick={() => select(k.id)}>
                <div class="flex flex-wrap items-center gap-2">
                  <span class="mono text-xs text-violet-700">{k.id}</span>
                  <StatusBadge status={k.status === "deprecated" ? "deprecated" : "active"} />
                  <Chip>{k.knowledge_type || "warning"}</Chip>
                  <Show when={k.initiative}><Chip><span class="text-sky-700">{k.initiative}</span></Chip></Show>
                </div>
                <div class="mt-1.5 text-sm font-medium text-slate-900">{k.title}</div>
                <Show when={k.body}><div class="mt-1 line-clamp-2 text-xs text-slate-600">{k.body}</div></Show>
                <Show when={scopeChips(k).length}>
                  <div class="mt-2 flex flex-wrap gap-1">
                    <For each={scopeChips(k)}>
                      {([label, kind]) => (
                        <span class={`rounded-full px-1.5 py-0.5 text-[10px] border ${kind === "node" ? "border-rose-500/30 text-rose-700" : "border-line text-slate-500"}`}>
                          {kind}: {label}
                        </span>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={k.mitigation}>
                  <div class="mt-1 text-[11px] text-teal-700">mitigation: {k.mitigation}</div>
                </Show>
              </button>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
