import { createMemo, createSignal, Show, For } from "solid-js";
import { useStore } from "../store.jsx";
import { StatusBadge, Empty, fmtTime } from "../components.jsx";

const STATUS_OPTIONS = ["", "ready", "in_progress", "blocked", "backlog", "open", "done", "canceled", "superseded"];

export default function Nodes() {
  const { snapshot, select } = useStore();
  const s = () => snapshot();
  const [q, setQ] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [ini, setIni] = createSignal("");

  const initiatives = createMemo(() => {
    const set = new Set();
    for (const n of Object.values(s()?.nodes || {})) if (n.initiative) set.add(n.initiative);
    return [...set].sort();
  });

  const derivedStatus = (n) => {
    if (n.status === "open") {
      if (n.backlog === true) return "backlog";
      const bs = (s()?.edges || []).filter((e) => e.type === "BLOCKS" && e.to === n.id);
      const satisfied = bs.every((e) => {
        const b = s()?.nodes[e.from];
        return !b || b.status === "done" || b.status === "resolved" || b.status === "superseded";
      });
      return satisfied ? "ready" : "blocked";
    }
    return n.status;
  };

  const list = createMemo(() => {
    let out = Object.values(s()?.nodes || {}).filter((n) => n.subkind === "task");
    if (q()) {
      const needle = q().toLowerCase();
      out = out.filter((n) => `${n.id} ${n.title} ${n.domain || ""} ${(n.tags || []).join(" ")}`.toLowerCase().includes(needle));
    }
    if (status()) out = out.filter((n) => derivedStatus(n) === status());
    if (ini()) out = out.filter((n) => n.initiative === ini());
    return out.sort((a, b) => a.id.localeCompare(b.id));
  });

  return (
    <div class="flex h-full flex-col">
      <div class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
        <h1 class="text-sm font-semibold">Nodes <span class="text-xs font-normal text-slate-500">({list().length} tasks)</span></h1>
        <input class="mono w-52 rounded border border-line bg-panel px-2 py-1 text-xs outline-none focus:border-sky-500/50" placeholder="search…" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
        <select class="rounded border border-line bg-panel px-2 py-1 text-xs text-slate-300 outline-none" value={status()} onChange={(e) => setStatus(e.currentTarget.value)}>
          <For each={STATUS_OPTIONS}>{(st) => <option value={st}>{st || "All statuses"}</option>}</For>
        </select>
        <select class="rounded border border-line bg-panel px-2 py-1 text-xs text-slate-300 outline-none" value={ini()} onChange={(e) => setIni(e.currentTarget.value)}>
          <option value="">All initiatives</option>
          <For each={initiatives()}>{(i) => <option value={i}>{i}</option>}</For>
        </select>
      </div>
      <div class="flex-1 overflow-auto">
        <table class="w-full text-sm">
          <thead class="sticky top-0 bg-ink">
            <tr class="text-left text-xs uppercase tracking-wider text-slate-500">
              <th class="px-4 py-2">Id</th>
              <th class="px-2 py-2">Status</th>
              <th class="px-2 py-2">Title</th>
              <th class="px-2 py-2">Initiative</th>
              <th class="px-2 py-2">Domain</th>
              <th class="px-2 py-2 text-right">Notes</th>
              <th class="px-2 py-2">Claim</th>
              <th class="px-4 py-2 text-right">Last activity</th>
            </tr>
          </thead>
          <tbody>
            <For each={list()}>
              {(n) => (
                <tr class="cursor-pointer border-t border-line hover:bg-panel" onClick={() => select(n.id)}>
                  <td class="mono px-4 py-1.5 text-xs text-sky-300">{n.id}</td>
                  <td class="px-2 py-1.5"><StatusBadge status={derivedStatus(n)} /></td>
                  <td class="max-w-md truncate px-2 py-1.5 text-slate-200">{n.title}</td>
                  <td class="mono px-2 py-1.5 text-xs text-slate-400">{n.initiative || "—"}</td>
                  <td class="px-2 py-1.5 text-xs text-slate-400">{n.domain || "—"}</td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-slate-400">{n.notes?.length || 0}</td>
                  <td class="px-2 py-1.5 text-xs text-sky-300">{n.claim?.by || "—"}</td>
                  <td class="px-4 py-1.5 text-right text-xs text-slate-500">{s()?.last_activity?.[n.id] ? fmtTime(s().last_activity[n.id].ts) : "—"}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <Show when={!list().length}><div class="p-6"><Empty>No tasks match.</Empty></div></Show>
      </div>
    </div>
  );
}
