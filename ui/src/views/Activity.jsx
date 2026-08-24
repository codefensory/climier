import { createSignal, Show, For, onMount } from "solid-js";
import { useStore } from "../store.jsx";
import { getActivity } from "../api.js";
import { Empty, fmtTime } from "../components.jsx";

const ACTIONS = [
  "", "add-node", "add-note", "take", "resolve", "release", "reopen", "cancel", "update", "supersede", "deprecate-knowledge",
];

export default function Activity() {
  const { select } = useStore();
  const [action, setAction] = createSignal("");
  const [agent, setAgent] = createSignal("");
  const [node, setNode] = createSignal("");
  const [limit, setLimit] = createSignal(100);
  const [offset, setOffset] = createSignal(0);
  const [data, setData] = createSignal(null);
  const [error, setError] = createSignal(null);

  async function load() {
    try {
      setData(await getActivity({ action: action(), agent: agent(), node: node(), limit: limit(), offset: offset() }));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }
  onMount(load);

  const entries = () => data()?.entries || [];
  const total = () => data()?.total || 0;

  return (
    <div class="flex h-full flex-col">
      <div class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
        <h1 class="text-sm font-semibold">Activity <span class="text-xs font-normal text-slate-500">({total()} entries)</span></h1>
        <select class="rounded border border-line bg-panel px-2 py-1 text-xs text-slate-300 outline-none" value={action()} onChange={(e) => { setAction(e.currentTarget.value); setOffset(0); load(); }}>
          <For each={ACTIONS}>{(a) => <option value={a}>{a || "All actions"}</option>}</For>
        </select>
        <input class="mono w-40 rounded border border-line bg-panel px-2 py-1 text-xs outline-none focus:border-sky-500/50" placeholder="agent…" value={agent()} onInput={(e) => { setAgent(e.currentTarget.value); setOffset(0); load(); }} />
        <input class="mono w-40 rounded border border-line bg-panel px-2 py-1 text-xs outline-none focus:border-sky-500/50" placeholder="node id…" value={node()} onInput={(e) => { setNode(e.currentTarget.value); setOffset(0); load(); }} />
        <button class="rounded border border-line bg-panel px-2 py-1 text-xs text-slate-300 hover:bg-panel-2" onClick={load}>Refresh</button>
      </div>
      <div class="flex-1 overflow-auto">
        <Show when={!error()} fallback={<div class="p-6 text-sm text-rose-300">{error()}</div>}>
          <Show when={entries().length} fallback={<div class="p-6"><Empty>No log entries match.</Empty></div>}>
            <table class="w-full text-sm">
              <thead class="sticky top-0 bg-ink">
                <tr class="text-left text-xs uppercase tracking-wider text-slate-500">
                  <th class="px-4 py-2">When</th>
                  <th class="px-2 py-2">Action</th>
                  <th class="px-2 py-2">Agent</th>
                  <th class="px-2 py-2">Node</th>
                  <th class="px-4 py-2">Note</th>
                </tr>
              </thead>
              <tbody>
                <For each={entries()}>
                  {(e) => (
                    <tr class="border-t border-line hover:bg-panel">
                      <td class="mono whitespace-nowrap px-4 py-1.5 text-xs text-slate-500">{fmtTime(e.ts)}</td>
                      <td class="mono px-2 py-1.5 text-xs text-sky-300">{e.action}</td>
                      <td class="mono px-2 py-1.5 text-xs text-slate-300">{e.agent}</td>
                      <td class="px-2 py-1.5">
                        <Show when={e.node || e.task} fallback={<span class="text-slate-600">—</span>}>
                          <button class="mono text-xs text-amber-300 hover:underline" onClick={() => select(e.node || e.task)}>
                            {e.node || e.task}
                          </button>
                        </Show>
                      </td>
                      <td class="max-w-xl truncate px-4 py-1.5 text-xs text-slate-400" title={e.note}>{e.note}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>
      </div>
      <div class="flex items-center gap-3 border-t border-line px-4 py-2 text-xs text-slate-400">
        <button class="rounded border border-line bg-panel px-2 py-1 hover:bg-panel-2 disabled:opacity-40" disabled={offset() === 0} onClick={() => { setOffset(Math.max(0, offset() - limit())); load(); }}>← Newer</button>
        <span class="tabular-nums">{offset() + 1}–{Math.min(offset() + limit(), total())} of {total()}</span>
        <button class="rounded border border-line bg-panel px-2 py-1 hover:bg-panel-2 disabled:opacity-40" disabled={offset() + limit() >= total()} onClick={() => { setOffset(offset() + limit()); load(); }}>Older →</button>
      </div>
    </div>
  );
}
