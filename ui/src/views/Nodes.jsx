// Tasks view (Fase 5A pieza 2).
//
// Replaces the previous "Nodes" table with a workspace-grade view that:
//   - uses the snapshot's derived pools (ready/blocked/backlog) instead of
//     re-deriving status locally — the UI must agree with the CLI;
//   - shows the columns the user actually needs (status, id, title,
//     initiative, domain, owner, last activity) with rows 48-56 px tall;
//   - exposes real filters (status / domain / owner / initiative), column
//     sorting, and a "Clear filters" action;
//   - lists `archived` as a status option only when at least one task is
//     archived (per spec: "visualizar si existe, no crear");
//   - uses real <button> rows instead of a clickable <tr> so keyboard
//     activation and focus visibility work out of the box;
//   - falls back to a card list (<768px) so the view stays usable on
//     phones without compressing the table.
//
// The contract (components.jsx, store.jsx, snapshot shape) is frozen for
// this task. If a new primitive is needed, ask via `add-note` rather than
// touching shared files.

import { createMemo, createSignal, Show, For } from "solid-js";
import { useStore } from "../store.jsx";
import {
  PageHeader,
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
  { key: "owner",         label: "Owner",         sortable: true, gridCol: "minmax(120px,1fr)"   },
  { key: "last_activity", label: "Last activity", sortable: true, gridCol: "minmax(140px,1fr)"   },
];

const GRID_TEMPLATE = COLUMNS.map((c) => c.gridCol).join(" ");

