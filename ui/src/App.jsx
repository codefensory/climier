// ui/src/App.jsx
//
// Shell + routing for the climier UI. Phase 3 / F3b of
// docs/ui-redesign-plan.md (section 6 — Fase 3).
//
// Scope of this file:
//   - Route registry (id -> component + label + group). The single source of
//     truth for what the dashboard can render. Replaces the nested
//     `SwitchRoute` from the pre-redesign shell.
//   - Hash-based routing without a router. `location.hash` is the URL state.
//     Back/forward and refresh both work because the hash is read on mount
//     and on every `hashchange` / `popstate` event.
//   - Grouped sidebar nav (Monitor / Work / Context / Audit) with
//     `aria-current="page"` on the active item.
//   - Main area handles three project states — loading, error, uninitialized
//     — before resolving the route. Unknown routes fall back to Overview
//     with an AlertBanner instead of silently landing in Activity (the
//     pre-Phase-3 bug).
//   - Uninitialized projects render as the main content with the CLI init
//     command shown as text. The UI never mutates the state file.
//
// Out of scope here:
//   - NodeDetail still renders as a fixed overlay on top of the shell; it
//     uses the store's `selectedId` and is independent of the route.
//   - Responsive variants (rail/drawer) are a Fase 3 stretch; this commit
//     ships the desktop shell that the design tokens are tuned for.

import { Show, For, onMount, onCleanup, createMemo } from "solid-js";
import { StoreProvider, useStore } from "./store.jsx";
import Overview from "./views/Overview.jsx";
import Board from "./views/Board.jsx";
import Graph from "./views/Graph.jsx";
import Nodes from "./views/Nodes.jsx"; // Tasks view; the file keeps the name
import Gates from "./views/Gates.jsx";
import Knowledge from "./views/Knowledge.jsx";
import Activity from "./views/Activity.jsx";
import NodeDetail from "./views/NodeDetail.jsx";
import {
  PageHeader,
  Panel,
  AlertBanner,
  Skeleton,
  LiveStatus,
} from "./components.jsx";
import {
  ROUTE_META,
  DEFAULT_ROUTE,
  NAV_GROUPS,
  parseHashRoute,
  writeHashRoute,
} from "./routes.mjs";

// Glue the pure metadata (ui/src/routes.mjs) to the view components. The
// metadata is the testable source of truth; this map is the rendering
// bridge. Every id in ROUTE_META must have an entry here.
const ROUTE_COMPONENTS = {
  overview:  Overview,
  board:     Board,
  graph:     Graph,
  tasks:     Nodes,
  gates:     Gates,
  knowledge: Knowledge,
  activity:  Activity,
};

const ROUTES = Object.freeze(
  Object.fromEntries(
    Object.entries(ROUTE_META).map(([id, meta]) => [
      id,
      Object.freeze({
        component: ROUTE_COMPONENTS[id],
        label: meta.label,
        group: meta.group,
      }),
    ])
  )
);

// === RouteSync =============================================================
// Bridges the URL hash and the store's route signal.
//
// On render: synchronously read the current hash and update the store so
// the very first paint reflects the URL (no flash of Overview when the user
// refreshes on /#/tasks). Solid renders children in order, so this call
// happens before the sidebar / main read the signal.
//
// On mount: subscribe to `hashchange` and `popstate` so back/forward and
// any external hash change (e.g. address bar) keep the UI in sync. The
// store's `setRoute` is reserved for the sync-from-URL path; explicit nav
// uses the `navigate` helper below.
function RouteSync() {
  const { route, setRoute } = useStore();
  // Synchronous initial sync — run before any sibling reads the signal.
  if (typeof window !== "undefined") {
    const parsed = parseHashRoute(window.location.hash);
    if (parsed.id !== route()) setRoute(parsed.id);
  }
  onMount(() => {
    const sync = () => {
      const parsed = parseHashRoute(window.location.hash);
      if (parsed.id !== route()) setRoute(parsed.id);
    };
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    onCleanup(() => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    });
  });
  return null;
}

