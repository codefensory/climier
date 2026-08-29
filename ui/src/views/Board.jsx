// Kanban board for climier tasks.
//
// Contract (ui-redesign-plan.md section 6 Fase 5A, Track A):
//   - Four task columns: Ready / In progress / Blocked / Backlog. Open gates
//     join the same grid as an optional first column, immediately before Ready.
//   - Columns stay fixed at 280 px; the board scrolls horizontally instead of
//     stretching or compressing columns. The grid grows to five columns only
//     when gates are present.
//   - Column headers show only the label and count; the board stays scannable
//     without explanatory subtitles under every status.
//   - Cards use the visual contract (16 px padding, radius 12, hairline
//     border, no shadow). Hierarchy: id + status, title, initiative + claim,
//     principal blocker callout only when blocked.
//   - The open-gates column is hidden entirely when there are no open gates.
//   - History (done / canceled / superseded) is NOT mixed in here; it remains
//     available from the Tasks view.
//   - No drag-and-drop and no mutating actions. Clicking a card opens
//     NodeDetail via store.select(id).
//   - When every column is empty (no ready, no in progress, no blocked, no
//     backlog) and there are no open gates, the board shows a single
//     "no active work" empty state instead of four dead columns.
//   - Status is sourced from the snapshot's pre-derived pools
//     (s().derived.{ready,blocked,backlog,openGates}) and the persisted
//     `status === "in_progress"` field. No local status derivation; the
//     dashboard must not disagree with the CLI.
//
// Scope: this file only. We do NOT touch Nodes.jsx, components.jsx,
// store.jsx, or the snapshot contract. Primitives that are missing for this
// view are flagged in a note rather than patched in.

import { createMemo, createSignal, Show, For } from "solid-js";
import { useStore } from "../store.jsx";
import {
  PageLayout,
  Chip,
  StatusBadge,
  EmptyState,
  FilterBar,
  ClaimTime,
} from "../components.jsx";

// Statuses that mean a node no longer needs to block anything downstream.
// Used to walk the incoming BLOCKS edges of a blocked task and pick the
// blocker whose owning node is still alive.
const TERMINAL_STATUSES = new Set([
  "done",
  "resolved",
  "superseded",
  "archived",
  "deprecated",
  "canceled",
]);

// Returns the first incoming BLOCKS edge whose `from` node is not in a
// terminal state, or null if every blocker is satisfied. Reads edges +
// nodes directly; does not derive a status, just walks the DAG.
function principalBlocker(edges, nodes, id) {
  if (!edges || !nodes) return null;
  const incoming = edges.filter((e) => e.type === "BLOCKS" && e.to === id);
  for (const e of incoming) {
    const from = nodes[e.from];
    if (!from) continue;
    const status = from.status || "open";
    if (!TERMINAL_STATUSES.has(status)) return from;
  }
  return null;
}

// Returns the count of nodes (across all kinds) that would unblock this
// node if they reached a terminal state. Used to label a blocked card's
// blocker callout when there are several alive blockers.
function liveBlockerCount(edges, nodes, id) {
  if (!edges || !nodes) return 0;
  let n = 0;
  for (const e of edges) {
    if (e.type !== "BLOCKS" || e.to !== id) continue;
    const from = nodes[e.from];
    if (!from) continue;
    const status = from.status || "open";
    if (!TERMINAL_STATUSES.has(status)) n += 1;
  }
  return n;
}

// === Board card ============================================================
// Single kanban card. Clickable; opens NodeDetail via store.select(id).
// Visual contract: padding 16, radius 12, hairline border, no shadow,
// focus-visible ring inherited from the global rule in index.css.

