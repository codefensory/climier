// ui/src/App.jsx
//
// Shell + routing for the climier UI. Phase 3 / F3b + F3c of
// docs/ui-redesign-plan.md (section 6 — Fase 3, section 4 — Layout,
// and "Estados de datos").
//
// Scope of this file:
//   - Route registry (id -> component + label + group). The single source of
//     truth for what the dashboard can render. Replaces the nested
//     `SwitchRoute` from the pre-redesign shell.
//   - Hash-based routing without a router. `location.hash` is the URL state.
//     Back/forward and refresh both work because the hash is read on mount
//     and on every `hashchange` / `popstate` event.
//   - Grouped sidebar nav (Monitor / Work / Context / History) with
//     `aria-current="page"` on the active item.
//   - Responsive shell (F3c): breakpoint math lives in ui/src/shell.mjs
//     (pure, testable). WIDE ≥1280 renders the full 240 px sidebar with
//     labels; MID 768–1279 collapses to a 64–72 px rail with glyphs; NARROW
//     <768 hides the sidebar and exposes the same nav through a drawer
//     toggled from the header.
//   - Header with the current page title and project root on every breakpoint.
//     LiveStatus is shown once in the floating shell indicator.
//   - Data states per ui/DESIGN.md §5: initial load skeleton, non-blocking
//     refresh indicator, initial error screen with Retry, subsequent error
//     as a banner that keeps the last good snapshot on screen.
//   - Main area handles three project states — loading, error, uninitialized
//     — before resolving the route. Unknown routes fall back to Overview
//     with an AlertBanner instead of silently landing in Activity (the
//     pre-Phase-3 bug).
//   - Uninitialized projects render as the main content with the CLI init
//     command shown as text. The UI never mutates the state file.
//   - Layout: 100dvh, min-h-0 chain, exactly one scroll owner per view
//     (the RouteView wrapper). No nested scrollers.
//
// Out of scope here:
//   - NodeDetail still renders as a fixed overlay on top of the shell; it
//     uses the store's `selectedId` and is independent of the route.
//   - Board column min-width / horizontal scroll at MID is the Board view's
//     responsibility (Fase 5A), not the shell's.

import { Show, For, onMount, onCleanup, createMemo, createSignal, createEffect } from "solid-js";
import { Dynamic } from "solid-js/web";
import { StoreProvider, useStore } from "./store.jsx";
import Overview from "./views/Overview.jsx";
import Board from "./views/Board.jsx";
import Nodes from "./views/Nodes.jsx"; // Tasks view; the file keeps the name
import Gates from "./views/Gates.jsx";
import Knowledge from "./views/Knowledge.jsx";
import Activity from "./views/Activity.jsx";
import NodeDetail from "./views/NodeDetail.jsx";
import Finder from "./views/Finder.jsx";
import {
  PageHeader,
  Panel,
  AlertBanner,
  Skeleton,
  LiveStatus,
  IconButton,
  fmtTime,
} from "./components.jsx";
import {
  ROUTE_META,
  DEFAULT_ROUTE,
  NAV_GROUPS,
  parseHashRoute,
  writeHashRoute,
} from "./routes.mjs";
import {
  BREAKPOINT,
  classifyWidth,
  sidebarWidthPx,
  drawerAvailable,
  railGlyph,
  stateReadAlert,
} from "./shell.mjs";

