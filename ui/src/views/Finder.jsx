// ui/src/views/Finder.jsx
//
// Global search overlay (Fase 7, pieza F7b — T-ui-finder).
//
// Scope:
//   1. Uses GET /api/search (ui/src/api.js `search`, with AbortSignal) and
//      renders results grouped in the endpoint's contract order: Tasks,
//      Gates, Knowledge.
//   2. Shortcut `/` (when not typing in an editable field) or Ctrl/Cmd+K
//      opens; Escape closes; ArrowUp/ArrowDown move between results; Enter
//      or click opens NodeDetail via store.select(id).
//   3. Accessible overlay: role=dialog + aria-modal, initial focus on the
//      input, focus returned to the previously focused element on close.
//   4. No new dependencies; reuses shared primitives from components.jsx.
//
// The default export wires the store + api (and owns the window keydown
// listener). FinderDialog is the presentational markup, exported so the
// test suite can render it with literal props (mirrors NodeDetail's
// DetailBody split).
//
// Keyboard model: the input is a combobox with aria-activedescendant; the
// result list is a listbox where each row is a button with role=option and
// tabindex=-1 (Tab skips rows — navigation happens with arrows). Enter
// opens the active row. This keeps the input as the single focus anchor
// while the list stays clickable.

import { Show, For, createSignal, createMemo, onMount, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { useStore } from "../store.jsx";
import { search } from "../api.js";
import { AlertBanner, EmptyState, IconButton, KindBadge, StatusBadge } from "../components.jsx";

// Fixed group order — matches /api/search's payload keys. The finder never
// guesses new kinds; unknown keys are simply not rendered.
export const SEARCH_GROUPS = [
  { key: "tasks",     label: "Tasks" },
  { key: "gates",     label: "Gates" },
  { key: "knowledge", label: "Knowledge" },
];

// === Pure helpers (exported for tests) ======================================
// The interaction contract lives here, testable without DOM.

// Is the event target somewhere the user is typing? `/` must not hijack
// quick-find/URL bars or inputs.
export function isEditableTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

// Should this keydown open the finder? `/` only when the user is not typing;
// Ctrl/Cmd+K always (it is a command, not a character).
export function shouldOpen(e) {
  if (!e) return false;
  if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) return true;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return e.key === "/" && !isEditableTarget(e.target);
}

// Group the /api/search payload into the fixed order, skipping empty groups.
// Each item gets a sequential flat `index` (1-based) used both for keyboard
// navigation and for the aria-activedescendant ids (finder-opt-<index>).
export function groupedResults(results) {
  const out = [];
  let idx = 0;
  for (const g of SEARCH_GROUPS) {
    const items = (results && results[g.key]) || [];
    if (!items.length) continue;
    out.push({
      key: g.key,
      label: g.label,
      items: items.map((node) => ({ node, index: ++idx })),
    });
  }
  return out;
}

// Flatten grouped results into a navigable row list. Headers are not
// navigable (index -1); items carry their flat index. Used by arrow-key
// navigation; the render path uses groupedResults directly.
export function flattenResults(results) {
  const rows = [];
  for (const g of groupedResults(results)) {
    rows.push({ kind: "header", group: g.key, label: g.label, index: -1 });
    for (const it of g.items) {
      rows.push({ kind: "item", group: g.key, label: g.label, node: it.node, index: it.index });
    }
  }
  return rows;
}

// Next navigable item index from `current`, moving by `dir` (+1/-1), wrapping
// at both ends. Returns -1 when there are no items. Headers are skipped.
export function nextItemIndex(rows, current, dir) {
  const items = rows.filter((r) => r.kind === "item");
  if (!items.length) return -1;
  const pos = items.findIndex((r) => r.index === current);
  let next;
  if (pos === -1) {
    next = dir > 0 ? 0 : items.length - 1;
  } else {
    next = pos + (dir > 0 ? 1 : -1);
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
  }
  return items[next].index;
}

// === FinderDialog (presentational) =========================================
// Renders the overlay given state + callbacks. No signals here: props are
// plain values so SSR tests can render it with literal fixtures.

