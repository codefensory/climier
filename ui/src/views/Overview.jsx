// Overview view — Fase 4 pieza core (T-ui-overview-core).
//
// Contract: docs/ui-redesign-plan.md section 5 points 1-5 and section 6
// Fase 4. This piece implements the operational core of the overview:
//
//   1. Header: project name/base, "Registered Climier work only", last
//      refresh, live/read-only state, total nodes as context.
//   2. Global alerts only when they exist (state-read-error, stale claims,
//      anomalous blockers), grouped by kind with AlertBanner.
//   3. Operational status: 4 primary metrics (Ready / In progress /
//      Blocked / Backlog), each with a number, a one-line explanation and
//      navigation to Board/Tasks with a filter — MetricCard is a real
//      <button> with a real destination.
//   4. Work now: real lists of ready tasks (max 4) and in-progress tasks
//      (max 4). Row = status, id, title, initiative, owner/last activity.
//      Click opens NodeDetail via store.select(id).
//   5. Needs attention: stale, blocked, open gates, open decisions,
//      placeholders. When everything is zero, a single compact line
//      "No immediate coordination issues" — no dashed empty cards.
//
// Points 6-8 (initiatives, recent activity, project record) belong to
// T-ui-overview-context and are intentionally NOT implemented here.
//
// Data comes exclusively from the server snapshot (ui/server/server.mjs):
// derived pools (ready/blocked/backlog/openGates), summary counters,
// normalized alerts and last_activity. No local status derivation; the
// dashboard must not disagree with the CLI.
//
// Navigation note: route params (navigate(route, params)) are not plumbed
// yet — Board and Tasks views expose their own status columns/filters.
// Metric cards navigate to the Board route, which already shows the four
// operational status columns; wiring a deep filter param is left to the
// F7 integration track (the snapshot/route contract is frozen there).

import { Show, For, createMemo } from "solid-js";
import { useStore } from "../store.jsx";
import { projectDisplayName } from "../shell.mjs";
import {
  PageHeader,
  Panel,
  MetricCard,
  StatusBadge,
  Chip,
  AlertBanner,
  EmptyState,
  Time,
  LiveStatus,
} from "../components.jsx";

export const WORK_LIMIT = 4;
export const ATTENTION_LIMIT = 4;

// Humanized titles for alert kinds the server can emit today. Unknown kinds
// fall back to the raw kind so future alert types still render a readable
// banner instead of an empty title.
export const ALERT_TITLES = {
  "state-read-error": "State read error",
  "stale-claim": "Stale claims",
};

// Alert tone mapping. state-read-error is an error (data may be stale or
// absent); stale-claim is a warning (work is aging but recoverable).
export const ALERT_TONES = {
  "state-read-error": "error",
  "stale-claim": "warning",
};

// === Pure helpers ==========================================================
// Exported as named functions so the Fase 4 contract can be pinned with
// literal state objects (no DOM harness), mirroring the pattern used by
// Gates.jsx / Knowledge.jsx. The view component consumes them directly.

// Operational metrics (point 3): exactly four, in a fixed order, each with
// value/label/tone/explanation and a real navigation target. The `nav`
// field is the route id the MetricCard button navigates to; it is never
// null so no metric card fakes a destination.
export function buildMetrics(summary) {
  const s = summary || {};
  return [
    {
      key: "ready",
      label: "Ready",
      value: s.ready || 0,
      tone: "ready",
      nav: "board",
      explanation: "Tasks with no live blockers, ready to claim.",
    },
    {
      key: "in_progress",
      label: "In progress",
      value: s.in_progress || 0,
      tone: "progress",
      nav: "board",
      explanation: "Tasks claimed and being worked on.",
    },
    {
      key: "blocked",
      label: "Blocked",
      value: s.blocked || 0,
      tone: "blocked",
      nav: "board",
      explanation: "Tasks waiting on at least one live blocker.",
    },
    {
      key: "backlog",
      label: "Backlog",
      value: s.backlog || 0,
      tone: "backlog",
      nav: "board",
      explanation: "Tasks parked until promoted to active work.",
    },
  ];
}

// Group global alerts by kind, preserving first-seen order of kinds.
// Returns an array of [kind, alerts].
export function groupAlertsByKind(alerts) {
  const groups = {};
  for (const a of alerts || []) {
    const key = a && a.kind ? a.kind : "unknown";
    (groups[key] = groups[key] || []).push(a);
  }
  return Object.entries(groups);
}

// Ready tasks from the server's derived pool (point 4). Filters to tasks
// only (the pool is resolvable nodes; gates are excluded by subkind) and
// keeps server order. Respects the max limit.
export function readyTasks(derived, nodes, limit = WORK_LIMIT) {
  return (derived && derived.ready || [])
    .map((id) => (nodes || {})[id])
    .filter((n) => n && n.subkind === "task")
    .slice(0, limit);
}

// In-progress tasks by persisted status (point 4). Deterministic order: id
// ascending so the list is stable across snapshots. Respects the max limit.
export function inProgressTasks(nodes, limit = WORK_LIMIT) {
  return Object.values(nodes || {})
    .filter((n) => n && n.subkind === "task" && n.status === "in_progress")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit);
}

