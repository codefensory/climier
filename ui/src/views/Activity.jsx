// Activity view — Fase 5D Track D.
//
// A11y pass (F7a, T-ui-a11y):
//   - Every interactive element is a real control: filter inputs/selects,
//     Refresh, pagination, and the per-row expand/collapse button all carry
//     the 36 px control floor, focus-visible rings, and accessible names.
//   - The row expand affordance is a dedicated <button> with aria-expanded —
//     never a clickable <tr> (unreachable by keyboard, mis-announced).
//   - Text colors use the design tokens (ink/body/mute) so secondary copy
//     meets the same AA floor as the rest of the app.
//   - Data states stay per ui/DESIGN.md §5: skeleton on initial load,
//     non-destructive error banner that keeps the previous results, no
//     flash of empty while loading.
//
// The row is extracted as `ActivityRow` (exported) so the keyboard contract
// is unit-testable without a DOM (see test/ui-a11y.test.mjs).

import { createSignal, Show, For, createEffect, onCleanup, createMemo } from "solid-js";
import { getActivity } from "../api.js";
import { useStore } from "../store.jsx";
import { fmtTime } from "../components.jsx";

const DEBOUNCE_MS = 280;
const PAGE_SIZES = [25, 50, 100, 200];

// Monotonic token used to discard stale responses. Combined with
// AbortController cancellation this guarantees that a slow earlier
// request can't clobber a newer one (typing fast, filter changes,
// pagination).
function nextToken() {
  nextToken.n = (nextToken.n || 0) + 1;
  return nextToken.n;
}

function isAbortError(err) {
  return err && (err.name === "AbortError" || err.code === 20);
}

function SkeletonRow() {
  return (
    <div class="flex gap-3 py-1.5">
      <div class="h-3 w-20 rounded bg-panel-2" />
      <div class="h-3 w-16 rounded bg-panel-2" />
      <div class="h-3 w-24 rounded bg-panel-2" />
      <div class="h-3 flex-1 rounded bg-panel-2" />
    </div>
  );
}

function Skeleton(props) {
  return (
    <div class="animate-pulse space-y-1 px-4 py-2" aria-busy="true" aria-live="polite" aria-label="Loading activity">
      <For each={Array.from({ length: props.rows || 8 })}>{() => <SkeletonRow />}</For>
    </div>
  );
}

function rowKey(e) {
  return `${e.ts || ""}::${e.action || ""}::${e.agent || ""}::${e.node_id || e.node || e.task || ""}`;
}

// === ActivityRow ===========================================================
// One log entry row. The expand/collapse affordance is a real <button> in
// its own cell (keyboard reachable, aria-expanded, accessible name). The
// node link is a separate real <button>. The <tr> itself is not clickable.

export function ActivityRow(props) {
  // entry    (object, required — normalized activity entry)
  // expanded (bool, required)
  // onToggle (function, required — toggle the expanded row)
  // onSelect (function, required — open a node detail)
  const e = () => props.entry || {};
  const nodeId = () => e().node_id || e().node || e().task || null;
  const label = () => e().node_title || nodeId() || "—";
  const showIdUnder = () => !!e().node_title && !!nodeId();
  const note = () => (e().note == null ? "" : String(e().note));
  return (
    <>
      <tr class="border-t border-line">
        <td class="px-2 py-1.5">
          <button
            type="button"
            class="inline-flex min-h-[36px] w-8 items-center justify-center rounded-control border border-line bg-panel text-body hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
            onClick={props.onToggle}
            aria-expanded={props.expanded}
            aria-label={props.expanded ? "Collapse full note" : "Expand full note"}
          >
            <span aria-hidden="true" class="text-[12px] leading-none">{props.expanded ? "▾" : "▸"}</span>
          </button>
        </td>
        <td class="mono whitespace-nowrap px-2 py-1.5 text-xs text-mute">{fmtTime(e().ts)}</td>
        <td class="mono px-2 py-1.5 text-xs text-progress">{e().action}</td>
        <td class="mono px-2 py-1.5 text-xs text-body">{e().agent}</td>
        <td class="px-2 py-1.5 align-top">
          <Show
            when={nodeId()}
            fallback={<span class="text-mute">—</span>}
          >
            <button
              type="button"
              class="block text-left leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
              onClick={() => props.onSelect(nodeId())}
              title={nodeId()}
            >
              <div class="text-xs font-medium text-progress">{label()}</div>
              <Show when={showIdUnder()}>
                <div class="mono text-[11px] text-mute">{nodeId()}</div>
              </Show>
            </button>
          </Show>
        </td>
        <td class="max-w-xl truncate px-4 py-1.5 text-xs text-body" title={note()}>
          {note()}
        </td>
      </tr>
      <Show when={props.expanded}>
        <tr class="border-t border-line bg-panel-2">
          <td colspan="6" class="px-4 py-2 text-xs text-body">
            <div class="mono mb-1 text-[11px] uppercase tracking-wider text-mute">Full note</div>
            <pre class="mono whitespace-pre-wrap break-words text-xs text-ink">{note() || "(empty)"}</pre>
          </td>
        </tr>
      </Show>
    </>
  );
}