// === NavButton =============================================================
// One nav link. Uses an anchor so middle-click / cmd+click open the route
// in a new tab (the href is the URL). The click handler intercepts plain
// left-clicks to keep the single-page feel without a router.
function NavButton(props) {
  // id      (string, required — must be a key of ROUTES)
  // label   (string, required)
  const { route, setRoute } = useStore();
  const active = () => route() === props.id;
  function go(e) {
    // Let the browser handle modifier-clicks (open in new tab, etc.).
    if (e.defaultPrevented) return;
    if (e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (!ROUTES[props.id]) return;
    setRoute(props.id);
    writeHashRoute(props.id);
  }
  return (
    <a
      href={`#/${props.id}`}
      class="flex min-h-[36px] items-center rounded-control px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
      classList={{
        "bg-mid font-medium text-ink": active(),
        "text-body hover:bg-panel-2 hover:text-ink": !active(),
      }}
      aria-current={active() ? "page" : undefined}
      onClick={go}
      data-route={props.id}
    >
      {props.label}
    </a>
  );
}

// === Sidebar ===============================================================
function Sidebar() {
  const { snapshot } = useStore();
  const project = () => snapshot()?.project?.root || "";
  return (
    <aside class="flex w-60 shrink-0 flex-col border-r border-line bg-canvas">
      <div class="border-b border-line px-4 py-3">
        <div class="text-sm font-bold tracking-wide text-ink">
          climier<span class="text-progress"> ui</span>
        </div>
        <div class="mono mt-1 truncate text-[11px] text-mute" title={project() || ""}>
          {project() || "…"}
        </div>
      </div>
      <nav class="flex-1 space-y-4 overflow-y-auto p-2" aria-label="Primary">
        <For each={NAV_GROUPS}>
          {(group) => (
            <div class="space-y-0.5">
              <div
                class="mono px-3 py-1 text-[11px] uppercase tracking-wider text-mute"
                id={`nav-group-${group.label.toLowerCase()}`}
              >
                {group.label}
              </div>
              <For each={group.ids}>
                {(id) => <NavButton id={id} label={ROUTES[id].label} />}
              </For>
            </div>
          )}
        </For>
      </nav>
      <div class="border-t border-line px-4 py-2 text-[11px] leading-4 text-mute">
        Read-only projection · CLI stays the source of truth
      </div>
    </aside>
  );
}

// === Main area =============================================================
// Resolves the current route, wraps it in the right shell state, and
// renders the route's component. The `unknownRaw` memo re-reads the hash so
// the AlertBanner can flag URLs that don't match the registry without
// needing a second store signal.
function Main() {
  const { route, snapshot, initialLoading, snapshotError, lastSuccessfulAt, refreshing, reload } = useStore();
  const initialized = () => snapshot()?.project?.initialized !== false;

  // Track route changes so the memo re-runs when the user navigates; the
  // hash is re-parsed on each run so back/forward + external edits both
  // surface the unknown-route banner.
  const unknownRaw = createMemo(() => {
    route();
    if (typeof window === "undefined") return "";
    const parsed = parseHashRoute(window.location.hash);
    return parsed.unknown ? parsed.raw : "";
  });

  // Pick the route component. Unknown ids already fall back to DEFAULT_ROUTE
  // in the store; this is a defensive second guard.
  const RouteComponent = createMemo(() => {
    const meta = ROUTES[route()];
    return (meta ? meta.component : ROUTES[DEFAULT_ROUTE].component);
  });

  return (
    <main class="min-w-0 flex-1 overflow-hidden" data-route={route()}>
      {/* Background error from the last poll: keep the snapshot on screen
          and surface a dismissible banner above the route. */}
      <Show when={snapshotError() && snapshot()}>
        <div class="px-6 pt-4">
          <AlertBanner
            tone="error"
            title="Background refresh failed"
            onDismiss={reload}
          >
            <span class="mono text-[12px]">{snapshotError()}</span>
            <span class="ml-2 text-mute">Showing the last good snapshot. Retry to refresh.</span>
          </AlertBanner>
        </div>
      </Show>

      {/* Unknown-route banner. Re-parses the hash so any URL the store's
          `route` signal had to fall back from surfaces here. */}
      <Show when={unknownRaw()}>
        <div class="px-6 pt-4">
          <AlertBanner tone="warning" title="Unknown route">
            The URL hash <code class="mono">#{unknownRaw()}</code> doesn't match any known view.
            Showing <strong>Overview</strong> as a safe default.
          </AlertBanner>
        </div>
      </Show>

      <Show
        when={!initialLoading() && snapshot()}
        fallback={
          <div class="h-full overflow-auto p-6" aria-busy="true">
            <Skeleton rows={1} class="mb-4" />
            <Skeleton rows={3} />
          </div>
        }
      >
        <Show
          when={initialized()}
          fallback={<UninitializedPanel />}
        >
          <RouteView Component={RouteComponent()} route={route()} />
        </Show>
      </Show>

      <div class="pointer-events-none fixed bottom-3 right-4">
        <div class="pointer-events-auto rounded-control border border-line bg-panel/95 px-3 py-1.5 shadow-sm backdrop-blur-[2px]">
          <LiveStatus
            lastAt={lastSuccessfulAt()}
            refreshing={refreshing()}
            error={snapshotError()}
          />
        </div>
      </div>
    </main>
  );
}

// === RouteView =============================================================
// Mounts the route's component. Wrapped in a div that owns the scroll so
// the route views don't need to repeat `h-full overflow-auto`.
function RouteView(props) {
  const C = props.Component;
  return (
    <div class="h-full overflow-auto" data-view={props.route}>
      <C />
    </div>
  );
}

// === UninitializedPanel ====================================================
// Rendered as the main content (not a side banner) when the project has no
// state file yet. Shows the CLI init command as text — the UI never runs
// mutations against the project.
function UninitializedPanel() {
  const { snapshot, reload } = useStore();
  const root = () => snapshot()?.project?.root || "this directory";
  return (
    <div class="h-full overflow-auto p-6">
      <div class="mx-auto max-w-2xl">
        <PageHeader
          eyebrow="Climier"
          title="Project not initialized"
          subtitle="This directory has no climier state file yet. The UI is read-only; bootstrap the state from the CLI."
          right={
            <button
              type="button"
              class="inline-flex min-h-[36px] items-center rounded-control border border-line bg-panel-2 px-3 text-[12px] text-body hover:bg-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
              onClick={reload}
              aria-label="Re-check project state"
            >
              Re-check
            </button>
          }
        />
        <div class="mt-6">
          <Panel title="Bootstrap from the CLI" tone="info">
            <p class="text-[14px] leading-5 text-body">
              Run this command in the project root:
            </p>
            <pre class="mono mt-3 overflow-x-auto rounded-control border border-line bg-mid px-3 py-2 text-[13px] leading-5 text-ink">climier init</pre>
            <p class="mt-3 text-[12px] leading-4 text-mute">
              Root: <span class="mono">{root()}</span>. The UI never initializes the
              project for you — it stays read-only. Refresh after running the
              command and the dashboard will populate.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}

// === App ===================================================================
// Root layout. The store provider wraps everything so the route sync, the
// sidebar, and the main area all share the same reactive context.
export default function App() {
  return (
    <StoreProvider>
      <RouteSync />
      <div class="flex h-full min-h-0">
        <Sidebar />
        <Main />
        <NodeDetail />
      </div>
    </StoreProvider>
  );
}