// Glue the pure metadata (ui/src/routes.mjs) to the view components. The
// metadata is the testable source of truth; this map is the rendering
// bridge. Every id in ROUTE_META must have an entry here.
const ROUTE_COMPONENTS = {
  overview:  Overview,
  board:     Board,
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

// Small inline icons keep the shell crisp without adding an icon dependency.
// The same outline language works in the labelled sidebar and the compact rail.
const NAV_ICON_PATHS = {
  overview: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z",
  board: "M4 4h4v16H4z M10 4h4v16h-4z M16 4h4v16h-4z",
  tasks: "m5 12 4 4L19 6 M4 4h16v16H4z",
  gates: "M5 4v16 M5 5h11l-2.5 4L16 13H5",
  knowledge: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 0 4 22z M4 5.5v14A2.5 2.5 0 0 1 6.5 17H20",
  activity: "M3 12h4l2-7 4 14 2-7h6",
};

function NavIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={NAV_ICON_PATHS[props.id] || NAV_ICON_PATHS.overview} />
    </svg>
  );
}

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
//
// Two render variants:
//   - full (showLabel=true): label text next to an inline outline icon.
//   - rail (showLabel=false): centered icon with the label as the accessible
//     name and tooltip.
function NavButton(props) {
  // id          (string, required — must be a key of ROUTES)
  // label       (string, required)
  // glyph       (string, optional — rail abbreviation)
  // showLabel   (bool, default true)
  // onNavigate  (function, optional — called after an in-app navigation)
  const { route, setRoute } = useStore();
  const active = () => route() === props.id;
  const rail = props.showLabel === false;
  function go(e) {
    // Let the browser handle modifier-clicks (open in new tab, etc.).
    if (e.defaultPrevented) return;
    if (e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (!ROUTES[props.id]) return;
    setRoute(props.id);
    writeHashRoute(props.id);
    props.onNavigate?.();
  }
  return (
    <a
      href={`#/${props.id}`}
      class={`ui-nav-link flex min-h-[36px] items-center rounded-control transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 ${
        rail ? "justify-center" : "gap-3 px-3"
      }`}
      classList={{
        "bg-mid font-medium text-ink": active(),
        "text-body hover:bg-panel-2 hover:text-ink": !active(),
      }}
      aria-current={active() ? "page" : undefined}
      aria-label={rail ? props.label : undefined}
      title={rail ? props.label : undefined}
      onClick={go}
      data-route={props.id}
    >
      <span class="ui-nav-glyph" aria-hidden="true">
        <NavIcon id={props.id} />
      </span>
      <Show when={!rail}>{props.label}</Show>
    </a>
  );
}

// === NavGroups =============================================================
// Renders the grouped nav from routes.mjs in the order NAV_GROUPS declares.
// variant "rail" hides labels and group headers (MID breakpoint); any other
// variant renders the full labelled list (WIDE sidebar and NARROW drawer).
// Icons stay visible in both variants so navigation remains scannable.
function NavGroups(props) {
  // variant     ("full" | "rail")
  // onNavigate  (function, optional — forwarded to NavButton)
  const rail = props.variant === "rail";
  return (
    <For each={NAV_GROUPS}>
      {(group) => (
        <div class="ui-nav-group space-y-0.5">
          <Show when={!rail}>
            <div
              class="ui-nav-group-label mono"
              id={`nav-group-${group.label.toLowerCase()}`}
            >
              {group.label}
            </div>
          </Show>
          <For each={group.ids}>
            {(id) => (
              <NavButton
                id={id}
                label={ROUTES[id].label}
                glyph={railGlyph(id)}
                showLabel={!rail}
                onNavigate={props.onNavigate}
              />
            )}
          </For>
        </div>
      )}
    </For>
  );
}

// === Header ================================================================
// The current page title is the primary header identity on every breakpoint;
// the project root remains as supporting context. The global LiveStatus
// indicator is rendered once by Main as a floating chip.
function Header(props) {
  // bp           (signal, required — current breakpoint)
  // drawerOpen   (signal, required — reflects the NARROW drawer state)
  // onOpenDrawer (function, required — opens the NARROW drawer)
  const { snapshot, route } = useStore();
  const showMenu = () => drawerAvailable(props.bp());
  const project = () => snapshot()?.project || {};
  const pageTitle = () => ROUTES[route()]?.label || "Overview";
  const root = () => project().root || "";
  function openFinder() {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new window.Event("climier:open-finder"));
    }
  }
  return (
    <header class="ui-shell-topbar flex h-14 shrink-0 items-center gap-3 border-b border-line bg-canvas px-4 md:px-5">
      <Show when={showMenu()}>
        <button
          type="button"
          class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-control border border-line bg-panel text-body hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
          onClick={props.onOpenDrawer}
          aria-label="Open navigation"
          aria-expanded={props.drawerOpen()}
        >
          <span aria-hidden="true" class="text-[16px] leading-none">☰</span>
        </button>
      </Show>
      <div class="flex min-w-0 items-center gap-2">
        <span class="ui-brand-mark" aria-hidden="true">C</span>
        <h1 class="ui-brand min-w-0 truncate text-section font-semibold text-ink" title={pageTitle()}>
          {pageTitle()}
        </h1>
      </div>
      <span class="ui-topbar-project mono hidden min-w-0 truncate md:flex" title={root()}>
        {root() || "Local project"}
      </span>
      <div class="ml-auto flex shrink-0 items-center gap-2">
        <button type="button" class="ui-search-trigger" onClick={openFinder} aria-label="Search tasks, gates and knowledge">
          <span class="ui-search-trigger-icon" aria-hidden="true">⌕</span>
          <span>Quick find</span>
          <kbd aria-hidden="true">⌘ K</kbd>
        </button>
        <span class="ui-readonly-chip" aria-label="Read-only mode">Read-only</span>
      </div>
    </header>
  );
}