// Resolve the displayed status for a task using the snapshot's derived
// pools. Mirrors `statusOfV2` in src/v2.mjs so the UI can't disagree
// with the CLI about whether a task is ready, blocked or backlog.
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
// activity column compares the snapshot's `last_activity` timestamp and
// treats "no activity" as the oldest possible value. Direction is applied
// by the caller (sorted() in the component) so this stays pure.
function compareTasks(a, b, column, derived) {
  const valueOf = (n) => {
    switch (column) {
      case "status":        return STATUS_ORDER[resolveStatus(n, derived)] ?? 99;
      case "id":            return n.id || "";
      case "title":         return (n.title || "").toLowerCase();
      case "initiative":    return (n.initiative || "").toLowerCase();
      case "domain":        return (n.domain || "").toLowerCase();
      case "owner":         return (n.claim?.by || "").toLowerCase();
      case "last_activity": return n.__lastTs || "";
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
  const s = () => snapshot();

  const [q, setQ] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [domain, setDomain] = createSignal("");
  const [owner, setOwner] = createSignal("");
  const [ini, setIni] = createSignal("");
  const [sortBy, setSortBy] = createSignal("id");
  const [sortDir, setSortDir] = createSignal("asc");

  const tasks = createMemo(() => {
    const nodes = s()?.nodes || {};
    return Object.values(nodes).filter((n) => n.subkind === "task");
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

  const owners = createMemo(() => {
    const set = new Set();
    for (const n of tasks()) if (n.claim && n.claim.by) set.add(n.claim.by);
    return [...set].sort();
  });

  // Bucket counts drive which status options appear in the filter. The
  // contract says "visualizar si existe, no crear": archived (and any
  // other bucket with zero tasks) simply isn't offered.
  const statusCounts = createMemo(() => {
    const counts = {};
    for (const n of tasks()) {
      const ds = resolveStatus(n, derived());
      counts[ds] = (counts[ds] || 0) + 1;
    }
    return counts;
  });

  const visibleStatusOptions = createMemo(() =>
    STATUS_OPTIONS.filter((o) => (statusCounts()[o.value] || 0) > 0)
  );

  const filtered = createMemo(() => {
    let out = tasks();
    const needle = q().trim().toLowerCase();
    if (needle) {
      out = out.filter((n) => {
        const hay = `${n.id} ${n.title} ${n.domain || ""} ${(n.tags || []).join(" ")}`.toLowerCase();
        return hay.includes(needle);
      });
    }
    if (status()) {
      const want = status();
      out = out.filter((n) => resolveStatus(n, derived()) === want);
    }
    if (domain()) out = out.filter((n) => n.domain === domain());
    if (owner()) out = out.filter((n) => n.claim?.by === owner());
    if (ini()) out = out.filter((n) => n.initiative === ini());
    return out;
  });

  const sorted = createMemo(() => {
    const d = derived();
    const lastActivity = s()?.last_activity || {};
    const col = sortBy();
    const sign = sortDir() === "desc" ? -1 : 1;
    // Decorate each task with the last-activity timestamp so the
    // comparator stays a pure function and doesn't need to know about
    // the snapshot shape.
    const decorated = filtered().map((n) => ({
      ...n,
      __lastTs: lastActivity[n.id]?.ts || "",
    }));
    return decorated.sort((a, b) => sign * compareTasks(a, b, col, d));
  });

  const hasFilters = createMemo(
    () => Boolean(q() || status() || domain() || owner() || ini())
  );

  function clearFilters() {
    setQ("");
    setStatus("");
    setDomain("");
    setOwner("");
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
    "grid min-h-[48px] w-full items-center gap-3 border-b border-line bg-panel px-3 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-0";

  const totalLabel = () => {
    const t = tasks().length;
    return `${t} task${t === 1 ? "" : "s"}`;
  };

  return (
    <div class="flex h-full flex-col gap-4 p-6">
      <PageHeader
        title="Tasks"
        eyebrow="Work"
        subtitle="Track every task and its current state."
        meta={totalLabel()}
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
          aria-label="Filter by owner"
          class="min-h-[36px] rounded-control border border-line bg-panel px-3 text-[13px] text-body outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
          value={owner()}
          onChange={(e) => setOwner(e.currentTarget.value)}
          disabled={owners().length === 0}
        >
          <option value="">All owners</option>
          <For each={owners()}>
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
      <div class="hidden min-h-0 flex-1 overflow-auto rounded-card border border-line bg-panel md:block">
        <div class="flex min-w-[960px] flex-col">
          <div
            role="row"
            class="sticky top-0 z-10 grid border-b border-line bg-canvas"
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
            when={sorted().length > 0}
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
            <For each={sorted()}>
              {(n) => {
                const last = () => s()?.last_activity?.[n.id];
                return (
                  <button
                    type="button"
                    role="row"
                    class={rowBtnCls}
                    style={{ "grid-template-columns": GRID_TEMPLATE }}
                    onClick={() => select(n.id)}
                    aria-label={`Open ${n.id}: ${n.title}`}
                  >
                    <span role="gridcell"><StatusBadge status={resolveStatus(n, derived())} /></span>
                    <span role="gridcell" class="mono truncate text-[13px] text-ink">{n.id}</span>
                    <span role="gridcell" class="min-w-0 truncate text-[13px] text-body" title={n.title}>
                      {n.title}
                    </span>
                    <span role="gridcell">
                      <Show when={n.initiative} fallback={<span class="text-[12px] text-mute">—</span>}>
                        <Chip>{n.initiative}</Chip>
                      </Show>
                    </span>
                    <span role="gridcell">
                      <Show when={n.domain} fallback={<span class="text-[12px] text-mute">—</span>}>
                        <Chip>{n.domain}</Chip>
                      </Show>
                    </span>
                    <span role="gridcell" class="truncate text-[13px] text-body">
                      <Show when={n.claim?.by} fallback={<span class="text-[12px] text-mute">—</span>}>
                        <span class="truncate">{n.claim.by}</span>
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
          when={sorted().length > 0}
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
            <For each={sorted()}>
              {(n) => {
                const last = () => s()?.last_activity?.[n.id];
                const ds = () => resolveStatus(n, derived());
                return (
                  <NodeRow
                    node={{ ...n, status: ds() }}
                    onClick={() => select(n.id)}
                    right={
                      <>
                        <Show when={n.claim?.by}>
                          <Chip tone="progress">{n.claim.by}</Chip>
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
    </div>
  );
}