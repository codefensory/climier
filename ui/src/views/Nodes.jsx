// Tasks view (Fase 5A pieza 2).
//
// Replaces the previous "Nodes" table with a workspace-grade view that:
//   - uses the snapshot's derived pools (ready/blocked/backlog) instead of
//     re-deriving status locally — the UI must agree with the CLI;
//   - shows the columns the user actually needs (status, id, title,
//     initiative, domain, claimed-by agent, last activity) with rows 48-56 px tall;
//   - exposes real filters (status / domain / claimed-by agent / initiative), column
//     sorting, and a "Clear filters" action;
//   - lists `archived` as a status option only when at least one task is
//     archived (per spec: "visualizar si existe, no crear");
//   - uses real <button> rows instead of a clickable <tr> so keyboard
//     activation and focus visibility work out of the box;
//   - falls back to a card list (<768px) so the view stays usable on
//     phones without compressing the table.
//
// Identity contract (ADR-010 §3.4, ui-live-store-execution §3.4 / §12):
//   - consumes `useStoreSelectors().nodesMap()` (the reconciled entity
//     map) so task references stay stable across polls when content
//     does not change;
//   - iterates node IDs (strings) as the `<For>` source so Solid matches
//     rows by stable id identity; the row body looks up the current
//     node via `nodesMap()[id]`;
//   - filters, tabs and sorting behavior are preserved verbatim — only
//     the iteration target and the comparator inputs changed.
//
// The contract (components.jsx, store.jsx, snapshot shape) is frozen for
// this task. If a new primitive is needed, ask via `add-note` rather than
// touching shared files.

import { createMemo, createSignal, Show, For } from "solid-js";
import { useStore, useStoreSelectors } from "../store.jsx";
import {
  PageHeader,
  PageLayout,
  FilterBar,
  StatusBadge,
  Chip,
  EmptyState,
  NodeRow,
  Time,
} from "../components.jsx";

