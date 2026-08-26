// NodeDetail — drawer for a single node.
//
// Scope (Fase 6 per docs/ui-redesign-plan.md section 6-Fase 6):
//   1. Sticky header with back/close, real kind (task/gate/knowledge — never
//      the umbrella 'resolvable'), status, id and revision.
//   2. Title in the 20-24 px range (the `text-page` token).
//   3. Summary card: status, initiative, claim (using claim.at per the
//      Fase 1 contract), revision and last activity timestamp.
//   4. Visible callout for blocked, stale or superseded via AlertBanner.
//   5. Specification stays in the main reading flow; blockers live in the
//      right rail on desktop and fall back into the main flow on narrow screens.
//   6. Notes stay in the main reading flow after blockers; knowledge, refs,
//      relationships and the read-only CLI command remain progressively
//      disclosed below. History lives in the right-rail Activity tab.
//   7. Times use claim.at (Time/ClaimTime prefer claim.at over claim.ts).
//   8. Relationships are split by direction/type (F6b, T-ui-detail-rel):
//      incoming blockers stay in the open right-rail Blockers panel; outgoing
//      are grouped into Blocks / Derived from / Supersedes / Informing
//      inside one collapsible Relationships zone. The drawer never
//      re-derives the DAG — it only re-groups what /api/node/:id returns.
//   9. Back navigates within the drawer (blocker -> node -> back) and only
//      closes when there is no history (F6b).
//  10. Basic focus trap keeps Tab inside the dialog (F6b).