// === Sidebar ===============================================================
// Responsive permanent navigation:
//   - WIDE:  full 240 px sidebar with brand, group headers, labelled links.
//   - MID:   72 px rail with outline icons; labels + headers hidden, the
//     label moves to title/aria-label.
//   - NARROW: hidden; the drawer (see below) carries the same nav.
// The pixel width comes from shell.mjs (sidebarWidthPx) so the geometry
// stays testable; only the display toggle lives in JSX.
function Sidebar(props) {
  // bp (signal, required)
  const bp = props.bp;
  const narrow = () => bp() === BREAKPOINT.NARROW;
  const rail = () => bp() === BREAKPOINT.MID;
  const display = () => (narrow() ? "hidden" : "flex");
  const width = () => `${sidebarWidthPx(bp())}px`;
  return (
    <aside
      class={`ui-sidebar ${display()} ${rail() ? "ui-sidebar-rail" : ""} shrink-0 flex-col border-r border-line bg-canvas`}
      style={{ width: width() }}
    >
      <div class="flex h-14 shrink-0 items-center border-b border-line px-4">
        <div class="ui-workspace-switcher w-full" title="climier ui">
          <span class="ui-brand-mark" aria-hidden="true">C</span>
          <Show when={!rail()}>
            <span class="min-w-0">
              <span class="ui-workspace-switcher-label">Workspace</span>
              <span class="ui-workspace-switcher-name">climier ui</span>
            </span>
            <span class="ui-workspace-switcher-arrow" aria-hidden="true">⌄</span>
          </Show>
        </div>
      </div>
      <nav class="flex-1 space-y-4 overflow-y-auto p-2" aria-label="Primary">
        <NavGroups variant={rail() ? "rail" : "full"} />
      </nav>
    </aside>
  );
}

// === Drawer ================================================================
// NARROW-only overlay navigation. Mounted on demand; focuses the panel,
// locks body scroll, closes on Escape or backdrop click. Nav items close the
// drawer after navigating (onNavigate).
function Drawer(props) {
  // open    (signal, required)
  // onClose (function, required)
  // Keep the shell mounted for the short exit animation. This is deliberately
  // local presence state rather than a dependency: the drawer still owns no
  // application state and closes through the same callback as before.
  const [present, setPresent] = createSignal(false);
  const [closing, setClosing] = createSignal(false);

  createEffect(() => {
    if (props.open()) {
      setPresent(true);
      setClosing(false);
    } else if (present()) {
      setClosing(true);
    }
  });

  function requestClose() {
    if (!props.open()) return;
    setClosing(true);
    props.onClose();
  }

  function finishClose(e) {
    if (
      e.target !== e.currentTarget ||
      e.animationName !== "ui-drawer-nav-out" ||
      !closing()
    ) return;
    setPresent(false);
    setClosing(false);
  }

  return (
    <Show when={props.open() || present()}>
      <DrawerPanel
        onClose={requestClose}
        closing={closing}
        onAnimationEnd={finishClose}
      />
    </Show>
  );
}