const FILTER_INPUT_CLS =
  "min-h-[36px] rounded-control border border-line bg-panel px-3 text-[13px] text-body outline-none placeholder:text-mute focus:border-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";

const FILTER_SELECT_CLS =
  "min-h-[36px] rounded-control border border-line bg-panel px-2 text-[13px] text-body outline-none focus:border-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";

const BUTTON_CLS =
  "inline-flex min-h-[36px] items-center gap-2 rounded-control border border-line bg-panel px-3 text-[13px] text-body hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";

export default function Activity() {
  const { select } = useStore();

  // Inputs (raw) vs applied filters. `q` is the only debounced field
  // because it's keystroke-driven; the rest are explicit filter
  // changes (select / commit) and re-fetch immediately.
  const [q, setQ] = createSignal("");
  const [debouncedQ, setDebouncedQ] = createSignal("");
  const [initiative, setInitiative] = createSignal("");
  const [action, setAction] = createSignal("");
  const [agent, setAgent] = createSignal("");
  const [limit, setLimit] = createSignal(50);
  const [offset, setOffset] = createSignal(0);

  const [data, setData] = createSignal(null); // last successful payload
  const [error, setError] = createSignal(null);
  const [loading, setLoading] = createSignal(false);
  const [initialLoading, setInitialLoading] = createSignal(true);
  const [lastRefreshedAt, setLastRefreshedAt] = createSignal(null);
  const [expanded, setExpanded] = createSignal(new Set());

  let reqToken = 0;
  let abortCtrl = null;
  let debounceTimer = null;

  async function refresh() {
    const token = nextToken();
    reqToken = token;
    abortCtrl?.abort();
    const ctl = new AbortController();
    abortCtrl = ctl;
    setLoading(true);
    try {
      const params = {
        q: debouncedQ() || undefined,
        initiative: initiative() || undefined,
        action: action() || undefined,
        agent: agent() || undefined,
        limit: limit(),
        offset: offset(),
      };
      const r = await getActivity(params, { signal: ctl.signal });
      if (token !== reqToken) return; // stale
      setData(r);
      setError(null);
      setLastRefreshedAt(new Date().toISOString());
    } catch (e) {
      if (isAbortError(e)) return;
      if (token !== reqToken) return;
      setError(e.message || String(e));
    } finally {
      if (token === reqToken) {
        setLoading(false);
        setInitialLoading(false);
      }
    }
  }

  // Debounce only `q`. Resets offset so users land on the first page of
  // the new result set, not the same offset within a smaller total.
  createEffect(() => {
    const v = q();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      setDebouncedQ(v);
      setOffset(0);
    }, DEBOUNCE_MS);
  });

  // Re-fetch on any applied filter change. createEffect tracks the
  // dependencies by reading the signals, so it fires exactly when one
  // of them updates (including the debounced q landing).
  createEffect(() => {
    // touch reactive deps
    debouncedQ();
    initiative();
    action();
    agent();
    limit();
    offset();
    refresh();
  });

  onCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    abortCtrl?.abort();
  });

  const entries = () => data()?.entries || [];
  const facets = () => data()?.facets || { actions: [], agents: [] };
  const total = () => data()?.total || 0;

  // Pagination range. The endpoint orders entries most-recent-first and
  // `offset` skips the N oldest matching entries, so:
  //   offset=0, total=100, limit=25 -> 76..100
  //   offset=75, total=100, limit=25 -> 1..25
  // Empty state must read "0 of 0", never "1–0 of 0".
  const range = createMemo(() => {
    const t = total();
    if (t === 0) return { from: 0, to: 0 };
    const lim = limit();
    const off = offset();
    const to = Math.max(1, t - off);
    const from = Math.max(1, to - lim + 1);
    return { from, to };
  });

  function toggleExpand(key) {
    const s = new Set(expanded());
    if (s.has(key)) s.delete(key);
    else s.add(key);
    setExpanded(s);
  }

  const hasFilters = () => Boolean(debouncedQ() || initiative() || action() || agent());

  function clearFilters() {
    setQ("");
    setDebouncedQ("");
    setInitiative("");
    setAction("");
    setAgent("");
    setOffset(0);
  }

  return (
    <div class="flex h-full flex-col">
      <div class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <h1 class="mr-2 text-section font-semibold text-ink">
          Activity{" "}
          <span class="text-[12px] font-normal text-mute">({total()} entries)</span>
        </h1>
        <input
          class={`${FILTER_INPUT_CLS} w-48`}
          placeholder="Search (q)…"
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
          aria-label="Search activity"
        />
        <input
          class={`${FILTER_INPUT_CLS} w-36`}
          placeholder="Initiative…"
          value={initiative()}
          onChange={(e) => {
            setInitiative(e.currentTarget.value);
            setOffset(0);
          }}
          aria-label="Initiative filter"
        />
        <select
          class={FILTER_SELECT_CLS}
          value={action()}
          onChange={(e) => {
            setAction(e.currentTarget.value);
            setOffset(0);
          }}
          aria-label="Action filter"
        >
          <option value="">All actions</option>
          <For each={facets().actions}>
            {(a) => <option value={a.action}>{a.action} ({a.count})</option>}
          </For>
        </select>
        <select
          class={FILTER_SELECT_CLS}
          value={agent()}
          onChange={(e) => {
            setAgent(e.currentTarget.value);
            setOffset(0);
          }}
          aria-label="Agent filter"
        >
          <option value="">All agents</option>
          <For each={facets().agents}>
            {(a) => <option value={a.agent}>{a.agent} ({a.count})</option>}
          </For>
        </select>
        <label class="flex items-center gap-1.5 text-[12px] text-mute">
          page
          <select
            class={FILTER_SELECT_CLS}
            value={limit()}
            onChange={(e) => {
              setLimit(parseInt(e.currentTarget.value, 10) || 50);
              setOffset(0);
            }}
            aria-label="Page size"
          >
            <For each={PAGE_SIZES}>{(n) => <option value={n}>{n}</option>}</For>
          </select>
        </label>
        <button
          class={BUTTON_CLS}
          onClick={refresh}
          disabled={loading()}
          aria-label="Refresh activity"
        >
          <Show
            when={loading()}
            fallback={<span>Refresh</span>}
          >
            <span class="inline-block h-2 w-2 animate-pulse rounded-full bg-progress" aria-hidden="true" />
            <span>Refreshing…</span>
          </Show>
        </button>
        <Show when={lastRefreshedAt()}>
          <span class="mono text-[11px] text-mute">updated {fmtTime(lastRefreshedAt())}</span>
        </Show>
        <Show when={hasFilters()}>
          <button type="button" class={BUTTON_CLS} onClick={clearFilters}>
            Clear filters
          </button>
        </Show>
      </div>

      {/* Non-destructive error: keep last successful data, surface banner. */}
      <Show when={error() && data()}>
        <div class="border-b border-gate bg-gate-soft px-4 py-2 text-[12px] text-body" role="status">
          <span class="font-medium text-gate">Refresh failed: </span>
          {error()}. Showing previous results.
        </div>
      </Show>

      <div class="flex-1 overflow-auto">
        <Show when={initialLoading()}>
          <Skeleton rows={6} />
        </Show>
        <Show when={!initialLoading()}>
          <Show
            when={!error() || data()}
            fallback={
              <div class="p-6 text-[13px] text-blocked">Failed to load activity: {error()}</div>
            }
          >
            <Show
              when={entries().length}
              fallback={
                <div class="p-6 text-[13px] text-mute">
                  No log entries match.
                  <Show when={hasFilters()}>
                    <button
                      type="button"
                      class={`${BUTTON_CLS} ml-3`}
                      onClick={clearFilters}
                    >
                      Clear filters
                    </button>
                  </Show>
                </div>
              }
            >
              <table class="w-full text-sm">
                <thead class="sticky top-0 bg-canvas">
                  <tr class="text-left text-[11px] uppercase tracking-wider text-mute">
                    <th class="px-2 py-2">
                      <span class="sr-only">Expand</span>
                    </th>
                    <th class="px-2 py-2">When</th>
                    <th class="px-2 py-2">Action</th>
                    <th class="px-2 py-2">Agent</th>
                    <th class="px-2 py-2">Node</th>
                    <th class="px-4 py-2">Note</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={entries()}>
                    {(e) => {
                      const key = rowKey(e);
                      const isOpen = () => expanded().has(key);
                      return (
                        <ActivityRow
                          entry={e}
                          expanded={isOpen()}
                          onToggle={() => toggleExpand(key)}
                          onSelect={select}
                        />
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </Show>
          </Show>
        </Show>
      </div>

      <div class="flex items-center gap-3 border-t border-line px-4 py-2 text-xs text-mute">
        <button
          type="button"
          class={BUTTON_CLS}
          disabled={offset() === 0 || total() === 0}
          onClick={() => setOffset(Math.max(0, offset() - limit()))}
        >
          ← Newer
        </button>
        <span class="tabular-nums">
          <Show when={total() > 0} fallback={<>0 of 0</>}>
            {range().from}–{range().to} of {total()}
          </Show>
        </span>
        <button
          type="button"
          class={BUTTON_CLS}
          disabled={range().from <= 1 || total() === 0}
          onClick={() => setOffset(offset() + limit())}
        >
          Older →
        </button>
      </div>
    </div>
  );
}