// Build the Needs attention blocks (point 5). Returns an empty array when
// there is nothing to coordinate — the view then renders a single compact
// healthy line instead of dashed empty cards. Each block is
// { title, items: [{ id, title }] }.
export function buildAttentionBlocks(input) {
  const { alerts, derived, nodes } = input || {};
  const blocks = [];
  const nodeById = (id) => (nodes || {})[id] || null;

  const staleAlerts = (alerts || []).filter((a) => a && a.kind === "stale-claim");
  if (staleAlerts.length) {
    blocks.push({
      title: "Stale",
      items: staleAlerts.map((a) => ({
        id: a.node_id || "stale",
        title: a.message || a.node_id || "Stale claim",
      })),
    });
  }

  const blockedTasks = ((derived && derived.blocked) || [])
    .map(nodeById)
    .filter((n) => n && n.subkind === "task");
  if (blockedTasks.length) blocks.push({ title: "Blocked", items: blockedTasks });

  const openGates = ((derived && derived.openGates) || []).map(nodeById).filter(Boolean);
  if (openGates.length) blocks.push({ title: "Open gates", items: openGates });

  const openDecisions = Object.values(nodes || {}).filter(
    (n) => n && n.subkind === "gate" && (n.status || "open") === "open" && n.purpose === "decision"
  );
  if (openDecisions.length) blocks.push({ title: "Open decisions", items: openDecisions });

  const placeholderTasks = Object.values(nodes || {}).filter(
    (n) => n && n.subkind === "task" && n.placeholder === true
  );
  if (placeholderTasks.length) blocks.push({ title: "Placeholders", items: placeholderTasks });

  return blocks;
}

// === WorkRow ===============================================================
// One row in the Work now lists. Real <button>; opens NodeDetail via
// store.select. Shows status, id, title, initiative and owner/last activity.

function WorkRow(props) {
  // node    (object, required — task node from the snapshot)
  // status  (string, required — derived/persisted status for the badge)
  const { select } = useStore();
  const n = () => props.node || {};
  const lastActivity = () => props.lastActivity || {};
  const last = () => lastActivity()[n().id];
  return (
    <button
      type="button"
      class="flex min-h-[44px] w-full items-center gap-3 rounded-control border border-line bg-panel px-3 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
      onClick={() => select(n().id)}
      aria-label={`${n().id} ${n().title}`}
    >
      <StatusBadge status={props.status} />
      <span class="mono shrink-0 text-[12px] text-body">{n().id}</span>
      <span class="min-w-0 flex-1 truncate text-[13px] leading-5 text-ink" title={n().title}>
        {n().title}
      </span>
      <Show when={n().initiative}>
        <Chip>{n().initiative}</Chip>
      </Show>
      <span class="flex shrink-0 items-center gap-1.5 text-[12px] text-mute">
        <Show when={n().claim && n().claim.by} fallback={<Time value={last()?.ts} />}>
          <span class="mono truncate" title={`claimed by ${n().claim.by}`}>{n().claim.by}</span>
        </Show>
      </span>
    </button>
  );
}

// === AttentionBlock ========================================================
// One category inside the Needs attention panel: label + count + up to
// ATTENTION_LIMIT clickable items (buttons that open NodeDetail). Rendered
// only when the category has at least one item.

function AttentionBlock(props) {
  // title  (string, required)
  // items  (array of { id, title }, required)
  const { select } = useStore();
  return (
    <div class="rounded-control border border-line bg-panel p-3">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[12px] font-semibold uppercase tracking-wider text-mute">{props.title}</span>
        <Chip>{props.items.length}</Chip>
      </div>
      <div class="mt-2 space-y-1">
        <For each={props.items.slice(0, ATTENTION_LIMIT)}>
          {(item) => (
            <button
              type="button"
              class="flex min-h-[32px] w-full items-center gap-2 rounded px-1.5 text-left hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
              onClick={() => select(item.id)}
              aria-label={`${item.id} ${item.title}`}
            >
              <span class="mono shrink-0 text-[12px] text-body">{item.id}</span>
              <span class="min-w-0 flex-1 truncate text-[12px] leading-4 text-body" title={item.title}>
                {item.title}
              </span>
            </button>
          )}
        </For>
        <Show when={props.items.length > ATTENTION_LIMIT}>
          <div class="px-1.5 text-[12px] text-mute">
            +{props.items.length - ATTENTION_LIMIT} more
          </div>
        </Show>
      </div>
    </div>
  );
}