function BoardCard(props) {
  // node             (object, required — full node from snapshot)
  // status           (string, required — derived status used for the badge)
  // principalBlocker (object | null, optional — only when status === "blocked")
  const n = () => props.node || {};
  const select = useStore().select;
  const liveBlockers = createMemo(() =>
    props.status === "blocked"
      ? liveBlockerCount(props.edges, props.nodes, n().id)
      : 0
  );
  return (
    <button
      type="button"
      class="ui-list-row ui-board-card block w-full rounded-card border border-line bg-panel p-4 text-left transition-colors hover:border-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
      onClick={() => select(n().id)}
      aria-label={`${n().id} ${n().title}`}
    >
      <div>
        <span class="mono shrink-0 text-[12px] text-mute">{n().id}</span>
      </div>
      <div class="ui-board-card-title mt-2 line-clamp-2 text-[15px] font-semibold leading-5 text-ink" title={n().title}>
        {n().title}
      </div>
      <Show when={n().body}>
        <div class="ui-board-card-preview mt-2 line-clamp-3 whitespace-pre-wrap text-[12px] leading-4 text-body" title={n().body}>
          {n().body}
        </div>
      </Show>
      <div class="mt-3 flex flex-wrap items-center gap-1.5">
        <StatusBadge status={props.status} />
        <Show when={n().initiative}>
          <Chip>{n().initiative}</Chip>
        </Show>
        <Show when={n().domain}>
          <Chip>{n().domain}</Chip>
        </Show>
        <Show when={n().claim && n().claim.by}>
          <span class="inline-flex items-center gap-1 text-[12px] leading-4 text-body">
            <span class="mono text-mute" aria-hidden="true">⚑</span>
            <span class="font-medium">{n().claim.by}</span>
          </span>
        </Show>
      </div>
      <Show when={props.status === "blocked" && props.principalBlocker}>
        <div class="mt-3 rounded-control border border-blocked bg-blocked-soft px-3 py-2 text-[12px] leading-4 text-blocked">
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-semibold text-ink">Blocked by</span>
            <span class="mono text-mute">{props.principalBlocker.id}</span>
          </div>
          <div class="mt-0.5 line-clamp-1 text-ink" title={props.principalBlocker.title}>{props.principalBlocker.title}</div>
          <Show when={liveBlockers() > 1}>
            <div class="mt-1 text-mute">+{liveBlockers() - 1} more live blocker(s)</div>
          </Show>
        </div>
      </Show>
      <Show when={n().claim && n().claim.by}>
        <div class="mt-3 flex items-center justify-between text-[12px] text-mute">
          <span>claimed</span>
          <ClaimTime claim={n().claim} />
        </div>
      </Show>
    </button>
  );
}

// === Open gates column ======================================================
// Open gates share the task columns' visual and spatial level. The column is
// only mounted when the filtered gate pool has items.

