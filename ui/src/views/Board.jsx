// Kanban board for climier tasks.
//
// Contract (ui-redesign-plan.md section 6 Fase 5A, Track A):
//   - Four task columns: Ready / In progress / Blocked / Backlog. Open gates
//     join the same grid as an optional first column, immediately before Ready.
//   - Columns stay fixed at 280 px; the board scrolls horizontally without
//     stretching or compressing columns. The grid grows to five columns only
//     when gates are present.
//   - Column headers show only the label and count; the board stays scannable
//     without explanatory subtitles under every status.
//   - Columns grow to the height of their content until the available board
//     height is reached. The board scrolls horizontally; each column body
//     owns its vertical overflow.
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
//   - Status is sourced from the reactive selector surface
//     (useStoreSelectors().tasksByStatus / openGates / nodesMap). The board
//     keeps the public useStore() facade but does not derive status itself.
//
// Live store (ADR-010 / plan §3.4):
//   - The four columns are stable identifiers (literal status) iterated
//     through a module-level constant; their DOM elements never re-mount
//     across polls and they keep their scroll position.
//   - Cards inside each column iterate node IDs (the reconciliation key of
//     entities.nodes). Unchanged entities keep the same reference across
//     polls, so unchanged cards keep their DOM. A status change removes the
//     card from one column and adds it to another (single expected remount).
//   - Gates iterate openGates() IDs the same way.
//
// Scope: this file only. We do NOT touch Nodes.jsx, components.jsx,
// store.jsx, the store internals, App, server, other views or any test.

import { createMemo, Show, For } from "solid-js";
import { useStore, useStoreSelectors } from "../store.jsx";
import {
  PageLayout,
  Chip,
  StatusBadge,
  EmptyState,
  ClaimTime,
} from "../components.jsx";

// Stable column descriptors. Defined at module scope so the array handed to
// <For> is the same reference for the whole lifetime of the view; the four
// <Column> elements are mounted once and never re-mounted across polls,
// which is what keeps `scrollTop` on the column body intact.
const COLUMN_DEFS = [
  { key: "ready", label: "Ready", status: "ready" },
  { key: "in_progress", label: "In progress", status: "in_progress" },
  { key: "blocked", label: "Blocked", status: "blocked" },
  { key: "backlog", label: "Backlog", status: "backlog" },
];

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
  // edges            (array, required — for principalBlocker/liveBlockerCount)
  // nodes            (object, required — entities.nodes map for blocker lookup)
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
// only mounted when the filtered gate pool has items. Iterating by node ID
// keeps each gate card's DOM stable across polls.

function OpenGatesColumn(props) {
  // gateIds (array of node IDs, required)
  // nodes   (object, required — entities.nodes map for live lookup)
  const select = useStore().select;
  return (
    <div class="ui-detail-card ui-board-column ui-board-gates flex flex-col rounded-card border border-line bg-panel px-1 pb-1">
      <header class="ui-board-column-header flex items-start justify-between gap-3 border-b border-line bg-panel/95 px-4 py-3 backdrop-blur-[2px]">
        <div class="ui-board-column-header-title">
          <span>Open gates</span>
        </div>
        <div class="ui-board-column-header-count shrink-0">{props.gateIds.length}</div>
      </header>
      <div class="ui-board-column-body space-y-2 p-3">
        <For each={props.gateIds}>
          {(id) => {
            const gate = () => props.nodes[id];
            return (
              <button
                type="button"
                class="ui-list-row ui-board-gate-card w-full rounded-card border border-gate bg-gate-soft p-3 text-left transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
                onClick={() => select(id)}
                aria-label={`${id} ${gate().title}`}
              >
                <div>
                  <span class="mono text-[12px] text-gate">{id}</span>
                </div>
                <div class="ui-board-card-title mt-2 line-clamp-2 text-[14px] font-semibold leading-5 text-ink" title={gate().title}>
                  {gate().title}
                </div>
                <Show when={gate().body}>
                  <div class="mt-1 line-clamp-2 text-[12px] leading-4 text-mute" title={gate().body}>
                    {gate().body}
                  </div>
                </Show>
                <div class="mt-3 flex flex-wrap items-center gap-1.5">
                  <Chip tone="gate">{gate().purpose || "decision"}</Chip>
                </div>
              </button>
            );
          }}
        </For>
      </div>
    </div>
  );
}

// === Column =================================================================
// One natural-height column on the board. The column body owns vertical
// overflow once the column reaches the available board height. One Column
// element per entry in COLUMN_DEFS; the JSX body is rendered as children so
// the parent controls keying of cards.

function Column(props) {
  // label (string, required)
  // tone  (status key for the count color)
  // count (number, required)
  // children (node, required — list of cards or empty state)
  return (
    <div class="ui-detail-card ui-board-column flex flex-col rounded-card border border-line bg-panel px-1 pb-1">
      <header class="ui-board-column-header flex items-start justify-between gap-3 border-b border-line bg-panel/95 px-4 py-3 backdrop-blur-[2px]">
        <div class="ui-board-column-header-title">
          <span>{props.label}</span>
        </div>
        <div class="ui-board-column-header-count shrink-0">{props.count}</div>
      </header>
      <div class="ui-board-column-body space-y-2">
        {props.children}
      </div>
    </div>
  );
}

