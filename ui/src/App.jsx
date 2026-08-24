import { Show, For } from "solid-js";
import { StoreProvider, useStore } from "./store.jsx";
import Overview from "./views/Overview.jsx";
import Board from "./views/Board.jsx";
import Graph from "./views/Graph.jsx";
import Nodes from "./views/Nodes.jsx";
import Gates from "./views/Gates.jsx";
import Knowledge from "./views/Knowledge.jsx";
import Activity from "./views/Activity.jsx";
import NodeDetail from "./views/NodeDetail.jsx";

const NAV = [
  ["overview", "Overview"],
  ["board", "Board"],
  ["graph", "Graph"],
  ["nodes", "Nodes"],
  ["gates", "Gates"],
  ["knowledge", "Knowledge"],
  ["activity", "Activity"],
];

function Sidebar() {
  const { route, setRoute, snapshot } = useStore();
  const project = () => snapshot()?.project?.root || "";
  return (
    <aside class="flex w-56 shrink-0 flex-col border-r border-line bg-canvas">
      <div class="border-b border-line px-4 py-3">
        <div class="text-sm font-bold tracking-wide text-ink">climier<span class="text-sky-600"> ui</span></div>
        <div class="mono mt-1 truncate text-[11px] text-mute" title={project()}>{project() || "…"}</div>
      </div>
      <nav class="flex-1 space-y-0.5 p-2">
        <For each={NAV}>
          {([key, label]) => (
            <button
              class={`w-full rounded-full px-3 py-1.5 text-left text-sm ${
                route() === key ? "bg-ink font-medium text-white" : "text-slate-600 hover:bg-panel-2 hover:text-ink"
              }`}
              onClick={() => setRoute(key)}
            >
              {label}
            </button>
          )}
        </For>
      </nav>
      <div class="border-t border-line px-4 py-2 text-[11px] text-mute">
        Read-only projection · CLI stays the source of truth
      </div>
    </aside>
  );
}

function Main() {
  const { route, error, loading, reload, snapshot } = useStore();
  return (
    <main class="min-w-0 flex-1 overflow-hidden">
      <Show when={!error()} fallback={
        <div class="p-8">
          <div class="text-sm text-rose-700">Failed to load snapshot: {error()}</div>
          <button class="mt-3 rounded-full border border-line bg-panel px-3 py-1 text-xs text-slate-600 hover:bg-panel-2" onClick={reload}>Retry</button>
        </div>
      }>
        <Show when={!loading()} fallback={<div class="p-8 text-sm text-slate-500">Loading snapshot…</div>}>
          <SwitchRoute route={route()} />
        </Show>
      </Show>
      <Show when={snapshot() && !snapshot().project.initialized}>
        <div class="mx-8 mt-4 rounded-lg border border-amber-600/40 bg-amber-500/10 p-3 text-sm text-amber-900">
          This project has no climier state yet. Run <code class="mono">climier init</code> in {snapshot().project.root} to create it.
        </div>
      </Show>
    </main>
  );
}

function SwitchRoute(props) {
  const { route } = useStore();
  return (
    <Show when={props.route === "overview"} fallback={
      <Show when={props.route === "board"} fallback={
        <Show when={props.route === "graph"} fallback={
          <Show when={props.route === "nodes"} fallback={
            <Show when={props.route === "gates"} fallback={
              <Show when={props.route === "knowledge"} fallback={<Activity />}>
                <Knowledge />
              </Show>
            }>
              <Gates />
            </Show>
          }>
            <Nodes />
          </Show>
        }>
          <Graph />
        </Show>
      }>
        <Board />
      </Show>
    }>
      <Overview />
    </Show>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <div class="flex h-full">
        <Sidebar />
        <Main />
        <NodeDetail />
      </div>
    </StoreProvider>
  );
}
