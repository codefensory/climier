// Overview view — Fase 4 pieza core (T-ui-overview-core).
//
// Contract: docs/ui-redesign-plan.md section 5 points 1-5 and section 6
// Fase 4. This piece implements the operational core of the overview:
//
//   1. Header: project name/base, "Registered Climier work only", and total
//      nodes as context. The global refresh/read-only state lives in the
//      shell's floating indicator.
//   2. Global alerts only when they exist (state-read-error, stale claims,
//      anomalous blockers), grouped by kind with AlertBanner.
//   3. Operational status: 4 primary metrics (Ready / In progress /
//      Blocked / Backlog), each with a number, a one-line explanation and
//      navigation to Board/Tasks with a filter — MetricCard is a real
//      <button> with a real destination.
//   4. Work now: real lists of ready tasks (max 4) and in-progress tasks
//      (max 4). Row = status, id, title, initiative, claim/last activity.
//      Click opens NodeDetail via store.select(id).
//   5. Needs attention: stale, blocked, open gates, open decisions,
//      placeholders. When everything is zero, a single compact line
//      "No immediate coordination issues" — no dashed empty cards.
//
//   6. Initiatives: one card per initiative (including registered ones
//      with no nodes), description merged from state.initiatives with the
//      server's initiative_summary breakdown, task total, a segmented bar
//      by task states (never mixing kinds), open gates.
//   7. Recent activity (max 8): relative time with absolute timestamp in
//      the tooltip, humanized action, agent, node title+id, note preview;
//      add-node events normalized (node_id from note) and clickable to
//      NodeDetail; no duplicate (action, node) rows.
//   8. Project record: compact linked rows for done / archived / canceled /
//      superseded / resolved gates / active+deprecated knowledge, each
//      navigating to the view that owns that entity.
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

import { Show, For, createMemo, onCleanup } from "solid-js";
import { useStore, useStoreSelectors } from "../store.jsx";
import { projectDisplayName } from "../shell.mjs";
import {
  PageHeader,
  PageLayout,
  Panel,
  MetricCard,
  StatusBadge,
  Chip,
  AlertBanner,
  EmptyState,
  Time,
  ProgressBar,
} from "../components.jsx";

export const WORK_LIMIT = 4;
export const ATTENTION_LIMIT = 4;
export const ACTIVITY_LIMIT = 8;

// === Stable collection identity (ADR-010 §3.3 / plan §3.4) ================
// Every poll rebuilds the aggregates below from a fresh snapshot, so a
// `<For>` keyed by object reference used to remount every metric card,
// alert group, attention block, initiative card and activity row even when
// nothing changed. The reconciliation below is the same pattern Activity
// already uses: a per-component cache maps a deterministic key to the last
// object emitted for it, and an equal recomputation reuses that reference.
//
// The node entities themselves come from the reactive store
// (`useStoreSelectors().nodesMap()`), which reconciles them in place, so
// rows built directly out of nodes are already reference-stable and the
// `a === b` fast path below short-circuits without walking a store proxy.

function sameData(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const arrayA = Array.isArray(a);
  if (arrayA !== Array.isArray(b)) return false;
  if (arrayA) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!sameData(a[k], b[k])) return false;
  }
  return true;
}

// Per-component identity cache. `reconcile(list, keyOf)` returns a list of
// the same length and order where every entry whose key + content did not
// change keeps its previous reference. Keys that fall out of the list are
// pruned so they can come back later as a fresh mount.
function makeKeyedCache() {
  const map = new Map();
  function reconcile(list, keyOf) {
    const next = [];
    const seen = new Set();
    for (const item of list || []) {
      const key = keyOf(item);
      if (key == null || key === "") {
        next.push(item);
        continue;
      }
      seen.add(key);
      const prev = map.get(key);
      if (prev !== undefined && sameData(prev, item)) {
        next.push(prev);
      } else {
        map.set(key, item);
        next.push(item);
      }
    }
    for (const key of Array.from(map.keys())) if (!seen.has(key)) map.delete(key);
    return next;
  }
  function clear() {
    map.clear();
  }
  return { reconcile, clear };
}

// Stable key for an activity preview row: the durable `event_id` when the
// server emits it, otherwise the `ts::action::agent::node_id` tuple that
// the Activity view already uses (plan §3.4).
export function activityKey(entry) {
  if (!entry) return "";
  if (entry.event_id != null && entry.event_id !== "") return String(entry.event_id);
  return `${entry.ts || ""}::${entry.action || ""}::${entry.agent || ""}::${entry.node_id || ""}`;
}

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