export function FinderDialog(props) {
  // query     (string)
  // results   (null | { tasks, gates, knowledge })
  // active    (number, flat item index; -1 = none)
  // loading   (bool)
  // error     (string | null)
  // onQuery   (string -> void)
  // onClose   (-> void)
  // onOpen    (id -> void)  — opens NodeDetail for a node
  // inputRef  (ref)
  // listRef   (ref)
  const groups = () => groupedResults(props.results);
  const itemCount = () =>
    groups().reduce((sum, g) => sum + g.items.length, 0);
  const hasQuery = () => Boolean(props.query && String(props.query).trim());

  // The dialog must be reachable in SSR tests (no DOM to portal into) and
  // in the browser (portal above the app's stacking context).
  const isServer = typeof document === "undefined";
  const dialog = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search"
      class="fixed left-1/2 top-[12vh] z-50 w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-card border border-line bg-canvas shadow-md"
    >
      {/* Input row */}
      <div class="flex items-center gap-2 border-b border-line px-3 py-2">
        <span class="text-mute" aria-hidden="true">⌕</span>
        <input
          ref={props.inputRef}
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls="finder-listbox"
          aria-activedescendant={props.active > 0 ? `finder-opt-${props.active}` : undefined}
          aria-label="Search tasks, gates and knowledge"
          placeholder="Search tasks, gates and knowledge…"
          value={props.query || ""}
          onInput={(e) => props.onQuery(e.currentTarget.value)}
          class="h-11 min-w-0 flex-1 rounded-control bg-transparent text-[14px] leading-5 text-ink outline-none placeholder:text-mute"
        />
        <Show when={hasQuery()}>
          <IconButton size="sm" label="Clear search" onClick={() => { props.onQuery(""); props.inputRef?.focus(); }}>
            <span aria-hidden="true">✕</span>
          </IconButton>
        </Show>
        <IconButton size="sm" label="Close search" onClick={props.onClose}>
          <span aria-hidden="true">Esc</span>
        </IconButton>
      </div>

      {/* Body: results / states */}
      <div class="max-h-[55vh] overflow-y-auto p-2">
        <Show when={!hasQuery() && !props.loading} fallback={
          <Show when={props.error} fallback={
            <Show when={props.loading} fallback={
              <Show when={itemCount() > 0} fallback={
                <EmptyState variant="compact" title="No results" />
              }>
                <div id="finder-listbox" role="listbox" aria-label="Results" ref={props.listRef}>
                  <For each={groups()}>
                    {(group) => (
                      <div role="group" aria-label={group.label}>
                        <div class="mono px-2 py-1 text-[11px] uppercase tracking-wider text-mute">
                          {group.label}
                        </div>
                        <For each={group.items}>
                          {(it) => (
                            <button
                              type="button"
                              role="option"
                              id={`finder-opt-${it.index}`}
                              tabindex="-1"
                              aria-selected={props.active === it.index}
                              onClick={() => props.onOpen(it.node.id)}
                              class="flex min-h-[36px] w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
                              classList={{
                                "bg-panel-2": props.active === it.index,
                                "hover:bg-panel-2": true,
                              }}
                            >
                              <span class="mono shrink-0 text-[12px] text-body">{it.node.id}</span>
                              <span class="min-w-0 flex-1 truncate text-[13px] leading-5 text-ink" title={it.node.title}>
                                {it.node.title}
                              </span>
                              <StatusBadge status={it.node.status || it.node.derived_status || "open"} />
                              <KindBadge node={it.node} />
                            </button>
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            }>
              <div role="status" aria-live="polite" class="px-2 py-3 text-[12px] text-mute">
                Searching…
              </div>
            </Show>
          }>
            <AlertBanner tone="error" title="Search failed">
              {props.error}
            </AlertBanner>
          </Show>
        }>
          <div class="px-2 py-3 text-[13px] leading-5 text-body">
            Type to search tasks, gates and knowledge.
          </div>
        </Show>
      </div>

      {/* Footer hint */}
      <div class="flex items-center gap-3 border-t border-line bg-panel-2 px-4 py-2 text-[11px] text-mute">
        <span><span class="mono">↑↓</span> navigate</span>
        <span><span class="mono">Enter</span> open</span>
        <span><span class="mono">Esc</span> close</span>
        <span class="ml-auto hidden sm:inline"><span class="mono">/</span> or <span class="mono">Ctrl K</span> to reopen</span>
      </div>
    </div>
  );

  return (
    <Show when={isServer} fallback={
      <Portal>
        <div class="fixed inset-0 z-40 bg-ink/40" onClick={props.onClose} aria-hidden="true" />
        {dialog}
      </Portal>
    }>
      <div class="fixed inset-0 z-40 bg-ink/40" onClick={props.onClose} aria-hidden="true" />
      {dialog}
    </Show>
  );
}

// === Finder (default) =======================================================
// Owns open/query/results state, the debounced /api/search call, the window
// keydown listener and focus management.

const DEBOUNCE_MS = 150;

export default function Finder() {
  const { select } = useStore();
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal(null);
  const [active, setActive] = createSignal(-1);

  let inputRef;
  let listRef;
  let restoreFocusEl = null;
  let debounceTimer = null;
  let abort = null;
  let token = 0;

  const rows = createMemo(() => flattenResults(results()));

  function scrollActiveIntoView(index) {
    if (index < 0 || !listRef) return;
    const el = listRef.querySelector(`[id="finder-opt-${index}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }

  // Runs one search; stale responses are dropped via the token + abort.
  async function runSearch(q) {
    const myToken = ++token;
    abort?.abort();
    const controller = new AbortController();
    abort = controller;
    setError(null);
    if (!q.trim()) {
      setResults(null);
      setLoading(false);
      setActive(-1);
      return;
    }
    setLoading(true);
    try {
      const res = await search(q, false, { signal: controller.signal });
      if (myToken !== token) return;
      setResults(res);
      setLoading(false);
      setActive(nextItemIndex(flattenResults(res), -1, 1));
    } catch (e) {
      if (e && (e.name === "AbortError" || e.code === 20)) return;
      if (myToken !== token) return;
      setError(e && e.message ? e.message : "Search failed");
      setLoading(false);
    }
  }

  function handleQuery(v) {
    setQuery(v);
    clearTimeout(debounceTimer);
    abort?.abort();
    if (!v.trim()) {
      token++;
      setResults(null);
      setLoading(false);
      setActive(-1);
      setError(null);
      return;
    }
    debounceTimer = setTimeout(() => runSearch(v), DEBOUNCE_MS);
  }

  function resetState() {
    clearTimeout(debounceTimer);
    abort?.abort();
    token++;
    setQuery("");
    setResults(null);
    setLoading(false);
    setError(null);
    setActive(-1);
  }

  function openFinder() {
    if (typeof document !== "undefined") {
      restoreFocusEl = document.activeElement;
    }
    setOpen(true);
    queueMicrotask(() => inputRef?.focus());
  }

  function closeFinder() {
    setOpen(false);
    resetState();
    if (restoreFocusEl && typeof restoreFocusEl.focus === "function") {
      try { restoreFocusEl.focus(); } catch {}
    }
    restoreFocusEl = null;
  }

  function openResult(id) {
    closeFinder(); // restores focus first so NodeDetail captures the opener
    select(id);
  }

  function onGlobalKeyDown(e) {
    if (open()) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeFinder();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = nextItemIndex(rows(), active(), e.key === "ArrowDown" ? 1 : -1);
        setActive(next);
        scrollActiveIntoView(next);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const row = rows().find((r) => r.kind === "item" && r.index === active());
        if (row) openResult(row.node.id);
        return;
      }
      // Basic focus trap: input ⇄ close button. Rows are tabindex=-1 so Tab
      // never lands inside the list (navigation is arrow-key driven).
      if (e.key === "Tab") {
        const input = inputRef;
        if (!input || typeof document === "undefined") return;
        const closeBtn = document.querySelector('[aria-label="Close search"]');
        if (!closeBtn) return;
        if (e.shiftKey && document.activeElement === input) {
          e.preventDefault();
          closeBtn.focus();
        } else if (!e.shiftKey && document.activeElement === closeBtn) {
          e.preventDefault();
          input.focus();
        }
        return;
      }
      return;
    }
    if (shouldOpen(e)) {
      e.preventDefault();
      openFinder();
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onGlobalKeyDown);
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onGlobalKeyDown);
    clearTimeout(debounceTimer);
    abort?.abort();
  });

  return (
    <Show when={open()}>
      <FinderDialog
        query={query()}
        results={results()}
        active={active()}
        loading={loading()}
        error={error()}
        onQuery={handleQuery}
        onClose={closeFinder}
        onOpen={openResult}
        inputRef={inputRef}
        listRef={listRef}
      />
    </Show>
  );
}