// === Overview ==============================================================
export default function Overview() {
  const { snapshot, select, setRoute, lastSuccessfulAt, refreshing, snapshotError } = useStore();
  const s = () => snapshot();
  const sum = () => s()?.summary || {};
  const derived = () => s()?.derived || { ready: [], blocked: [], backlog: [], openGates: [] };
  const nodes = () => s()?.nodes || {};
  const lastActivity = () => s()?.last_activity || {};

  // === 1. Header context ===================================================
  const projectName = () => projectDisplayName(s());
  const projectRoot = () => s()?.project?.root || "";
  const totalNodes = () => sum().total_nodes || 0;
  const lastRefresh = () => lastSuccessfulAt() || s()?.generated_at;

  // === 2. Global alerts grouped by kind ====================================
  const alertsByKind = createMemo(() => groupAlertsByKind(s()?.alerts));

  // === 3. Operational status metrics ========================================
  const metrics = createMemo(() => buildMetrics(sum()));

  // === 4. Work now =========================================================
  const readyTasksMemo = createMemo(() => readyTasks(derived(), nodes()));
  const inProgressTasksMemo = createMemo(() => inProgressTasks(nodes()));

  // === 5. Needs attention ==================================================
  const attentionBlocks = createMemo(() =>
    buildAttentionBlocks({ alerts: s()?.alerts, derived: derived(), nodes: nodes() })
  );
  const hasAttentionItems = createMemo(() => attentionBlocks().length > 0);

  return (
    <div class="mx-auto max-w-[1440px] p-4 md:p-6">
      {/* 1. Header */}
      <PageHeader
        eyebrow="Registered Climier work only"
        title={projectName()}
        subtitle={projectRoot()}
        meta={`${totalNodes()} nodes`}
        right={
          <LiveStatus
            lastAt={lastRefresh()}
            refreshing={refreshing()}
            error={snapshotError()}
          />
        }
      />

      {/* 2. Global alerts grouped by kind */}
      <Show when={alertsByKind().length > 0}>
        <div class="mt-6 space-y-3">
          <For each={alertsByKind()}>
            {([kind, alerts]) => (
              <AlertBanner tone={ALERT_TONES[kind] || "warning"} title={ALERT_TITLES[kind] || kind}>
                <div class="space-y-1">
                  <For each={alerts}>
                    {(a) => (
                      <div class="flex items-start gap-2">
                        <Show
                          when={a.node_id}
                          fallback={<span class="mono text-[12px]">{a.message}</span>}
                        >
                          <button
                            type="button"
                            class="flex min-h-[28px] items-center gap-2 rounded px-1 text-left hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
                            onClick={() => select(a.node_id)}
                          >
                            <span class="mono shrink-0 text-[12px]">{a.node_id}</span>
                            <span class="truncate text-[12px]">{a.message}</span>
                          </button>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </AlertBanner>
            )}
          </For>
        </div>
      </Show>

      {/* 3. Operational status — 4 primary metrics, real buttons to Board */}
      <div class="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <For each={metrics()}>
          {(m) => (
            <MetricCard
              value={m.value}
              label={m.label}
              explanation={m.explanation}
              tone={m.tone}
              onClick={() => setRoute("board")}
            />
          )}
        </For>
      </div>

      {/* 4. Work now — real ready / in-progress task lists */}
      <div class="mt-6 grid gap-4 lg:grid-cols-2">
        <Panel
          title="Ready now"
          eyebrow="Work now"
          right={
            <Show when={(sum().ready || 0) > WORK_LIMIT}>
              <button
                type="button"
                class="inline-flex min-h-[36px] items-center rounded-control border border-line bg-panel-2 px-3 text-[12px] text-body hover:bg-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
                onClick={() => setRoute("board")}
              >
                View all {sum().ready}
              </button>
            </Show>
          }
        >
          <Show
            when={readyTasksMemo().length > 0}
            fallback={<EmptyState variant="compact" title="No ready tasks right now." />}
          >
            <div class="space-y-2">
              <For each={readyTasksMemo()}>
                {(n) => <WorkRow node={n} status="ready" lastActivity={lastActivity()} />}
              </For>
            </div>
          </Show>
        </Panel>

        <Panel
          title="In progress"
          eyebrow="Work now"
          right={
            <Show when={(sum().in_progress || 0) > WORK_LIMIT}>
              <button
                type="button"
                class="inline-flex min-h-[36px] items-center rounded-control border border-line bg-panel-2 px-3 text-[12px] text-body hover:bg-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
                onClick={() => setRoute("board")}
              >
                View all {sum().in_progress}
              </button>
            </Show>
          }
        >
          <Show
            when={inProgressTasksMemo().length > 0}
            fallback={<EmptyState variant="compact" title="Nothing in progress right now." />}
          >
            <div class="space-y-2">
              <For each={inProgressTasksMemo()}>
                {(n) => <WorkRow node={n} status="in_progress" lastActivity={lastActivity()} />}
              </For>
            </div>
          </Show>
        </Panel>
      </div>

      {/* 5. Needs attention — only when there is something to coordinate */}
      <div class="mt-6">
        <Panel title="Needs attention">
          <Show
            when={hasAttentionItems()}
            fallback={
              <EmptyState variant="compact" title="No immediate coordination issues" />
            }
          >
            <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <For each={attentionBlocks()}>
                {(block) => <AttentionBlock title={block.title} items={block.items} />}
              </For>
            </div>
          </Show>
        </Panel>
      </div>
    </div>
  );
}