function DrawerPanel(props) {
  let panelRef;
  onMount(() => {
    panelRef?.focus();
    document.body.style.overflow = "hidden";
    const onKey = (e) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    });
  });
  return (
    <div class="fixed inset-0 z-40 flex" role="dialog" aria-modal="true" aria-label="Navigation">
      <div
        class="ui-drawer-scrim absolute inset-0"
        classList={{ "ui-drawer-scrim--closing": props.closing() }}
        onClick={props.onClose}
        aria-hidden="true"
      />
      <aside
        ref={panelRef}
        tabIndex={-1}
        class="ui-drawer ui-drawer-nav relative z-10 flex h-full w-72 max-w-[85vw] flex-col rounded-r-[18px] border-r border-line bg-canvas shadow-md outline-none"
        classList={{ "ui-drawer-nav--closing": props.closing() }}
        onAnimationEnd={props.onAnimationEnd}
      >
        <div class="ui-drawer-topbar flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
          <div class="flex items-center gap-2 text-sm font-bold tracking-wide text-ink">
            <span class="ui-brand-mark" aria-hidden="true">C</span>
            <span class="ui-brand">climier<span class="text-progress"> ui</span></span>
          </div>
          <IconButton label="Close navigation" onClick={props.onClose}>
            ✕
          </IconButton>
        </div>
        <nav class="flex-1 space-y-4 overflow-y-auto p-2" aria-label="Primary">
          <NavGroups variant="full" onNavigate={props.onClose} />
        </nav>
      </aside>
    </div>
  );
}