function OpenGatesColumn(props) {
  // gates  (array of node objects, required)
  const select = useStore().select;
  return (
    <div class="ui-detail-card ui-board-column ui-board-gates flex h-full min-h-0 flex-col overflow-auto rounded-card border border-line bg-panel">
      <header class="ui-board-column-header sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-panel/95 px-4 py-3 backdrop-blur-[2px]">
        <div class="ui-board-column-header-title">
          <span>Open gates</span>
        </div>
        <div class="ui-board-column-header-count shrink-0">{props.gates.length}</div>
      </header>
      <div class="ui-board-column-body flex-1 min-h-0 space-y-2 p-3">
        <For each={props.gates}>
          {(g) => (
            <button
              type="button"
              class="ui-list-row ui-board-gate-card w-full rounded-card border border-gate bg-gate-soft p-3 text-left transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
              onClick={() => select(g.id)}
              aria-label={`${g.id} ${g.title}`}
            >
              <div class="flex items-center justify-between gap-2">
                <span class="mono text-[12px] text-gate">{g.id}</span>
                <Chip tone="gate">{g.purpose || "decision"}</Chip>
              </div>
              <div class="ui-board-card-title mt-2 line-clamp-2 text-[14px] font-semibold leading-5 text-ink" title={g.title}>
                {g.title}
              </div>
              <Show when={g.body}>
                <div class="mt-1 line-clamp-2 text-[12px] leading-4 text-mute" title={g.body}>
                  {g.body}
                </div>
              </Show>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

// === Column =================================================================
// One column on the board. The header sticks while the body scrolls inside
// the column so a long backlog keeps the count visible.

function Column(props) {
  // label (string, required)
  // tone  (status key for the count color)
  // count (number, required)
  // children (node, required — list of cards or empty state)
  return (
    <div class="ui-detail-card ui-board-column flex h-full min-h-0 flex-col overflow-auto rounded-card border border-line bg-panel">
      <header class="ui-board-column-header sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-panel/95 px-4 py-3 backdrop-blur-[2px]">
        <div class="ui-board-column-header-title">
          <span>{props.label}</span>
        </div>
        <div class="ui-board-column-header-count shrink-0">{props.count}</div>
      </header>
      <div class="ui-board-column-body flex-1 min-h-0 space-y-2 p-3">
        {props.children}
      </div>
    </div>
  );
}

// === Board ==================================================================
// Top-level view. Splits into: filter bar, optional open-gates column,
// four-column kanban, and a footer with a link to the Tasks view for history
// (done / canceled / superseded).

export default function Board() {
  const { snapshot } = useStore();
  const s = () => snapshot();

  // Local filter state. Filters apply across every column and gate.
  const [q, setQ] = createSignal("");
  const [initiative, setInitiative] = createSignal("");

  // Pulled from the snapshot — no local derivation.
  const nodes = () => s()?.nodes || {};
  const edges = () => s()?.edges || [];
  const derived = () => s()?.derived || { ready: [], blocked: [], backlog: [], openGates: [] };

  // Open gates from the server's pool. The dashboard never builds this list
  // by scanning + filtering the nodes map.
  const openGates = createMemo(() =>
    derived()
      .openGates.map((id) => nodes()[id])
      .filter(Boolean)
  );

  // Tasks visible on the board: only resolvable tasks (subkind === "task").
  // We use the snapshot's pre-derived pools for ready / blocked / backlog
  // and the persisted status for in_progress. The four pools are disjoint.
  const tasksByStatus = createMemo(() => {
    const d = derived();
    const map = { ready: [], in_progress: [], blocked: [], backlog: [] };
    const seen = new Set();
    for (const id of d.ready || []) {
      const n = nodes()[id];
      if (n && n.subkind === "task") { map.ready.push(n); seen.add(id); }
    }
    for (const id of d.blocked || []) {
      const n = nodes()[id];
      if (n && n.subkind === "task") { map.blocked.push(n); seen.add(id); }
    }
    for (const id of d.backlog || []) {
      const n = nodes()[id];
      if (n && n.subkind === "task") { map.backlog.push(n); seen.add(id); }
    }
    // In-progress tasks are not in the derived pools; persist-derived.
    for (const n of Object.values(nodes())) {
      if (!n || n.subkind !== "task") continue;
      if (n.status !== "in_progress") continue;
      if (seen.has(n.id)) continue;
      map.in_progress.push(n);
    }
    return map;
  });

  // Distinct initiatives for the filter dropdown. Sorted alphabetically.
  const initiatives = createMemo(() => {
    const set = new Set();
    for (const n of Object.values(nodes())) {
      if (n.initiative && n.subkind !== "gate") set.add(n.initiative);
    }
    return [...set].sort();
  });

  // The free-text search hits id, title, initiative, and tags. We do not
  // extend it to the body to keep the index fast and predictable.
  const matches = (n) => {
    if (initiative() && n.initiative !== initiative()) return false;
    const needle = q().trim().toLowerCase();
    if (!needle) return true;
    const hay = `${n.id} ${n.title} ${n.initiative || ""} ${(n.tags || []).join(" ")}`.toLowerCase();
    return hay.includes(needle);
  };

  const filteredTasks = createMemo(() => {
    const m = tasksByStatus();
    return {
      ready: m.ready.filter(matches),
      in_progress: m.in_progress.filter(matches),
      blocked: m.blocked.filter(matches),
      backlog: m.backlog.filter(matches),
    };
  });

  const filteredGates = createMemo(() => openGates().filter(matches));

  const hasAnyActiveWork = createMemo(() => {
    const t = filteredTasks();
    return (
      t.ready.length +
      t.in_progress.length +
      t.blocked.length +
      t.backlog.length +
      filteredGates().length >
      0
    );
  });

  const filtersActive = () => Boolean(q().trim() || initiative());

  function clearFilters() {
    setQ("");
    setInitiative("");
  }

  // Column definitions. Keeping them as a memo keeps the counts in lock-step
  // with the snapshot and the filters.
  const columns = createMemo(() => {
    const t = filteredTasks();
    return [
      { key: "ready", label: "Ready", status: "ready", cards: t.ready },
      { key: "in_progress", label: "In progress", status: "in_progress", cards: t.in_progress },
      { key: "blocked", label: "Blocked", status: "blocked", cards: t.blocked },
      { key: "backlog", label: "Backlog", status: "backlog", cards: t.backlog },
    ];
  });

  return (
    <PageLayout mode="workspace">
      <div class="ui-workspace-body ui-board-body flex min-h-0 flex-1 flex-col gap-4">
        <FilterBar
          label="Filters"
          hint={
            filtersActive()
              ? `${columns().reduce((n, c) => n + c.cards.length, 0) + filteredGates().length} match(es)`
              : undefined
          }
          onClear={filtersActive() ? clearFilters : undefined}
        >
          <input
            type="search"
            class="min-h-[36px] min-w-[240px] flex-1 rounded-control border border-line bg-panel-2 px-3 text-[13px] text-ink outline-none placeholder:text-mute focus:border-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
            placeholder="Search id, title, initiative, tag…"
            value={q()}
            onInput={(e) => setQ(e.currentTarget.value)}
            aria-label="Search board"
          />
          <select
            class="min-h-[36px] rounded-control border border-line bg-panel-2 px-3 text-[13px] text-body outline-none focus:border-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
            value={initiative()}
            onChange={(e) => setInitiative(e.currentTarget.value)}
            aria-label="Filter by initiative"
          >
            <option value="">All initiatives</option>
            <For each={initiatives()}>
              {(i) => <option value={i}>{i}</option>}
            </For>
          </select>
        </FilterBar>

        <Show
          when={hasAnyActiveWork()}
          fallback={
            <div class="flex flex-1 items-center justify-center">
              <EmptyState
                variant="page"
                title="No active work on the board"
                hint={
                  filtersActive()
                    ? "Adjust or clear the filters to see more work."
                    : "Everything is closed, archived, or back in backlog. Add a task to get started."
                }
                cta={
                  filtersActive() ? (
                    <button
                      type="button"
                      class="inline-flex min-h-[36px] items-center rounded-control border border-line bg-panel-2 px-3 text-[13px] text-body hover:bg-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
                      onClick={clearFilters}
                    >
                      Clear filters
                    </button>
                  ) : undefined
                }
              >
                <div class="text-[12px] text-mute">
                  Tasks flow here once they are opened and not blocked. Knowledge and history live in their own tabs.
                </div>
              </EmptyState>
            </div>
          }
        >
          <div
            class="ui-board-columns grid min-h-0 flex-1 gap-3 overflow-x-auto"
            style={{ "grid-template-columns": `repeat(${columns().length + (filteredGates().length > 0 ? 1 : 0)}, 280px)` }}
          >
            <Show when={filteredGates().length > 0}>
              <OpenGatesColumn gates={filteredGates()} />
            </Show>
            <For each={columns()}>
              {(col) => (
                <Column
                  label={col.label}
                  tone={col.status}
                  count={col.cards.length}
                >
                  <Show
                    when={col.cards.length > 0}
                    fallback={
                      <EmptyState variant="compact" title="Nothing here." />
                    }
                  >
                    <For each={col.cards}>
                      {(n) => (
                        <BoardCard
                          node={n}
                          status={col.status}
                          edges={edges()}
                          nodes={nodes()}
                          principalBlocker={
                            col.status === "blocked"
                              ? principalBlocker(edges(), nodes(), n.id)
                              : null
                          }
                        />
                      )}
                    </For>
                  </Show>
                </Column>
              )}
            </For>
          </div>
        </Show>

      </div>
    </PageLayout>
  );
}