// Status options shown in the filter dropdown. They are restricted to the
// values listed in docs/ui-redesign-plan.md (Fase 5A) and rendered only
// when at least one task currently sits in that bucket — see
// `visibleStatusOptions` below.
const STATUS_OPTIONS = [
  { value: "ready", label: "Ready" },
  { value: "in_progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
  { value: "backlog", label: "Backlog" },
  { value: "done", label: "Done" },
  { value: "archived", label: "Archived" },
];

// Order used when sorting by status. Bucket meaning wins over alphabet:
// a worker scanning the table sees work flow from "ready → in progress →
// blocked → backlog → done → archived" without further interpretation.
const STATUS_ORDER = {
  ready: 0,
  in_progress: 1,
  blocked: 2,
  backlog: 3,
  done: 4,
  archived: 5,
};

const COLUMNS = [
  { key: "status",        label: "Status",        sortable: true, gridCol: "minmax(112px,0.8fr)" },
  { key: "id",            label: "Id",            sortable: true, gridCol: "minmax(140px,1fr)"   },
  { key: "title",         label: "Title",         sortable: true, gridCol: "minmax(220px,2.2fr)" },
  { key: "initiative",    label: "Initiative",    sortable: true, gridCol: "minmax(120px,1fr)"   },
  { key: "domain",        label: "Domain",        sortable: true, gridCol: "minmax(120px,1fr)"   },
  { key: "claimed_by",    label: "Claimed by",    sortable: true, gridCol: "minmax(120px,1fr)"   },
  { key: "last_activity", label: "Last activity", sortable: true, gridCol: "minmax(140px,1fr)"   },
];

const GRID_TEMPLATE = COLUMNS.map((c) => c.gridCol).join(" ");

// Resolve the displayed status for a task using the snapshot's derived
// pools. Mirrors the canonical read-model status projection so the UI can't
// disagree with the CLI about whether a task is ready, blocked or backlog.
function resolveStatus(node, derived) {
  if (!node) return "open";
  const status = node.status || "open";
  // Persisted terminal / work states are authoritative — the server
  // doesn't put them in the derived pools.
  if (
    status === "in_progress" ||
    status === "done" ||
    status === "archived" ||
    status === "canceled" ||
    status === "resolved" ||
    status === "superseded"
  ) {
    return status;
  }
  if (node.subkind === "task" && status === "open") {
    if (derived?.ready?.includes(node.id)) return "ready";
    if (derived?.blocked?.includes(node.id)) return "blocked";
    if (derived?.backlog?.includes(node.id)) return "backlog";
  }
  return status;
}

// Sort comparators per column. Strings use locale-aware compare so titles
// and ids feel native; the status column maps to STATUS_ORDER; the last-
// activity column reads the snapshot's `last_activity` timestamp (passed
// in by the caller so this stays pure) and treats "no activity" as the
// oldest possible value. Direction is applied by the caller (sortedIds
// in the component). We accept `lastActivity` as a parameter instead of
// decorating each task so the row identity contract — `nodesMap()[id]`
// returning the same proxy reference across polls — is preserved.
function compareTasks(a, b, column, derived, lastActivity) {
  const valueOf = (n) => {
    switch (column) {
      case "status":        return STATUS_ORDER[resolveStatus(n, derived)] ?? 99;
      case "id":            return n.id || "";
      case "title":         return (n.title || "").toLowerCase();
      case "initiative":    return (n.initiative || "").toLowerCase();
      case "domain":        return (n.domain || "").toLowerCase();
      case "claimed_by":    return (n.claim?.by || "").toLowerCase();
      case "last_activity": return (lastActivity && lastActivity[n.id]?.ts) || "";
      default:              return "";
    }
  };
  const av = valueOf(a);
  const bv = valueOf(b);
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

export default function Nodes() {
  const { snapshot, select } = useStore();
  const selectors = useStoreSelectors();
  const s = () => snapshot();
  const nodesById = () => selectors.nodesMap();

  const [q, setQ] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [domain, setDomain] = createSignal("");
  const [claimedBy, setClaimedBy] = createSignal("");
  const [ini, setIni] = createSignal("");
  const [sortBy, setSortBy] = createSignal("id");
  const [sortDir, setSortDir] = createSignal("asc");

  // Task IDs sourced from the reconciled entity map. Filters down to
  // `subkind === "task"` once, here, so downstream memos iterate ids
  // instead of objects. The map reference (and therefore these ids)
  // is stable across polls until a task is added, removed or changes
  // subkind; inner content updates do not invalidate identity.
  const taskIds = createMemo(() => {
    const map = nodesById();
    const out = [];
    for (const id of Object.keys(map)) {
      const n = map[id];
      if (n && n.subkind === "task") out.push(id);
    }
    return out;
  });

  const tasks = createMemo(() => {
    const map = nodesById();
    const out = [];
    for (const id of taskIds()) {
      const n = map[id];
      if (n) out.push(n);
    }
    return out;
  });

  const derived = () => s()?.derived || { ready: [], backlog: [] };

  const initiatives = createMemo(() => {
    const set = new Set();
    for (const n of tasks()) if (n.initiative) set.add(n.initiative);
    return [...set].sort();
  });

  const domains = createMemo(() => {
    const set = new Set();
    for (const n of tasks()) if (n.domain) set.add(n.domain);
    return [...set].sort();
  });

  const claimedAgents = createMemo(() => {
    const set = new Set();
    for (const n of tasks()) if (n.claim && n.claim.by) set.add(n.claim.by);
    return [...set].sort();
  });

  // Bucket counts drive which status options appear in the filter. The
  // contract says "visualizar si existe, no crear": archived (and any
  // other bucket with zero tasks) simply isn't offered.
  const statusCounts = createMemo(() => {
    const counts = {};
    const d = derived();
    for (const n of tasks()) {
      const ds = resolveStatus(n, d);
      counts[ds] = (counts[ds] || 0) + 1;
    }
    return counts;
  });

  const visibleStatusOptions = createMemo(() =>
    STATUS_OPTIONS.filter((o) => (statusCounts()[o.value] || 0) > 0)
  );

  // Filter by ID so the iteration target is a primitive (the id string)
  // and Solid's <For> can preserve row identity when the underlying
  // entity changes fields but stays in the filtered set. The lookup of
  // the actual node happens inside the row body, reading from the
  // reconciled map.
  const filteredIds = createMemo(() => {
    const map = nodesById();
    const d = derived();
    const want = status();
    const needle = q().trim().toLowerCase();
    const domainWanted = domain();
    const agentWanted = claimedBy();
    const iniWanted = ini();
    const out = [];
    for (const id of taskIds()) {
      const n = map[id];
      if (!n) continue;
      if (needle) {
        const hay = `${n.id} ${n.title} ${n.domain || ""} ${(n.tags || []).join(" ")}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      if (want && resolveStatus(n, d) !== want) continue;
      if (domainWanted && n.domain !== domainWanted) continue;
      if (agentWanted && n.claim?.by !== agentWanted) continue;
      if (iniWanted && n.initiative !== iniWanted) continue;
      out.push(id);
    }
    return out;
  });

  // Sort the id array, not the entity objects. The comparator still
  // needs node fields, so we resolve them through the reconciled map.
  // The output is a new array of stable id strings; <For> preserves
  // rows by id even when the array reference changes between polls.
  const sortedIds = createMemo(() => {
    const map = nodesById();
    const d = derived();
    const lastActivity = s()?.last_activity || {};
    const col = sortBy();
    const sign = sortDir() === "desc" ? -1 : 1;
    const decorated = filteredIds().map((id) => {
      const n = map[id];
      // ResolveStatus needs the node — wrap to keep the comparator pure.
      return { id, node: n };
    });
    decorated.sort((a, b) =>
      sign * compareTasks(a.node, b.node, col, d, lastActivity),
    );
    return decorated.map((entry) => entry.id);
  });

  const hasFilters = createMemo(
    () => Boolean(q() || status() || domain() || claimedBy() || ini())
  );

  function clearFilters() {
    setQ("");
    setStatus("");
    setDomain("");
    setClaimedBy("");
    setIni("");
  }

  function toggleSort(key) {
    if (sortBy() === key) {
      setSortDir(sortDir() === "asc" ? "desc" : "asc");
    } else {
      setSortBy(key);
      setSortDir("asc");
    }
  }

  function ariaSort(key) {
    if (sortBy() !== key) return "none";
    return sortDir() === "asc" ? "ascending" : "descending";
  }

  function sortGlyph(key) {
    if (sortBy() !== key) return "";
    return sortDir() === "asc" ? "↑" : "↓";
  }

  const headerCellCls =
    "flex items-center gap-1 px-3 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-mute";

  const sortBtnCls =
    "inline-flex min-h-[28px] items-center gap-1 rounded px-1 text-[12px] font-semibold uppercase tracking-wider text-mute hover:text-ink hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";

  // Same classes for every row so the grid track widths in `gridCol`
  // stay aligned with the header. min-h-[48px] guarantees the 48-56 px
  // band called out in the spec; the row can grow when the title wraps.
  const rowBtnCls =
    "ui-list-row grid min-h-[48px] w-full items-center gap-3 border-b border-line bg-panel px-3 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-0";

  const totalLabel = () => {
    const t = tasks().length;
    return `${t} task${t === 1 ? "" : "s"}`;
  };

  return (
    <PageLayout>
      <PageHeader
        title="Tasks"
        eyebrow="Work"
        subtitle="Track every task and its current state."
        meta={totalLabel()}
        sticky
      />

      <FilterBar
        label="Filters"
        onClear={hasFilters() ? clearFilters : undefined}
        clearLabel="Clear filters"
      >
        <input
          type="text"
          aria-label="Search tasks"
          placeholder="Search id, title, tag…"
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
          class="min-h-[36px] rounded-control border border-line bg-panel px-3 text-[13px] text-body outline-none placeholder:text-mute focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
        />
        <select
          aria-label="Filter by status"
          class="min-h-[36px] rounded-control border border-line bg-panel px-3 text-[13px] text-body outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
          value={status()}
          onChange={(e) => setStatus(e.currentTarget.value)}
        >
          <option value="">All statuses</option>
          <For each={visibleStatusOptions()}>
            {(o) => (
              <option value={o.value}>
                {o.label} ({statusCounts()[o.value] || 0})
              </option>
            )}
          </For>
        </select>
        <select
          aria-label="Filter by initiative"
          class="min-h-[36px] rounded-control border border-line bg-panel px-3 text-[13px] text-body outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
          value={ini()}
          onChange={(e) => setIni(e.currentTarget.value)}
          disabled={initiatives().length === 0}
        >
          <option value="">All initiatives</option>
          <For each={initiatives()}>
            {(i) => <option value={i}>{i}</option>}
          </For>
        </select>
        <select
          aria-label="Filter by domain"
          class="min-h-[36px] rounded-control border border-line bg-panel px-3 text-[13px] text-body outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
          value={domain()}
          onChange={(e) => setDomain(e.currentTarget.value)}
          disabled={domains().length === 0}
        >
          <option value="">All domains</option>
          <For each={domains()}>
            {(d) => <option value={d}>{d}</option>}
          </For>
        </select>
        <select
          aria-label="Filter by claimed agent"
          class="min-h-[36px] rounded-control border border-line bg-panel px-3 text-[13px] text-body outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
          value={claimedBy()}
          onChange={(e) => setClaimedBy(e.currentTarget.value)}
          disabled={claimedAgents().length === 0}
        >
          <option value="">All claimed agents</option>
          <For each={claimedAgents()}>
            {(o) => <option value={o}>{o}</option>}
          </For>
        </select>
      </FilterBar>

      {/*
        Desktop / tablet view: a CSS-grid table with sticky header and
        button rows. `min-w-[960px]` on the inner wrapper lets the table
        scroll horizontally on screens narrower than that — the headers
        stay aligned because they're part of the same grid.
      */}
      <div class="ui-panel hidden min-h-0 flex-1 overflow-auto rounded-card border border-line bg-panel md:block">
        <div class="flex min-w-[960px] flex-col">
          <div
            role="row"
            class="sticky top-0 z-10 grid border-b border-line bg-panel-2"
            style={{ "grid-template-columns": GRID_TEMPLATE }}
          >
            <For each={COLUMNS}>
              {(col) => (
                <div role="columnheader" aria-sort={ariaSort(col.key)} class={headerCellCls}>
                  <Show
                    when={col.sortable}
                    fallback={<span>{col.label}</span>}
                  >
                    <button
                      type="button"
                      class={sortBtnCls}
                      onClick={() => toggleSort(col.key)}
                      aria-label={`Sort by ${col.label}`}
                    >
                      <span>{col.label}</span>
                      <Show when={sortGlyph(col.key)}>
                        <span aria-hidden="true" class="text-ink">{sortGlyph(col.key)}</span>
                      </Show>
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </div>

          <Show
            when={sortedIds().length > 0}
            fallback={
              <div class="p-6">
                <EmptyState
                  variant="section"
                  title={
                    tasks().length === 0
                      ? "No tasks in this project yet."
                      : "No tasks match the current filters."
                  }
                  hint={
                    tasks().length === 0
                      ? "Create one with `climier add-task`."
                      : "Clear filters or pick a different combination."
                  }
                />
              </div>
            }
          >
            <For each={sortedIds()}>
              {(id) => {
                const n = () => nodesById()[id] || { id };
                const last = () => s()?.last_activity?.[id];
                return (
                  <button
                    type="button"
                    role="row"
                    class={rowBtnCls}
                    style={{ "grid-template-columns": GRID_TEMPLATE }}
                    onClick={() => select(id)}
                    aria-label={`Open ${id}: ${n().title || ""}`}
                  >
                    <span role="gridcell"><StatusBadge status={resolveStatus(n(), derived())} /></span>
                    <span role="gridcell" class="mono truncate text-[13px] text-ink">{id}</span>
                    <span role="gridcell" class="min-w-0 truncate text-[13px] text-body" title={n().title}>
                      {n().title}
                    </span>
                    <span role="gridcell">
                      <Show when={n().initiative} fallback={<span class="text-[12px] text-mute">—</span>}>
                        <Chip>{n().initiative}</Chip>
                      </Show>
                    </span>
                    <span role="gridcell">
                      <Show when={n().domain} fallback={<span class="text-[12px] text-mute">—</span>}>
                        <Chip>{n().domain}</Chip>
                      </Show>
                    </span>
                    <span role="gridcell" class="truncate text-[13px] text-body">
                      <Show when={n().claim?.by} fallback={<span class="text-[12px] text-mute">—</span>}>
                        <span class="truncate">{n().claim.by}</span>
                      </Show>
                    </span>
                    <span role="gridcell">
                      <Time value={last()?.ts} />
                    </span>
                  </button>
                );
              }}
            </For>
          </Show>
        </div>
      </div>

      {/*
        Mobile view (<768px): a vertical list of NodeRow cards. Each row
        is a real <button> provided by the shared primitive so keyboard
        activation and focus handling stay consistent with the rest of
        the app.
      */}
      <div class="block min-h-0 flex-1 overflow-auto md:hidden">
        <Show
          when={sortedIds().length > 0}
          fallback={
            <EmptyState
              variant="page"
              title={
                tasks().length === 0
                  ? "No tasks in this project yet."
                  : "No tasks match the current filters."
              }
              hint={
                tasks().length === 0
                  ? "Create one with `climier add-task`."
                  : "Clear filters or pick a different combination."
              }
            />
          }
        >
          <div class="flex flex-col gap-3">
            <For each={sortedIds()}>
              {(id) => {
                const n = () => nodesById()[id] || { id };
                const last = () => s()?.last_activity?.[id];
                const ds = () => resolveStatus(n(), derived());
                return (
                  <NodeRow
                    node={{ ...n(), status: ds() }}
                    onClick={() => select(id)}
                    right={
                      <>
                        <Show when={n().claim?.by}>
                          <Chip tone="progress">{n().claim.by}</Chip>
                        </Show>
                        <Time value={last()?.ts} />
                      </>
                    }
                  />
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </PageLayout>
  );
}