// === Board ==================================================================
// Top-level view. Splits into: optional open-gates column, four-column
// kanban, and the empty state when no column has items.

export default function Board(props) {
  const selectors = useStoreSelectors();
  const { snapshot } = useStore();
  const initiative = () => props.boardInitiative?.() || "";

  // Reactive accessors backed by the selector surface. nodesMap() returns
  // the reactive `entities.nodes` proxy; reconciled references keep each
  // card's identity stable when the poll didn't change its entity.
  const nodes = createMemo(() => selectors.nodesMap());
  // Edges still come from the raw snapshot legacy form: the selector surface
  // does not expose edges, and principalBlocker / liveBlockerCount only need
  // `from / to / type` plus the status of the blocker. The scan stays O(E)
  // per card, same as before, and the view stays decoupled from store
  // internals.
  const edges = () => snapshot()?.edges || [];

  // IDs grouped by status from the selector surface. Each array is a list of
  // node IDs (strings); iterating by ID keeps <For> keying stable across
  // polls even when the underlying arrays are fresh objects.
  const tasksByStatus = createMemo(() => selectors.tasksByStatus());
  const openGates = createMemo(() => selectors.openGates());

  // Initiative-scoped view. The initiative picker scopes every column to one
  // initiative; an empty selection keeps the complete active board visible.
  const matches = (id) =>
    !initiative() || nodes()[id]?.initiative === initiative();

  const filteredTasks = createMemo(() => {
    const t = tasksByStatus();
    return {
      ready: t.ready.filter(matches),
      in_progress: t.in_progress.filter(matches),
      blocked: t.blocked.filter(matches),
      backlog: t.backlog.filter(matches),
    };
  });

  const filteredGateIds = createMemo(() => openGates().filter(matches));

  const hasAnyActiveWork = createMemo(() => {
    const t = filteredTasks();
    return (
      t.ready.length +
      t.in_progress.length +
      t.blocked.length +
      t.backlog.length +
      filteredGateIds().length >
      0
    );
  });

  const initiativeActive = () => Boolean(initiative());

  function clearInitiative() {
    props.onBoardInitiativeChange?.("");
  }

  // Resolve a card's principal blocker on demand. Only meaningful for
  // status === "blocked", but cheap enough to compute uniformly inside the
  // Column body. Recomputes when edges or the resolved node change; the
  // returned blocker is the same object reference if the blocker node is the
  // same entity, so the callout body does not flash on every poll.
  function blockerFor(id) {
    return principalBlocker(edges(), nodes(), id);
  }

  // Slot for the optional gates column. One <Show when> guards the column;
  // when the pool goes empty the column unmounts once, when it becomes
  // non-empty it mounts once. The four task columns stay mounted the whole
  // time because they are driven by a module-level constant.
  const showGates = createMemo(() => filteredGateIds().length > 0);

  return (
    <PageLayout mode="workspace">
      <div class="ui-workspace-body ui-board-body flex min-h-0 flex-1 flex-col gap-4">
        <Show
          when={hasAnyActiveWork()}
          fallback={
            <div class="flex flex-1 items-center justify-center">
              <EmptyState
                variant="page"
                title="No active work on the board"
                hint={
                  initiativeActive()
                    ? "Choose another initiative or show the full board."
                    : "Everything is closed, archived, or back in backlog. Add a task to get started."
                }
                cta={
                  initiativeActive() ? (
                    <button
                      type="button"
                      class="inline-flex min-h-[36px] items-center rounded-control border border-line bg-panel-2 px-3 text-[13px] text-body hover:bg-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
                      onClick={clearInitiative}
                    >
                      Show all initiatives
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
          <div class="ui-board-scroll flex min-h-0 min-w-0 flex-1">
            <div
              class="ui-board-columns grid h-full min-h-0 gap-3"
              style={{ "grid-template-columns": `repeat(${COLUMN_DEFS.length + (showGates() ? 1 : 0)}, 280px)` }}
            >
              <Show when={showGates()}>
                <OpenGatesColumn gateIds={filteredGateIds()} nodes={nodes()} />
              </Show>
              <For each={COLUMN_DEFS}>
                {(col) => {
                  const ids = createMemo(() => filteredTasks()[col.key] || []);
                  const count = () => ids().length;
                  return (
                    <Column label={col.label} tone={col.status} count={count()}>
                      <Show
                        when={count() > 0}
                        fallback={
                          <div class="ui-board-empty flex min-h-[104px] items-center justify-center rounded-control border border-dashed border-line text-center">
                            <EmptyState variant="compact" title="Nothing here." />
                          </div>
                        }
                      >
                        <For each={ids()}>
                          {(id) => (
                            <BoardCard
                              node={nodes()[id]}
                              status={col.status}
                              edges={edges()}
                              nodes={nodes()}
                              principalBlocker={
                                col.status === "blocked" ? blockerFor(id) : null
                              }
                            />
                          )}
                        </For>
                      </Show>
                    </Column>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>

      </div>
    </PageLayout>
  );
}
