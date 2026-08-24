import { Show, For } from "solid-js";
import { useStore } from "../store.jsx";
import { StatCard, Section, Empty, Chip, StatusBadge, fmtTime } from "../components.jsx";

export default function Overview() {
  const { snapshot, select } = useStore();
  const s = () => snapshot();
  const sum = () => s()?.summary;
  const ini = () => Object.values(s()?.initiatives || {});
  const initSummary = () => {
    const by = {};
    for (const n of Object.values(s()?.nodes || {})) {
      if (!n.initiative) continue;
      by[n.initiative] = by[n.initiative] || { total: 0, done: 0, in_progress: 0 };
      by[n.initiative].total += 1;
      if (n.status === "done" || n.status === "resolved") by[n.initiative].done += 1;
      if (n.status === "in_progress") by[n.initiative].in_progress += 1;
    }
    return Object.entries(by).sort((a, b) => b[1].total - a[1].total);
  };
  const gatesOpen = () => Object.values(s()?.nodes || {}).filter((n) => n.subkind === "gate" && n.status === "open");
  const knowledgeActive = () => Object.values(s()?.nodes || {}).filter((n) => n.kind === "knowledge" && n.status !== "deprecated");

  return (
    <div class="h-full overflow-auto p-6">
      <div class="mb-4 flex items-baseline justify-between">
        <h1 class="text-lg font-semibold">Overview</h1>
        <span class="text-xs text-slate-500">Snapshot {new Date(s()?.generated_at || Date.now()).toLocaleTimeString()}</span>
      </div>

      <Show when={sum()} fallback={<Empty>No data yet.</Empty>}>
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard value={sum().ready} label="Ready" onClick={() => select(null)} />
          <StatCard value={sum().in_progress} label="In progress" />
          <StatCard value={sum().blocked} label="Blocked" />
          <StatCard value={sum().backlog} label="Backlog" />
          <StatCard value={sum().open_gates} label="Open gates" />
          <StatCard value={sum().done} label="Done" />
          <StatCard value={sum().canceled} label="Canceled" />
          <StatCard value={sum().superseded} label="Superseded" />
          <StatCard value={sum().active_knowledge} label="Knowledge active" />
          <StatCard value={sum().total_nodes} label="Total nodes" />
        </div>

        <div class="mt-6 grid gap-4 lg:grid-cols-2">
          <Section title="Open gates">
            <Show when={gatesOpen().length} fallback={<Empty>No open gates.</Empty>}>
              <div class="space-y-2">
                <For each={gatesOpen()}>
                  {(g) => (
                    <button class="w-full rounded border border-line bg-panel-2 p-2 text-left hover:border-sky-500/40" onClick={() => select(g.id)}>
                      <div class="flex items-center gap-2">
                        <StatusBadge status="open" />
                        <span class="mono text-xs text-amber-300">{g.id}</span>
                        <Chip>{g.purpose || "decision"}</Chip>
                      </div>
                      <div class="mt-1 text-sm text-slate-200">{g.title}</div>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Section>

          <Section title="Stale claims">
            <Show when={s()?.alerts?.length} fallback={<Empty>No stale claims.</Empty>}>
              <div class="space-y-2">
                <For each={s()?.alerts}>
                  {(a) => (
                    <button class="w-full rounded border border-rose-500/30 bg-rose-500/5 p-2 text-left hover:border-rose-500/50" onClick={() => select(a.id)}>
                      <div class="flex items-center gap-2">
                        <span class="mono text-xs text-rose-300">{a.id}</span>
                        <span class="text-xs text-slate-400">claimed by {a.claim.by}</span>
                      </div>
                      <div class="text-xs text-slate-300">{a.title}</div>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Section>
        </div>

        <div class="mt-6 grid gap-4 lg:grid-cols-2">
          <Section title="Initiatives">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-xs uppercase tracking-wider text-slate-500">
                  <th class="py-1">Initiative</th>
                  <th class="py-1 text-right">Total</th>
                  <th class="py-1 text-right">Done</th>
                  <th class="py-1 text-right">In progress</th>
                </tr>
              </thead>
              <tbody>
                <For each={initSummary()}>
                  {([name, v]) => (
                    <tr class="border-t border-line">
                      <td class="py-1.5">
                        <span class="mono text-xs text-sky-300">{name}</span>
                        <Show when={ini().find((i) => i.name === name)?.desc}>
                          <div class="text-xs text-slate-500">{ini().find((i) => i.name === name).desc}</div>
                        </Show>
                      </td>
                      <td class="py-1.5 text-right tabular-nums">{v.total}</td>
                      <td class="py-1.5 text-right tabular-nums text-emerald-400">{v.done}</td>
                      <td class="py-1.5 text-right tabular-nums text-sky-300">{v.in_progress}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Section>

          <Section title="Recent activity">
            <div class="space-y-1.5">
              <For each={s()?.recent_activity?.slice(0, 12)}>
                {(e) => (
                  <button class="flex w-full items-start gap-2 rounded p-1 text-left hover:bg-panel-2" onClick={() => e.node && select(e.node)}>
                    <span class="mono shrink-0 text-[11px] text-slate-500">{fmtTime(e.ts)}</span>
                    <span class="mono shrink-0 rounded bg-panel-2 px-1 text-[11px] text-sky-300">{e.action}</span>
                    <span class="truncate text-xs text-slate-300">
                      <Show when={e.node} fallback={e.note}>{e.node}</Show>
                      <span class="text-slate-500"> · {e.note}</span>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Section>
        </div>

        <div class="mt-6">
          <Section title="Active knowledge">
            <Show when={knowledgeActive().length} fallback={<Empty>No active knowledge nodes.</Empty>}>
              <div class="flex flex-wrap gap-2">
                <For each={knowledgeActive()}>
                  {(k) => (
                    <button class="rounded border border-violet-500/30 bg-violet-500/5 px-2 py-1 text-left hover:border-violet-500/50" onClick={() => select(k.id)}>
                      <span class="mono mr-2 text-xs text-violet-300">{k.id}</span>
                      <span class="text-xs text-slate-200">{k.title}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Section>
        </div>
      </Show>
    </div>
  );
}