// Shell-level alerts (F7a): kinds the shell banner owns. state-read-error is
// surfaced by Main above the route on every view, so the Overview page
// filters it from its per-kind groups to avoid showing the same critical
// alert twice.
export const SHELL_ALERT_KINDS = new Set(["state-read-error"]);

// The alerts the Overview page renders itself. Everything the shell owns
// (see SHELL_ALERT_KINDS) is dropped here; the shell banner already covers
// it. Unknown kinds stay visible so future alert types still surface.
export function pageAlerts(alerts) {
  return (alerts || []).filter((a) => !(a && a.kind && SHELL_ALERT_KINDS.has(a.kind)));
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

// Submitted tasks from the explicit lifecycle pool. They are intentionally
// separate from ready/blocked work: submitted means a worker handed the task
// to an independent validator, not that it is available to claim.
export function submittedTasks(derived, nodes, limit = WORK_LIMIT) {
  return (derived && derived.submitted || [])
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

// === Activity helpers (point 7) ============================================
// Recent activity is capped at ACTIVITY_LIMIT events. Rows are normalized
// from the server's `recent_activity` snapshot array so legacy add-node log
// entries (node id lives only in the note) stay clickable, and repeated
// bookkeeping for the same (action, node) is collapsed so the 8 slots show
// distinct activity instead of a run of identical events.

// Humanized titles for log actions the CLI emits today. Unknown actions fall
// back to the raw action so future log surface still renders a readable row.
export const ACTION_LABELS = {
  "add-node": "Node added",
  "add-edge": "Edge added",
  "add-note": "Note added",
  "deprecate-knowledge": "Knowledge deprecated",
  take: "Claimed",
  release: "Released",
  resolve: "Resolved",
  reopen: "Reopened",
  cancel: "Canceled",
  update: "Updated",
  supersede: "Superseded",
};

export function humanizeAction(action) {
  return ACTION_LABELS[action] || String(action || "event");
}

// Resolve the canonical node id for an activity entry. The server exposes
// `node_id`; legacy entries carry `node`/`task` aliases; and pre-normalization
// add-node entries only have the new id in the note (add-node appends
// note = id). Returns null when no id can be derived.
export function activityNodeId(entry) {
  if (!entry) return null;
  if (entry.node_id) return entry.node_id;
  if (entry.node || entry.task) return entry.node || entry.task;
  if (entry.action === "add-node") return entry.note || null;
  return null;
}

// Normalized recent-activity rows (point 7). Drops entries whose node is not
// present in the snapshot (they could not open a NodeDetail), decorates with
// the current title, collapses duplicate (action, node_id) events and caps
// the list at ACTIVITY_LIMIT.
export function recentActivity(entries, nodes, limit = ACTIVITY_LIMIT) {
  const byId = nodes || {};
  const out = [];
  const seen = new Set();
  for (const raw of entries || []) {
    const nodeId = activityNodeId(raw);
    if (!nodeId || !byId[nodeId]) continue;
    const key = `${raw.action || ""}::${nodeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...raw,
      node_id: nodeId,
      node_title: raw.node_title || byId[nodeId].title || null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// === Initiative helpers (point 6) ==========================================
// Merge the registered initiatives map (state.initiatives — carries the
// description) with the server's initiative_summary breakdown (counts by
// kind). Registered initiatives without any node still produce a row with
// zero counts; summary entries not present in the registered map produce a
// row with an empty description (defensive against drift).

function zeroInitiativeBreakdown() {
  return {
    tasks: { total: 0, ready: 0, in_progress: 0, blocked: 0, backlog: 0, done: 0, archived: 0, canceled: 0 },
    gates: { total: 0, open: 0, resolved: 0, superseded: 0 },
    knowledge: { total: 0, active: 0, deprecated: 0 },
  };
}

// Ordering contract: attention/activity first, then alphabetical. Attention
// is the open/active work an operator would scan for: tasks being worked,
// blocked, ready to claim, plus open gates. Backlog/done are parked or
// closed, so they do not pull an initiative to the top.
export function initiativeRows(initiatives, summary) {
  const registered = initiatives || {};
  const byName = new Map();
  for (const name of Object.keys(registered)) {
    byName.set(name, { desc: (registered[name] && registered[name].desc) || "", entry: null });
  }
  for (const entry of summary || []) {
    if (!entry || !entry.initiative) continue;
    byName.set(entry.initiative, {
      desc: (registered[entry.initiative] && registered[entry.initiative].desc) || "",
      entry,
    });
  }
  const rows = [];
  for (const [initiative, info] of byName) {
    const byKind = (info.entry && info.entry.by_kind) || zeroInitiativeBreakdown();
    const t = byKind.tasks || {};
    const g = byKind.gates || {};
    rows.push({
      initiative,
      desc: info.desc,
      total: t.total || 0,
      by_kind: byKind,
      attention:
        (t.ready || 0) + (t.in_progress || 0) + (t.submitted || 0) + (t.blocked || 0) + (g.open || 0),
    });
  }
  rows.sort(
    (a, b) => b.attention - a.attention || a.initiative.localeCompare(b.initiative)
  );
  return rows;
}

// Segments for the initiative progress bar. Task states only — the bar never
// mixes gates/knowledge into the same percentage (the plan forbids a
// percentage that conflates kinds).
export const TASK_SEGMENTS = [
  ["ready", "Ready"],
  ["in_progress", "In progress"],
  ["blocked", "Blocked"],
  ["backlog", "Backlog"],
  ["done", "Done"],
  ["archived", "Archived"],
  ["canceled", "Canceled"],
];

export function initiativeSegments(row) {
  const t = (row && row.by_kind && row.by_kind.tasks) || {};
  return TASK_SEGMENTS.map(([tone, label]) => ({
    tone,
    label,
    count: t[tone] || 0,
  }));
}

// === Project record helpers (point 8) ======================================
// Compact linked rows over the summary counters. Every row navigates to the
// view that owns that entity: task statuses to Tasks, gate statuses to Gates,
// knowledge statuses to Knowledge. Superseded can in principle touch any
// kind, but the closest single home is the Gates view's All tab (superseding
// is primarily a gate/ADR-history concept); this is a presentation choice,
// not a re-derivation of the DAG.
export function projectRecord(summary) {
  const s = summary || {};
  return [
    { key: "done", label: "Done", value: s.done || 0, nav: "tasks" },
    { key: "archived", label: "Archived", value: s.archived || 0, nav: "tasks" },
    { key: "canceled", label: "Canceled", value: s.canceled || 0, nav: "tasks" },
    { key: "superseded", label: "Superseded", value: s.superseded || 0, nav: "gates" },
    { key: "resolved_gates", label: "Resolved gates", value: s.resolved_gates || 0, nav: "gates" },
    { key: "active_knowledge", label: "Active knowledge", value: s.active_knowledge || 0, nav: "knowledge" },
    { key: "deprecated_knowledge", label: "Deprecated knowledge", value: s.deprecated_knowledge || 0, nav: "knowledge" },
  ];
}

// === WorkRow ===============================================================
// One row in the Work now lists. Real <button>; opens NodeDetail via
// store.select. Shows status, id, title, initiative and claim/last activity.

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
      class="ui-list-row flex min-h-[44px] w-full items-center gap-3 rounded-control border border-line bg-panel px-3 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
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
    <div class="ui-detail-card rounded-control border border-line bg-panel p-3">
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

// === ActivityRow ===========================================================
// One recent-activity event (point 7). A real <button>: opens NodeDetail via
// store.select. Shows relative time (Time renders the absolute timestamp in
// its tooltip), the humanized action, the agent, the node title+id and a
// one-line note preview. Rendered only for events whose node still exists,
// so the button always has a real detail to open.

function ActivityRow(props) {
  // entry (object, required — normalized activity entry from recentActivity)
  const { select } = useStore();
  const e = () => props.entry || {};
  const note = () => (e().note ? String(e().note).trim() : "");
  return (
    <button
      type="button"
      class="ui-list-row flex min-h-[44px] w-full items-start gap-3 rounded-control border border-line bg-panel px-3 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
      onClick={() => select(e().node_id)}
      aria-label={`${humanizeAction(e().action)} ${e().node_id} ${e().node_title || ""}`}
    >
      <Time value={e().ts} />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span class="text-[12px] font-medium text-ink">{humanizeAction(e().action)}</span>
          <Show when={e().agent}>
            <span class="mono truncate text-[12px] text-mute">{e().agent}</span>
          </Show>
        </div>
        <div class="mt-0.5 flex min-w-0 items-center gap-2">
          <span class="mono shrink-0 text-[12px] text-body">{e().node_id}</span>
          <span class="min-w-0 flex-1 truncate text-[13px] leading-5 text-ink" title={e().node_title || ""}>
            {e().node_title || ""}
          </span>
        </div>
        <Show when={note()}>
          <div class="mt-0.5 truncate text-[12px] leading-4 text-mute" title={note()}>
            {note()}
          </div>
        </Show>
      </div>
    </button>
  );
}

// === InitiativeCard ========================================================
// One initiative (point 6): name, description, task total, segmented bar by
// task states (ProgressBar) and open gates. Informational — there is no
// initiative route to navigate to.

function InitiativeCard(props) {
  // row (object, required — from initiativeRows)
  const row = () => props.row || {};
  const byKind = () => row().by_kind || {};
  const tasks = () => byKind().tasks || {};
  const openGates = () => (byKind().gates || {}).open || 0;
  return (
    <div class="ui-detail-card rounded-control border border-line bg-panel p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h4 class="truncate text-[14px] font-semibold text-ink">{row().initiative}</h4>
          <Show when={row().desc}>
            <p class="mt-0.5 line-clamp-2 text-[12px] leading-4 text-mute">{row().desc}</p>
          </Show>
        </div>
        <Chip>{tasks().total || 0} tasks</Chip>
      </div>
      <div class="mt-3">
        <ProgressBar segments={initiativeSegments(row())} />
      </div>
      <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] leading-4 text-mute">
        <span>Submitted: <span class="tabular-nums">{tasks().submitted || 0}</span></span>
        <span>Open gates: <span class="tabular-nums">{openGates()}</span></span>
      </div>
    </div>
  );
}

// === RecordRow =============================================================
// One compact project-record line (point 8). A real <button>: navigates to
// the view that owns that entity via setRoute.

function RecordRow(props) {
  // row (object, required — { label, value, nav } from projectRecord)
  const { setRoute } = useStore();
  const r = () => props.row || {};
  return (
    <button
      type="button"
      class="ui-list-row flex min-h-[32px] w-full items-center justify-between gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
      onClick={() => setRoute(r().nav)}
      aria-label={`${r().label}: ${r().value}`}
    >
      <span class="truncate text-[12px] text-body">{r().label}</span>
      <span class="tabular-nums shrink-0 text-[13px] font-semibold text-ink">{r().value}</span>
    </button>
  );
}

// === Overview ==============================================================
export default function Overview() {
  const { snapshot, select, setRoute } = useStore();
  const selectors = useStoreSelectors();
  const s = () => snapshot();
  const sum = () => s()?.summary || {};
  const derived = () => s()?.derived || { ready: [], blocked: [], backlog: [], openGates: [] };
  // Node entities come from the reconciled store slice, so an unchanged
  // node keeps the same reference across polls and every row built from it
  // stays mounted. The snapshot stays the source for everything that is not
  // an entity (summary, alerts, initiative_summary, recent_activity).
  const nodes = () => (selectors ? selectors.nodesMap() : s()?.nodes || {});
  const lastActivity = () => s()?.last_activity || {};

  // Identity caches, one per collection (see makeKeyedCache above).
  const metricsCache = makeKeyedCache();
  const alertGroupsCache = makeKeyedCache();
  const attentionCache = makeKeyedCache();
  const initiativesCache = makeKeyedCache();
  const activityCache = makeKeyedCache();
  const recordCache = makeKeyedCache();
  onCleanup(() => {
    metricsCache.clear();
    alertGroupsCache.clear();
    attentionCache.clear();
    initiativesCache.clear();
    activityCache.clear();
    recordCache.clear();
  });

  // === 1. Header context ===================================================
  const projectName = () => projectDisplayName(s());
  const projectRoot = () => s()?.project?.root || "";
  const totalNodes = () => sum().total_nodes || 0;
  // === 2. Global alerts grouped by kind ====================================
  // Shell-owned kinds (state-read-error) render as the Main-level banner;
  // this section groups only the page-level alerts. Groups are keyed by
  // kind so an identical poll keeps the banner (and its rows) mounted.
  const alertsByKind = createMemo(() =>
    alertGroupsCache.reconcile(
      groupAlertsByKind(pageAlerts(s()?.alerts)),
      (group) => group[0]
    )
  );

  // === 3. Operational status metrics ========================================
  const metrics = createMemo(() =>
    metricsCache.reconcile(buildMetrics(sum()), (m) => m.key)
  );

  // === 4. Work now =========================================================
  const readyTasksMemo = createMemo(() => readyTasks(derived(), nodes()));
  const submittedTasksMemo = createMemo(() => submittedTasks(derived(), nodes()));
  const inProgressTasksMemo = createMemo(() => inProgressTasks(nodes()));

  // === 5. Needs attention ==================================================
  const attentionBlocks = createMemo(() =>
    attentionCache.reconcile(
      buildAttentionBlocks({ alerts: s()?.alerts, derived: derived(), nodes: nodes() }),
      (block) => block.title
    )
  );
  const hasAttentionItems = createMemo(() => attentionBlocks().length > 0);

  // === 6. Initiatives ======================================================
  const initiativeRowsMemo = createMemo(() =>
    initiativesCache.reconcile(
      initiativeRows(s()?.initiatives, s()?.initiative_summary),
      (row) => row.initiative
    )
  );

  // === 7. Recent activity (max 8) ==========================================
  const activityMemo = createMemo(() =>
    activityCache.reconcile(recentActivity(s()?.recent_activity, nodes()), activityKey)
  );

  // === 8. Project record ===================================================
  const recordMemo = createMemo(() =>
    recordCache.reconcile(projectRecord(sum()), (r) => r.key)
  );

  return (
    <PageLayout>
      {/* 1. Header */}
      <PageHeader
        eyebrow="Registered Climier work only"
        title={projectName()}
        subtitle={projectRoot()}
        meta={`${totalNodes()} nodes`}
      />

      {/* 2. Global alerts grouped by kind */}
      <Show when={alertsByKind().length > 0}>
        <div class="space-y-3">
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
                            class="flex min-h-[32px] items-center gap-2 rounded px-1 text-left hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
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
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
      <div class="grid gap-4 lg:grid-cols-2">
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

      {/* Submitted is a validation queue, not active labor. Keep it visible
          as a distinct read-only panel without adding it to the four primary
          operational metrics or treating it as ready/blocked. */}
      <Show when={(sum().submitted || 0) > 0}>
        <Panel
          title="Submitted"
          eyebrow="Validation queue"
          right={
            <button
              type="button"
              class="inline-flex min-h-[36px] items-center rounded-control border border-line bg-panel-2 px-3 text-[12px] text-body hover:bg-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
              onClick={() => setRoute("board")}
            >
              View all {sum().submitted}
            </button>
          }
        >
          <Show
            when={submittedTasksMemo().length > 0}
            fallback={<EmptyState variant="compact" title="No submitted tasks." />}
          >
            <div class="space-y-2">
              <For each={submittedTasksMemo()}>
                {(n) => <WorkRow node={n} status="submitted" lastActivity={lastActivity()} />}
              </For>
            </div>
          </Show>
        </Panel>
      </Show>

      {/* 5. Needs attention — only when there is something to coordinate */}
      <div>
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

      {/* 6. Initiatives — one card per initiative, segmented by task states */}
      <div>
        <Panel title="Initiatives">
          <Show
            when={initiativeRowsMemo().length > 0}
            fallback={<EmptyState variant="compact" title="No initiatives registered." />}
          >
            <div class="grid gap-3 lg:grid-cols-2">
              <For each={initiativeRowsMemo()}>
                {(row) => <InitiativeCard row={row} />}
              </For>
            </div>
          </Show>
        </Panel>
      </div>

      {/* 7+8. Recent activity + Project record — 8/4 column split */}
      <div class="grid gap-4 lg:grid-cols-12">
        <div class="lg:col-span-8">
          <Panel
            title="Recent activity"
            right={
              <Show when={activityMemo().length >= ACTIVITY_LIMIT}>
                <button
                  type="button"
                  class="inline-flex min-h-[36px] items-center rounded-control border border-line bg-panel-2 px-3 text-[12px] text-body hover:bg-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
                  onClick={() => setRoute("activity")}
                >
                  View all
                </button>
              </Show>
            }
          >
            <Show
              when={activityMemo().length > 0}
              fallback={<EmptyState variant="compact" title="No activity yet." />}
            >
              <div class="space-y-2">
                <For each={activityMemo()}>
                  {(e) => <ActivityRow entry={e} />}
                </For>
              </div>
            </Show>
          </Panel>
        </div>
        <div class="lg:col-span-4">
          <Panel title="Project record">
            <div class="space-y-0.5">
              <For each={recordMemo()}>
                {(r) => <RecordRow row={r} />}
              </For>
            </div>
          </Panel>
        </div>
      </div>
    </PageLayout>
  );
}