// === Main area =============================================================
// Resolves the current route, wraps it in the right shell state, and
// renders the route's component. The `unknownRaw` memo re-reads the hash so
// the AlertBanner can flag URLs that don't match the registry without
// needing a second store signal.
//
// Scroll contract (ui/DESIGN.md §3.1): Main is a flex column with
// min-h-0 + overflow-hidden; banners are shrink-0; the route area is the
// single flex-1 min-h-0 scroll owner (RouteView). No nested scrollers.
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

  // State-read-error is a shell-level alert: the server keeps serving the
  // last good snapshot but tags it with a state-read-error alert. Surface it
  // as one high-priority banner above the route so it is visible from every
  // view (the Overview page filters the kind from its own alert groups to
  // avoid duplicating it).
  const stateReadError = createMemo(() => stateReadAlert(snapshot()?.alerts));

  // Pick the route component. Unknown ids already fall back to DEFAULT_ROUTE
  // in the store; this is a defensive second guard.
  const RouteComponent = createMemo(() => {
    const meta = ROUTES[route()];
    return (meta ? meta.component : ROUTES[DEFAULT_ROUTE].component);
  });

  return (
    <main class="ui-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-route={route()}>
      {/* State read error — the highest-priority banner. The server is
          serving a stale snapshot because the state file is unreadable.
          Shown on every view, above both the route and the background
          refresh banner. */}
      <Show when={stateReadError()}>
        <div class="shrink-0 px-4 pt-3 md:px-6">
          <AlertBanner tone="error" title="State read error">
            <span class="mono text-[12px]">{stateReadError().message}</span>
            <span class="ml-2 text-mute">
              Showing the last good snapshot. Fix the state file, or re-initialize from the CLI
              (<span class="mono">climier init --force</span>).
            </span>
          </AlertBanner>
        </div>
      </Show>

      {/* Background error from the last poll: keep the snapshot on screen
          and surface a dismissible banner above the route. The nav lives
          outside Main, so it never disappears on a later error. */}
      <Show when={snapshotError() && snapshot()}>
        <div class="shrink-0 px-4 pt-3 md:px-6">
          <AlertBanner
            tone="error"
            title="Background refresh failed"
            onDismiss={reload}
          >
            <span class="mono text-[12px]">{snapshotError()}</span>
            <span class="ml-2 text-mute">
              Showing the last good snapshot{lastSuccessfulAt() ? ` from ${fmtTime(lastSuccessfulAt())}` : ""}. Retry to refresh.
            </span>
          </AlertBanner>
        </div>
      </Show>

      {/* Unknown-route banner. Re-parses the hash so any URL the store's
          `route` signal had to fall back from surfaces here. */}
      <Show when={unknownRaw()}>
        <div class="shrink-0 px-4 pt-3 md:px-6">
          <AlertBanner tone="warning" title="Unknown route">
            The URL hash <code class="mono">#{unknownRaw()}</code> doesn't match any known view.
            Showing <strong>Overview</strong> as a safe default.
          </AlertBanner>
        </div>
      </Show>

      <div class="min-h-0 flex-1">
        <Show
          when={!initialLoading() && snapshot()}
          fallback={<InitialState />}
        >
          <Show
            when={initialized()}
            fallback={<UninitializedPanel />}
          >
            <RouteView Component={RouteComponent()} route={route()} />
          </Show>
        </Show>
      </div>

      {/* Non-blocking refresh indicator: a floating chip that stays visible
          while the user scrolls the route content. */}
      <div class="pointer-events-none fixed bottom-3 right-4">
        <div class="ui-live-chip pointer-events-auto rounded-control border border-line bg-panel/95 px-3 py-1.5 shadow-sm backdrop-blur-[2px]">
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

// === InitialState ==========================================================
// Covers the two pre-snapshot states: initial load skeleton and initial
// error screen with Retry. Never shows a stale/empty view before the first
// good snapshot lands.
function InitialState() {
  const { initialLoading, snapshotError, reload } = useStore();
  return (
    <div class="h-full overflow-auto p-4 md:p-6" aria-busy={initialLoading()}>
      <Show
        when={initialLoading()}
        fallback={<InitialError message={snapshotError()} onRetry={reload} />}
      >
        <Skeleton rows={1} class="mb-4" />
        <Skeleton rows={3} />
      </Show>
    </div>
  );
}

// === InitialError ==========================================================
// Full error screen (ui/DESIGN.md §5 state 3). No cached data fallback —
// there is no snapshot yet, so the only recovery is Retry.
function InitialError(props) {
  return (
    <div class="flex min-h-full items-center justify-center">
      <div class="w-full max-w-xl">
        <Panel tone="error" padding="loose">
          <div class="flex items-center gap-2">
            <span class="h-2 w-2 shrink-0 rounded-full bg-blocked" aria-hidden="true" />
            <h2 class="text-section font-semibold text-ink">Couldn't load the project snapshot</h2>
          </div>
          <p class="mt-2 text-[13px] leading-5 text-body">
            The UI couldn't reach the climier API. Check that the dev server is running
            (<span class="mono">npm run dev:api</span>) and try again.
          </p>
          <Show when={props.message}>
            <div class="mono mt-3 break-words rounded-control border border-line bg-mid px-3 py-2 text-[12px] leading-5 text-body">
              {props.message}
            </div>
          </Show>
          <div class="mt-4">
            <button
              type="button"
              class="inline-flex min-h-[36px] items-center rounded-control border border-line bg-panel px-4 text-[13px] font-medium text-ink hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
              onClick={props.onRetry}
            >
              Retry
            </button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

// === RouteView =============================================================
// Mounts the route's component. Wrapped in a div that owns the scroll so
// the route views don't need to repeat `h-full overflow-auto`. Dynamic is
// intentional: Component is a reactive prop and capturing it in a local
// constant would mount the initial view once without switching on navigation.
function RouteView(props) {
  return (
    <div class="h-full overflow-auto" data-view={props.route}>
      <Dynamic component={props.Component} />
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
    <div class="h-full overflow-auto p-4 md:p-6">
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
// sidebar, the header, and the main area all share the same reactive
// context. 100dvh + min-h-0: the shell owns the viewport height and each
// route owns its scroll.
export default function App() {
  const [bp, setBp] = createSignal(BREAKPOINT.WIDE);
  const [drawerOpen, setDrawerOpen] = createSignal(false);

  onMount(() => {
    const update = () => {
      const next = classifyWidth(window.innerWidth);
      setBp(next);
      // A drawer open on NARROW has nowhere to live once the user resizes
      // up; close it so it can't linger as an invisible overlay.
      if (!drawerAvailable(next)) setDrawerOpen(false);
    };
    update();
    window.addEventListener("resize", update);
    onCleanup(() => window.removeEventListener("resize", update));
  });

  return (
    <StoreProvider>
      <RouteSync />
      <div class="ui-shell flex h-dvh min-h-0 bg-canvas text-body">
        <Sidebar bp={bp} />
        <div class="flex min-w-0 flex-1 flex-col">
          <Header
            bp={bp}
            drawerOpen={drawerOpen}
            onOpenDrawer={() => setDrawerOpen(true)}
          />
          <Main />
        </div>
        <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
        <NodeDetail />
        <Finder />
      </div>
    </StoreProvider>
  );
}