import { Show, For, createMemo, createSignal, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { useStore } from "../store.jsx";
import {
  AlertBanner,
  Chip,
  ClaimTime,
  EmptyState,
  IconButton,
  KindBadge,
  Panel,
  StatusBadge,
  Time,
} from "../components.jsx";

// === Relationship + navigation helpers (pure, exported for tests) ==========
// The drawer splits the server's `dependents` array (outgoing edges of every
// type) plus `blocking`/`superseded_by` into direction-aware groups so each
// relationship kind gets its own zone. This is presentation logic only: the
// derivation itself stays in src/v2.mjs / the server.
//
// Informational edge types (INFORMS, RELATES_TO, CONFLICTS_WITH) are
// retained for reading older state; they are grouped together as informing
// edges.
export function splitRelationships(detail) {
  const dependents = Array.isArray(detail && detail.dependents) ? detail.dependents : [];
  const outBlocks = dependents.filter((e) => e && e.edge_type === "BLOCKS");
  const derivedFrom = dependents.filter((e) => e && e.edge_type === "DERIVED_FROM");
  const supersedes = dependents.filter((e) => e && e.edge_type === "SUPERSEDES");
  const informing = dependents.filter((e) =>
    e && ["INFORMS", "RELATES_TO", "CONFLICTS_WITH"].includes(e.edge_type)
  );
  const supersededBy =
    (detail && detail.superseded_by) ||
    (detail && detail.node && detail.node.superseded_by) ||
    null;
  return { outBlocks, derivedFrom, supersedes, informing, supersededBy };
}

// Drawer back-history. Navigating from A to B while the drawer is open
// records A so Back can return without closing; closing the drawer (next id
// null) resets the stack. Pure so the contract is unit-testable without DOM.
export function pushHistory(stack, fromId, toId) {
  if (!toId) return [];
  if (!fromId || fromId === toId) return stack || [];
  return [...(stack || []), fromId];
}

export function popHistory(stack) {
  const s = stack || [];
  if (!s.length) return { stack: [], back: null };
  return { stack: s.slice(0, -1), back: s[s.length - 1] };
}

// Brief human-language rationale for each derived/persisted status. Used
// in the summary card so the user does not have to guess what a status
// means when the rest of the drawer is collapsed.
const EXPLAIN = {
  ready: "Derived: no unsatisfied blockers — an agent can take this task.",
  blocked: "Derived: at least one BLOCKS edge from an unsatisfied blocker keeps this from being ready.",
  backlog: "Persisted: deliberately kept out of the ready pool until promoted.",
  in_progress: "Persisted: claimed and being worked on.",
  open: "Persisted: a gate (decision/approval/research) that is not resolved yet. It can block tasks via BLOCKS.",
  done: "Persisted: resolved with a verification note.",
  resolved: "Persisted: the gate was closed with a choice and rationale.",
  canceled: "Persisted: terminated without resolving.",
  superseded: "Persisted: replaced by another node via SUPERSEDES.",
  deprecated: "Persisted: no longer applicable; kept for the record.",
};

// Build the equivalent CLI command string for a given node + derived
// status. Returns null when there's no command (knowledge nodes have no
// labor surface). The drawer's command block renders this verbatim — never
// executes it.
function equivalentCommand(node, derived) {
  const id = node.id;
  if (node.kind === "knowledge") return null;
  if (node.subkind === "gate") return `climier context ${id}   # read blockers, knowledge, allowed actions`;
  if (node.status === "in_progress") return `climier add-note ${id} "..." --as <agent>`;
  if (derived === "ready") return `climier take ${id} --as <agent>`;
  if (derived === "blocked") return `climier context ${id}   # see which blocker gates it`;
  if (node.status === "done") return `climier reopen ${id} --reason "..." --as <agent>`;
  return null;
}

// Best-effort timestamp for the "last activity" tile in the summary. We
// prefer the most recent log entry that names this node; falling back to
// any timestamp we have on the node (done_at, claim.at, claim.ts).
function lastActivityTs(detail, lastActivityIndex) {
  const la = lastActivityIndex && lastActivityIndex[detail.node.id];
  if (la && la.ts) return la.ts;
  if (detail.node.done_at) return detail.node.done_at;
  if (detail.node.claim && (detail.node.claim.at || detail.node.claim.ts)) {
    return detail.node.claim.at || detail.node.claim.ts;
  }
  return null;
}

// Filter the snapshot's `alerts[]` down to ones that belong to the open
// node. Each alert already carries `node_id`, `kind`, `severity`, and
// `message` per the Fase 1 contract.
function alertsForNode(alerts, id) {
  if (!Array.isArray(alerts) || !id) return [];
  return alerts.filter((a) => a && a.node_id === id);
}

// Escape a value for use inside an HTML attribute. Solid escapes text nodes
// automatically, but SSR serializes attribute values verbatim, so a ref
// target like `<script>alert(1)</script>` must not end up raw in title=.
function escapeAttr(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// === Copy-to-clipboard helper ===============================================
// Lives inline because it's a single-button concern; promoting it to
// components.jsx would force every consumer to depend on it.
function CopyButton(props) {
  // text (string, required)
  const [copied, setCopied] = createSignal(false);
  async function copy() {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(props.text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = props.text;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* swallow — clipboard is best-effort */
    }
  }
  return (
    <IconButton size="sm" label={copied() ? "Copied" : "Copy"} onClick={copy}>
      <span class="text-[12px]" aria-hidden="true">{copied() ? "✓" : "⧉"}</span>
    </IconButton>
  );
}

// === Drawer =================================================================

export default function NodeDetail() {
  const { selectedId, select, detail, detailError, snapshot } = useStore();
  const d = () => detail();

  // Pull the snapshot's last_activity map so the summary card can show a
  // recent timestamp without having to inspect history itself.
  const lastActivityMap = () => snapshot()?.last_activity || {};

  // Alerts scoped to this node; drives the banner.
  const nodeAlerts = createMemo(() => alertsForNode(snapshot()?.alerts, selectedId()));

  // The drawer is open only when a node is selected. We deliberately keep
  // it in the DOM (Portal) so the focus management contract can run.
  const open = () => Boolean(selectedId());

  // Focus + keyboard contract for the dialog:
  //  - opening moves focus inside the drawer
  //  - navigating between nodes keeps the drawer open and records history
  //  - Back returns to the previous node (closes only when there is no
  //    history)
  //  - Escape closes the drawer
  //  - Tab cycles inside the drawer (basic focus trap)
  //  - previous focus is restored on close
  let drawerRef;
  let restoreFocusEl = null;
  let prevSelected = null;
  const [openedAt, setOpenedAt] = createSignal(null);
  const [navStack, setNavStack] = createSignal([]);
  const [closing, setClosing] = createSignal(false);

  function requestClose() {
    if (closing()) return;
    setClosing(true);
  }

  function finishClose(e) {
    if (
      e.target !== e.currentTarget ||
      e.animationName !== "ui-drawer-detail-out" ||
      !closing()
    ) return;
    // Keep the node selected until the exit frame completes so the panel does
    // not flash empty while it leaves the screen.
    select(null);
    setClosing(false);
  }

  function goBack() {
    const { stack, back } = popHistory(navStack());
    setNavStack(stack);
    if (back) select(back);
    else requestClose();
  }

  createEffect(() => {
    const id = selectedId();
    if (id) {
      // A new selection while the exit is running cancels the exit and keeps
      // navigation inside the same dialog.
      setClosing(false);
      if (prevSelected === null) {
        // Fresh open: capture the element that opened us so close can
        // restore focus. Navigation inside the drawer must not overwrite it.
        if (typeof document !== "undefined") {
          restoreFocusEl = document.activeElement;
        }
      } else {
        // Navigation while the drawer is already open: remember where we
        // came from so Back returns without closing.
        setNavStack((s) => pushHistory(s, prevSelected, id));
      }
      setOpenedAt(Date.now());
      // Defer focus until the drawer has rendered.
      queueMicrotask(() => {
        const root = drawerRef;
        if (root && typeof root.focus === "function") {
          root.focus();
        }
      });
    } else {
      setOpenedAt(null);
      setNavStack([]);
      if (restoreFocusEl && typeof restoreFocusEl.focus === "function") {
        try { restoreFocusEl.focus(); } catch {}
      }
      restoreFocusEl = null;
    }
    prevSelected = id;
  });

  function handleKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      requestClose();
      return;
    }
    // Basic focus trap: when focus reaches the first/last focusable element
    // inside the drawer, Tab / Shift+Tab wraps around instead of leaving the
    // dialog. This is deliberately lightweight — the drawer is the only
    // interactive surface while open.
    if (e.key === "Tab") {
      const root = drawerRef;
      if (!root || typeof document === "undefined") return;
      const focusables = Array.from(
        root.querySelectorAll(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  onCleanup(() => {
    if (restoreFocusEl && typeof restoreFocusEl.focus === "function") {
      try { restoreFocusEl.focus(); } catch {}
    }
  });

  // The drawer shell uses <Portal> in the browser (mounts above the view's
  // stacking context, restores scroll behaviour naturally). In SSR there is
  // no DOM to portal into and solid-js/web's Portal emits nothing, so tests
  // (renderToString) and any future server-side rendering fall back to the
  // plain inline tree. The focus/Escape contract lives on the shared <aside>.
  const isServer = typeof document === "undefined";

  const drawerMarkup = (
    <aside
      ref={drawerRef}
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-label={d()?.node ? `Detail for ${d().node.title || d().node.id}` : "Node detail"}
      onKeyDown={handleKeyDown}
      class="ui-drawer ui-drawer-detail fixed right-3 top-3 bottom-3 z-50 flex w-[min(1120px,calc(100vw-48px))] flex-col overflow-hidden rounded-[18px] border border-line bg-panel shadow-md"
      classList={{ "ui-drawer-detail--closing": closing() }}
      onAnimationEnd={finishClose}
    >
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header class="ui-drawer-topbar sticky top-0 relative z-10 grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-line px-3">
        <div class="flex min-w-0 items-center gap-2">
          <IconButton size="sm" label="Back" onClick={goBack}>
            <span class="text-[14px]" aria-hidden="true">←</span>
          </IconButton>
        </div>
        <div class="flex min-w-0 items-center gap-2 overflow-hidden text-[13px]">
          <span class="mono hidden shrink-0 text-[12px] text-mute sm:inline" title={d()?.node?.id}>{d()?.node?.id}</span>
          <span class="hidden text-mute sm:inline" aria-hidden="true">›</span>
          <KindBadge node={d()?.node} />
          <StatusBadge status={d()?.derived_status || d()?.node?.status || "open"} />
          <span class="hidden text-mute sm:inline" aria-hidden="true">›</span>
          <strong class="min-w-0 truncate font-semibold text-ink" title={d()?.node?.title}>
            {d()?.node?.title || ""}
          </strong>
        </div>
        <div class="flex items-center justify-end gap-1">
          <span class="mono hidden px-1 text-[12px] text-mute sm:inline">rev {d()?.node?.revision || 0}</span>
          <CopyButton text={d()?.node?.id || ""} />
          <IconButton size="sm" label="Close" onClick={requestClose}>
            <span class="text-[14px]" aria-hidden="true">✕</span>
          </IconButton>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────── */}
      <div class="ui-drawer-body min-h-0 flex-1 overflow-hidden">
        <Show when={detailError()} fallback={
          <Show when={d()} fallback={
            <div role="status" aria-live="polite" class="text-[12px] text-mute">Loading node detail…</div>
          }>
            <DetailBody
              detail={d()}
              lastActivityMap={lastActivityMap()}
              nodeAlerts={nodeAlerts()}
              snapshot={snapshot()}
              onSelect={select}
            />
          </Show>
        }>
          <AlertBanner tone="error" title="Could not load this node">
            {detailError()}
          </AlertBanner>
        </Show>
      </div>
    </aside>
  );

  return (
    <Show when={open() || closing()}>
      <Show when={isServer} fallback={
        <Portal>
          <div
            class="ui-drawer-scrim fixed inset-0 z-40"
            classList={{ "ui-drawer-scrim--closing": closing() }}
            onClick={requestClose}
            aria-hidden="true"
          />
          {drawerMarkup}
        </Portal>
      }>
        <div
          class="ui-drawer-scrim fixed inset-0 z-40"
          classList={{ "ui-drawer-scrim--closing": closing() }}
          onClick={requestClose}
          aria-hidden="true"
        />
        {drawerMarkup}
      </Show>
    </Show>
  );
}

// === Body ===================================================================
// Split out so tests can render it with a literal detail object via
// renderToString (the default export is gated behind a Portal which is hard
// to render server-side without a DOM).

function DetailBody(props) {
  // props.detail          — full /api/node/:id payload
  // props.lastActivityMap — snapshot.last_activity
  // props.nodeAlerts      — alerts scoped to this node
  // props.snapshot        — store snapshot ({ nodes, edges, ... })
  // props.onSelect        — back/click handler (id -> void)
  const { detail: d, lastActivityMap, nodeAlerts, snapshot, onSelect } = props;
  const n = () => d.node;
  const lastAt = () => lastActivityTs(d, lastActivityMap);

  // Direction/type split of the relationships the server exposes (see
  // splitRelationships above). Presentation only — never re-derives the DAG.
  const rel = createMemo(() => splitRelationships(d));
  const relationshipsCount = createMemo(() => {
    const r = rel();
    return r.outBlocks.length + r.derivedFrom.length + r.supersedes.length +
      (r.supersededBy ? 1 : 0) + r.informing.length;
  });

  // Banner triage: pick the most actionable alert for the headline, list
  // the rest as muted extras. Severity > kind for ordering. The server only
  // emits stale-claim / state-read-error alerts, so when the derived status
  // itself is blocked or superseded we synthesize a banner instead of
  // silently showing none (Fase 6 spec: callout visible for blocked, stale,
  // superseded).
  const effectiveAlerts = createMemo(() => {
    const list = [...(nodeAlerts || [])];
    const kinds = new Set(list.map((a) => a && a.kind));
    if (d.derived_status === "blocked" && !kinds.has("blocked")) {
      list.push({
        kind: "blocked",
        severity: "warning",
        node_id: n().id,
        message: "This node is blocked by at least one unsatisfied blocker.",
      });
    }
    if (d.derived_status === "superseded" && !kinds.has("superseded")) {
      list.push({
        kind: "superseded",
        severity: "warning",
        node_id: n().id,
        message: d.superseded_by
          ? `This node has been superseded by ${d.superseded_by}.`
          : "This node has been superseded.",
      });
    }
    return list;
  });
  const headlineAlert = createMemo(() => {
    const list = effectiveAlerts();
    if (!list.length) return null;
    const order = { error: 0, warning: 1, info: 2 };
    const sorted = [...list].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
    return sorted[0];
  });

  return (
    <div class="ui-detail-layout">
      <main class="ui-detail-main space-y-5 p-6 lg:p-7">
        {/* ── Banner: blocked / stale / superseded / state-read-error ─── */}
      <Show when={headlineAlert()}>
        <AlertBanner
          tone={bannerTone(headlineAlert())}
          title={bannerTitle(headlineAlert())}
        >
          {headlineAlert().message}
        </AlertBanner>
        <Show when={effectiveAlerts().length > 1}>
          <div class="text-[12px] text-mute">
            +{effectiveAlerts().length - 1} more alert{effectiveAlerts().length - 1 === 1 ? "" : "s"} for this node.
          </div>
        </Show>
      </Show>

      {/* ── Title + summary ────────────────────────────────────────── */}
      <section class="ui-detail-hero">
        <h1 class="text-page leading-tight text-ink">{n().title || n().id}</h1>
        <div class="ui-summary-line mt-3 flex flex-wrap items-center gap-2 text-[12px] text-mute">
          <StatusBadge status={d.derived_status || n().status || "open"} />
          <span>Initiative <strong class="font-semibold text-body">{n().initiative || "—"}</strong></span>
          <span class="ui-summary-dot" aria-hidden="true" />
          <span>Revision <strong class="mono font-semibold text-body">{n().revision || 0}</strong></span>
          <Show when={n().claim?.by}>
            <span class="ui-summary-dot" aria-hidden="true" />
            <span>Claimed by <strong class="mono font-semibold text-body">{n().claim.by}</strong></span>
          </Show>
        </div>
      </section>

      {/* ── Specification (open by default) ─────────────────────────── */}
      <Panel title="Specification">
        <Show when={n().body} fallback={<div class="text-[13px] text-mute">No body.</div>}>
          <div class="whitespace-pre-wrap text-[13px] leading-5 text-body">{n().body}</div>
        </Show>
        <Show when={n().definition}>
          <div class="mt-3 border-t border-line pt-3">
            <div class="mono text-[11px] uppercase tracking-wider text-mute">Definition</div>
            <div class="mt-1 whitespace-pre-wrap text-[13px] leading-5 text-body">{n().definition}</div>
          </div>
        </Show>
        <Show when={n().acceptance}>
          <div class="mt-3 border-t border-line pt-3">
            <div class="mono text-[11px] uppercase tracking-wider text-mute">Acceptance</div>
            <div class="mt-1 whitespace-pre-wrap text-[13px] leading-5 text-progress">{n().acceptance}</div>
          </div>
        </Show>
        <Show when={n().resolution}>
          <div class="mt-3 rounded-control border border-progress/40 bg-progress-soft p-3">
            <div class="mono text-[11px] uppercase tracking-wider text-progress">Resolution · {n().resolution.choice}</div>
            <div class="mt-1 text-[13px] leading-5 text-body">{n().resolution.rationale}</div>
            <Show when={n().resolution.note}>
              <div class="mt-1 text-[12px] text-mute">{n().resolution.note}</div>
            </Show>
          </div>
        </Show>
      </Panel>

      {/* Blockers move to the right rail on desktop. Keeping this compact
          duplicate in the main flow gives narrow drawers the same dependency
          visibility once the rail collapses. */}
      <BlockersSection blocking={d.blocking} onSelect={onSelect} />

      {/* ── Notes: visible after blockers, styled as a quiet author thread
             rather than another disclosure card. The label remains Notes so
             it keeps the CLI vocabulary while the reading flow feels like
             the discussion area in a Linear-style issue detail. ─── */}
      <NotesSection notes={n().notes} />

      {/* ── Secondary zones: collapsed by default. Keep the disclosure
             stack vertical so each section reads like the reference drawer
             instead of splitting the reading flow into two columns. ─── */}
      <div class="space-y-3">
      <DetailsSection
        title="Knowledge"
        count={(d.knowledge || []).length}
        hint="Scoped knowledge that informs this node."
      >
        <Show when={(d.knowledge || []).length} fallback={
          <EmptyState variant="compact" title="No scoped knowledge applies." />
        }>
          <ul class="space-y-1.5">
            <For each={d.knowledge}>
              {(k) => (
                <li>
                  <button
                    type="button"
                    class={`flex w-full items-start gap-2 rounded-control border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 ${k.status === "deprecated" ? "border-line opacity-60" : "border-knowledge/30 bg-knowledge-soft hover:border-knowledge"}`}
                    onClick={() => onSelect(k.id)}
                    aria-label={`Open knowledge ${k.id}`}
                  >
                    <KindBadge node={{ kind: "knowledge" }} />
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="mono text-[12px] text-knowledge">{k.id}</span>
                        <span class="truncate text-[12px] font-medium text-ink">{k.title}</span>
                      </div>
                      <Show when={k.body}>
                        <div class="mt-0.5 line-clamp-2 text-[12px] text-body">{k.body}</div>
                      </Show>
                      <Show when={k.scope_matches && k.scope_matches.length}>
                        <div class="mt-0.5 text-[11px] text-mute">scope: {k.scope_matches.join(", ")}</div>
                      </Show>
                      <Show when={k.mitigation}>
                        <div class="mt-0.5 text-[11px] text-gate">mitigation: {k.mitigation}</div>
                      </Show>
                    </div>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </DetailsSection>

      <DetailsSection
        title="Refs"
        count={(d.refs || []).length}
        hint="Structured references — copy target, never rendered as HTML."
      >
        <Show when={(d.refs || []).length} fallback={
          <EmptyState variant="compact" title="No structured refs or detected markdown references." />
        }>
          <ul class="space-y-1">
            <For each={d.refs}>
              {(r) => (
                <li class="flex items-center gap-2 rounded-control border border-line bg-panel-2 px-2 py-1.5">
                  <div class="min-w-0 flex-1">
                    <div class="mono truncate text-[12px] text-body" title={escapeAttr(r.target)}>{r.target}</div>
                    <div class="text-[12px] text-mute">{r.type || "doc"} · {r.source || "explicit"}</div>
                  </div>
                  <CopyButton text={r.target} />
                </li>
              )}
            </For>
          </ul>
        </Show>
      </DetailsSection>

      <DetailsSection
        title="Relationships"
        count={relationshipsCount()}
        hint="Direction-aware links: blocks, derived from, supersedes, informing."
      >
        <div class="space-y-4">
          <RelGroup label="Blocks" hint="outgoing BLOCKS — nodes this one keeps from being ready.">
            <Show when={rel().outBlocks.length} fallback={
              <EmptyState variant="compact" title="No blocked nodes." />
            }>
              <ul class="space-y-1.5">
                <For each={rel().outBlocks}>{(e) => <RelationRow edge={e} onSelect={onSelect} />}</For>
              </ul>
            </Show>
          </RelGroup>

          <RelGroup label="Derived from" hint="outgoing DERIVED_FROM — source nodes this was built from.">
            <Show when={rel().derivedFrom.length} fallback={
              <EmptyState variant="compact" title="No derivation sources." />
            }>
              <ul class="space-y-1.5">
                <For each={rel().derivedFrom}>{(e) => <RelationRow edge={e} onSelect={onSelect} />}</For>
              </ul>
            </Show>
          </RelGroup>

          <RelGroup label="Supersedes / superseded by" hint="SUPERSEDES in both directions.">
            <Show when={rel().supersededBy}>
              <div class="mb-1.5 flex min-h-[36px] items-center gap-2 rounded-control border border-line bg-panel px-3 py-2">
                <span class="text-[11px] uppercase tracking-wider text-mute">Superseded by</span>
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-2 rounded-control px-1 py-0.5 text-left transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
                  onClick={() => onSelect(rel().supersededBy)}
                  aria-label={`Open superseding node ${rel().supersededBy}`}
                >
                  <span class="mono shrink-0 text-[12px] text-body">{rel().supersededBy}</span>
                  <span class="text-[12px] text-mute" aria-hidden="true">→</span>
                </button>
              </div>
            </Show>
            <Show when={rel().supersedes.length} fallback={
              <EmptyState variant="compact" title="No superseded nodes." />
            }>
              <ul class="space-y-1.5">
                <For each={rel().supersedes}>{(e) => <RelationRow edge={e} onSelect={onSelect} />}</For>
              </ul>
            </Show>
          </RelGroup>

          <RelGroup label="Informing" hint="INFORMS, RELATES_TO, CONFLICTS_WITH — informational edges.">
            <Show when={rel().informing.length} fallback={
              <EmptyState variant="compact" title="No informing edges." />
            }>
              <ul class="space-y-1.5">
                <For each={rel().informing}>{(e) => <RelationRow edge={e} onSelect={onSelect} />}</For>
              </ul>
            </Show>
          </RelGroup>
        </div>
      </DetailsSection>
      </div>

      </main>
      <DetailSidebar node={n()} detail={d} lastAt={lastAt()} onSelect={onSelect} />
    </div>
  );
}

// --- subcomponents ---------------------------------------------------------

// Narrow drawers do not have enough room for the properties rail. This keeps
// the same open-by-default dependency surface in the reading column there;
// desktop users get the richer BlockersRail below instead.
function BlockersSection(props) {
  const blockers = () => Array.isArray(props.blocking) ? props.blocking : [];
  const unsatisfied = () => blockers().filter((blocker) => !blocker.satisfied).length;
  return (
    <section class="ui-detail-blockers-mobile">
      <Panel
        title="Blockers"
        right={
          <span class="text-[12px] text-mute">
            {unsatisfied()} unsatisfied · {blockers().length} total
          </span>
        }
      >
        <p class="mb-2 text-[12px] text-mute">Incoming BLOCKS — this node is blocked by these.</p>
        <Show when={blockers().length} fallback={<EmptyState variant="compact" title="No blockers." />}>
          <ul class="space-y-1.5">
            <For each={blockers()}>
              {(blocker) => <BlockerRow blocker={blocker} onSelect={props.onSelect} />}
            </For>
          </ul>
        </Show>
      </Panel>
    </section>
  );
}

// Blockers use the same quiet card language as the rest of the rail. Keeping
// them in Properties preserves the drawer's original tab-first hierarchy while
// making dependencies immediately visible in its default state.
function BlockersRail(props) {
  const blockers = () => Array.isArray(props.blocking) ? props.blocking : [];
  const unsatisfied = () => blockers().filter((blocker) => !blocker.satisfied).length;
  const clear = () => unsatisfied() === 0;

  return (
    <section class="ui-detail-card ui-blockers-rail mb-3 rounded-control border p-3" aria-labelledby="detail-blockers-title">
      <div class="ui-blockers-rail-heading">
        <div class="min-w-0">
          <h3 id="detail-blockers-title" class="text-[12px] font-bold text-ink">Blockers</h3>
          <p class="mt-0.5 text-[11px] leading-4 text-mute">Incoming dependencies</p>
        </div>
        <span
          class={`ui-blockers-rail-count ${clear() ? "ui-blockers-rail-count--clear" : "ui-blockers-rail-count--active"}`}
          aria-label={`${unsatisfied()} unsatisfied blockers`}
        >
          {unsatisfied()} active
        </span>
      </div>

      <Show when={blockers().length} fallback={
        <div class="ui-blockers-empty">
          <span aria-hidden="true">✓</span>
          <span>No blockers. This node is clear to proceed.</span>
        </div>
      }>
        <ul class="ui-blockers-list">
          <For each={blockers()}>
            {(blocker) => <BlockerRow blocker={blocker} onSelect={props.onSelect} rail />}
          </For>
        </ul>
        <div class="ui-blockers-rail-footer">
          {unsatisfied()} unsatisfied · {blockers().length} total
        </div>
      </Show>
    </section>
  );
}

function BlockerRow(props) {
  const blocker = () => props.blocker || {};
  const node = () => blocker().node || {};
  const satisfied = () => Boolean(blocker().satisfied);
  const label = () => node().id || "Unknown blocker";
  const open = () => props.onSelect && props.onSelect(node().id);

  return (
    <li>
      <button
        type="button"
        class={props.rail
          ? `ui-blocker-rail-row ${satisfied() ? "ui-blocker-rail-row--resolved" : "ui-blocker-rail-row--active"}`
          : `flex min-h-[36px] w-full items-center gap-2 rounded-control border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 ${satisfied() ? "border-line opacity-70 hover:opacity-100" : "border-blocked/40 bg-blocked-soft hover:border-blocked"}`}
        onClick={open}
        aria-label={`Open blocker ${label()}`}
      >
        <span class={`ui-blocker-dot ${satisfied() ? "ui-blocker-dot--resolved" : "ui-blocker-dot--active"}`} aria-hidden="true" />
        <Show when={props.rail} fallback={
          <>
            <KindBadge node={node()} />
            <span class="mono shrink-0 text-[12px] text-body">{node().id}</span>
            <span class="min-w-0 flex-1 truncate text-[12px] text-body">{node().title}</span>
            <StatusBadge status={satisfied() ? "done" : node().status || "open"} />
          </>
        }>
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center justify-between gap-2">
              <span class="mono truncate text-[11px] font-semibold text-body">{node().id}</span>
              <span class={`ui-blocker-state ${satisfied() ? "ui-blocker-state--resolved" : "ui-blocker-state--active"}`}>
                {satisfied() ? "Resolved" : "Active"}
              </span>
            </div>
            <span class="mt-0.5 block truncate text-[12px] text-ink" title={node().title}>{node().title || "Untitled node"}</span>
          </div>
          <span class="ui-blocker-arrow" aria-hidden="true">→</span>
        </Show>
      </button>
    </li>
  );
}

// The right rail keeps high-signal properties in the default tab and recent
// activity in the alternate tab. Everything remains read-only: navigation and
// copy are the only actions.
function DetailSidebar(props) {
  const [tab, setTab] = createSignal("properties");
  const node = () => props.node || {};
  const detail = () => props.detail || {};
  const status = () => detail().derived_status || node().status || "open";
  const activity = () => [...(detail().history || [])].reverse().slice(0, 8);
  const tags = () => Array.isArray(node().tags) ? node().tags : [];
  return (
    <aside class="ui-detail-side min-w-0 p-3">
      <div class="ui-tab-strip mb-3 flex gap-1 rounded-control p-1" role="tablist" aria-label="Node detail panels">
        <button
          type="button"
          role="tab"
          aria-selected={tab() === "properties"}
          class="min-h-[36px] flex-1 rounded-control px-2 text-[12px] font-medium text-mute transition-colors hover:text-ink"
          classList={{ active: tab() === "properties" }}
          onClick={() => setTab("properties")}
        >
          Properties
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab() === "activity"}
          class="min-h-[36px] flex-1 rounded-control px-2 text-[12px] font-medium text-mute transition-colors hover:text-ink"
          classList={{ active: tab() === "activity" }}
          onClick={() => setTab("activity")}
        >
          Activity
        </button>
      </div>

      <Show when={tab() === "properties"}>
        <BlockersRail blocking={detail().blocking} onSelect={props.onSelect} />

        <section class="ui-detail-card mb-3 rounded-control border p-3">
          <h3 class="mb-3 text-[12px] font-bold text-ink">Overview</h3>
          <div class="grid gap-1">
            <PropertyRow label="Status"><StatusBadge status={status()} /></PropertyRow>
            <PropertyRow label="Initiative"><span class="mono text-[12px] text-progress">{node().initiative || "—"}</span></PropertyRow>
            <PropertyRow label="Revision"><span class="mono text-[12px] text-body">{node().revision || 0}</span></PropertyRow>
            <PropertyRow label="Last activity"><Time value={props.lastAt} /></PropertyRow>
            <Show when={node().claim}>
              <PropertyRow label="Claim">
                <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span class="mono text-progress">{node().claim.by || "—"}</span>
                  <ClaimTime claim={node().claim} />
                </div>
              </PropertyRow>
            </Show>
          </div>
          <div class="mt-3 rounded-control bg-panel-2 px-2.5 py-2 text-[12px] leading-5 text-body">
            {EXPLAIN[status()] || "Read-only snapshot of this node."}
          </div>
        </section>

        <section class="ui-detail-card mb-3 rounded-control border p-3">
          <h3 class="mb-3 text-[12px] font-bold text-ink">Context</h3>
          <div class="grid gap-1">
            <PropertyRow label="Kind"><KindBadge node={node()} /></PropertyRow>
            <Show when={node().domain}><PropertyRow label="Domain"><span class="text-[12px] text-body">{node().domain}</span></PropertyRow></Show>
            <Show when={node().purpose}><PropertyRow label="Purpose"><Chip tone="gate">{node().purpose}</Chip></PropertyRow></Show>
          </div>
        </section>

        <Show when={tags().length > 0}>
          <section class="ui-detail-card mb-3 rounded-control border p-3">
            <h3 class="mb-3 text-[12px] font-bold text-ink">Tags</h3>
            <div class="flex flex-wrap gap-1.5">
              <For each={tags()}>{(tag) => <Chip>{tag}</Chip>}</For>
            </div>
          </section>
        </Show>

        <section class="ui-command-bar flex items-center justify-between gap-2 rounded-control border px-2.5 py-2 text-[12px] text-mute">
          <span>Read-only detail</span>
          <CopyButton text={node().id || ""} />
        </section>

        <Show when={equivalentCommand(node(), status())}>
          <div class="mt-5 rounded-control border border-line bg-mid p-3">
            <div class="flex items-start gap-2">
              <pre class="mono min-w-0 flex-1 whitespace-pre-wrap break-all text-[12px] leading-5 text-progress">{equivalentCommand(node(), status())}</pre>
              <CopyButton text={equivalentCommand(node(), status())} />
            </div>
          </div>
        </Show>
      </Show>

      {/* The Activity tab stays in the DOM (hidden when the Properties tab is
          active) so server-rendered snapshots, screen-reader virtual content,
          and search-style indexes always include recent history. The Properties
          tab is the heavy branch and remains gated by <Show> so its content
          is mounted lazily — the asymmetry is intentional: history is small
          and stable; properties re-renders on every poll. */}
      <section
        class="ui-detail-card rounded-control border p-3"
        hidden={tab() !== "activity"}
        aria-hidden={tab() !== "activity"}
      >
        <h3 class="mb-3 text-[12px] font-bold text-ink">Recent activity</h3>
        <Show when={activity().length > 0} fallback={<EmptyState variant="compact" title="No activity yet." />}>
          <div class="grid gap-3">
            <For each={activity()}>
              {(event) => (
                <div class="grid grid-cols-[8px_1fr] gap-2">
                  <span class="mt-1.5 h-1.5 w-1.5 rounded-full bg-progress" aria-hidden="true" />
                  <div class="min-w-0">
                    <div class="text-[12px] font-semibold text-ink">{event.action || "event"}</div>
                    <div class="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-mute">
                      <Time value={event.ts} />
                      <Show when={event.agent}><span class="mono truncate">{event.agent}</span></Show>
                    </div>
                    <Show when={event.note}><div class="mt-1 line-clamp-3 text-[12px] leading-4 text-body">{event.note}</div></Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>
    </aside>
  );
}

function PropertyRow(props) {
  return (
    <div class="grid min-h-[32px] grid-cols-[88px_minmax(0,1fr)] items-center gap-2 rounded px-1 py-1 hover:bg-panel-2">
      <span class="text-[12px] text-mute">{props.label}</span>
      <div class="min-w-0 text-[12px] text-body">{props.children}</div>
    </div>
  );
}

function DetailsSection(props) {
  // title, count, hint, children — same shape as <details>.
  const heading = (
    <div class="flex min-w-0 flex-1 items-center gap-2">
      <span class="truncate text-[14px] font-semibold text-ink">{props.title}</span>
      <Show when={typeof props.count === "number"}>
        <span class="text-[11px] text-mute">({props.count})</span>
      </Show>
      <Show when={props.hint}>
        <span class="truncate text-[12px] text-mute">{props.hint}</span>
      </Show>
    </div>
  );
  return (
    <details class="ui-detail-card group rounded-card border border-line bg-panel">
      <summary class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
        <span class="mono text-[12px] text-mute transition-transform group-open:rotate-90" aria-hidden="true">▶</span>
        {heading}
      </summary>
      <div class="border-t border-line p-4">{props.children}</div>
    </details>
  );
}

// Label + hint block for one relationship sub-group inside the
// Relationships <details>.
function RelGroup(props) {
  // label (string, required), hint (string, optional), children
  return (
    <section>
      <div class="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h4 class="mono text-[12px] uppercase tracking-wider text-mute">{props.label}</h4>
        <Show when={props.hint}>
          <span class="text-[11px] text-mute/80">{props.hint}</span>
        </Show>
      </div>
      {props.children}
    </section>
  );
}

// One navigable row for a related node. Navigation goes through the store's
// select() (GET /api/node/:id only) — the drawer never issues a mutating
// request, and the target is a button, not an anchor.
function RelationRow(props) {
  // edge ({ edge_type, node }), onSelect (id -> void)
  const edge = props.edge || {};
  const related = edge.node || {};
  return (
    <li>
      <button
        type="button"
        class="ui-list-row flex min-h-[36px] w-full items-center gap-2 rounded-control border border-line bg-panel px-3 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
        onClick={() => props.onSelect && props.onSelect(related.id)}
        aria-label={`Open ${related.id}`}
      >
        <KindBadge node={related} />
        <span class="mono shrink-0 text-[12px] text-body">{related.id}</span>
        <span class="min-w-0 flex-1 truncate text-[12px] text-body">{related.title || "—"}</span>
        <StatusBadge status={related.status || "open"} />
      </button>
    </li>
  );
}

function NotesSection(props) {
  const notes = () => Array.isArray(props.notes) ? props.notes : [];
  return (
    <section class="ui-detail-notes" aria-labelledby="detail-notes-title">
      <div class="ui-detail-notes-header">
        <h3 id="detail-notes-title" class="text-section text-ink">
          Notes <span class="ui-detail-notes-count">({notes().length})</span>
        </h3>
      </div>
      <Show when={notes().length} fallback={
        <EmptyState variant="compact" title="No notes yet." />
      }>
        <ol class="ui-notes-thread" aria-label="Notes">
          <For each={[...notes()].reverse()}>
            {(note) => <NoteRow note={note} />}
          </For>
        </ol>
      </Show>
    </section>
  );
}

function noteInitials(agent) {
  const value = String(agent || "").trim();
  if (!value) return "—";
  const words = value.split(/[\s._-]+/).filter(Boolean);
  if (words.length > 1) {
    return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
  }
  return value.slice(0, 2).toUpperCase();
}

function NoteRow(props) {
  // note ({ agent, ts, text }) — all notes use the same presentation.
  const note = props.note || {};
  const author = note.agent || "—";
  return (
    <li class="ui-note">
      <span class="ui-note-avatar" aria-hidden="true" title={author}>{noteInitials(author)}</span>
      <div class="ui-note-content">
        <div class="ui-note-meta">
          <span class="ui-note-author">{author}</span>
          <span aria-hidden="true" class="ui-note-separator">·</span>
          <Time value={note.ts} />
        </div>
        <div class="ui-note-body whitespace-pre-wrap text-[13px] leading-5 text-body">{note.text}</div>
      </div>
    </li>
  );
}

// === Banner helpers =========================================================

function bannerTone(alert) {
  if (!alert) return "info";
  if (alert.severity === "error") return "error";
  if (alert.severity === "warning") return "warning";
  return "info";
}

function bannerTitle(alert) {
  if (!alert) return "";
  const map = {
    "stale-claim": "Stale claim",
    "state-read-error": "State read error",
    blocked: "Blocked",
    superseded: "Superseded",
  };
  return map[alert.kind] || (alert.kind ? alert.kind.replace(/-/g, " ") : "Alert");
}

// Re-export so the test can render DetailBody directly with a literal
// payload via renderToString without needing a real StoreProvider.
export { DetailBody };
