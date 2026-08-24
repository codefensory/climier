// NodeDetail — drawer for a single node.
//
// Scope (Fase 6 pieza F6a, per docs/ui-redesign-plan.md section 6-Fase 6):
//   1. Sticky header with back/close, real kind (task/gate/knowledge — never
//      the umbrella 'resolvable'), status, id and revision.
//   2. Title in the 20-24 px range (the `text-page` token).
//   3. Summary card: status, initiative, claim (using claim.at per the
//      Fase 1 contract), revision and last activity timestamp.
//   4. Visible callout for blocked, stale or superseded via AlertBanner.
//   5. Specification and open blockers visible by default.
//   6. Knowledge, notes, history, refs, secondary relations and the
//      equivalent-CLI command live inside collapsible <details>.
//   7. Times use claim.at (Time/ClaimTime prefer claim.at over claim.ts).
//
// Pieza F6b (T-ui-detail-rel) owns the relationships breakdown; here we
// only render a coarse Dependents link into a <details> until that lands.

import { Show, For, createMemo, createSignal, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { useStore } from "../store.jsx";
import {
  AlertBanner,
  ClaimTime,
  EmptyState,
  IconButton,
  KindBadge,
  Panel,
  StatusBadge,
  Time,
} from "../components.jsx";

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
// labor surface). The drawer's "Equivalent CLI command" section renders
// this verbatim — never executes it.
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
  //  - Escape closes the drawer
  //  - previous focus is restored on close
  let drawerRef;
  let restoreFocusEl = null;
  const [openedAt, setOpenedAt] = createSignal(null);

  createEffect(() => {
    const id = selectedId();
    if (id) {
      setOpenedAt(Date.now());
      // Capture the active element so we can restore focus on close.
      if (typeof document !== "undefined") {
        restoreFocusEl = document.activeElement;
      }
      // Defer focus until the drawer has rendered.
      queueMicrotask(() => {
        const root = drawerRef;
        if (root && typeof root.focus === "function") {
          root.focus();
        }
      });
    } else {
      setOpenedAt(null);
      if (restoreFocusEl && typeof restoreFocusEl.focus === "function") {
        try { restoreFocusEl.focus(); } catch {}
      }
      restoreFocusEl = null;
    }
  });

  function handleKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      select(null);
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
      class="fixed right-0 top-0 z-50 flex h-full w-full max-w-2xl flex-col border-l border-line bg-canvas shadow-md"
    >
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header class="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-canvas/95 px-4 py-3 backdrop-blur-[2px]">
        <IconButton size="sm" label="Back" onClick={() => select(null)}>
          <span class="text-[14px]" aria-hidden="true">←</span>
        </IconButton>
        <span class="mono truncate text-[12px] text-body" title={d()?.node?.id}>{d()?.node?.id}</span>
        <KindBadge node={d()?.node} />
        <Show when={d()?.node?.subkind}>
          <span class="text-[11px] uppercase tracking-wider text-mute">{d().node.subkind}</span>
        </Show>
        <StatusBadge status={d()?.derived_status || d()?.node?.status || "open"} />
        <span class="ml-auto text-[12px] text-mute">rev {d()?.node?.revision || 0}</span>
        <IconButton size="sm" label="Close" onClick={() => select(null)}>
          <span class="text-[14px]" aria-hidden="true">✕</span>
        </IconButton>
      </header>

      {/* ── Body ───────────────────────────────────────────────────── */}
      <div class="flex-1 space-y-4 overflow-auto p-4">
        <Show when={detailError()} fallback={
          <Show when={d()} fallback={<DetailLoading />}>
            <DetailBody
              detail={d()}
              lastActivityMap={lastActivityMap()}
              nodeAlerts={nodeAlerts()}
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
    <Show when={open()}>
      <Show when={isServer} fallback={
        <Portal>
          <div
            class="fixed inset-0 z-40 bg-black/40"
            onClick={() => select(null)}
            aria-hidden="true"
          />
          {drawerMarkup}
        </Portal>
      }>
        <div
          class="fixed inset-0 z-40 bg-black/40"
          onClick={() => select(null)}
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
  // props.onSelect        — back/click handler (id -> void)
  const { detail: d, lastActivityMap, nodeAlerts, onSelect } = props;
  const n = () => d.node;
  const lastAt = () => lastActivityTs(d, lastActivityMap);

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
    <>
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
      <section>
        <h1 class="text-page leading-tight text-ink">{n().title || n().id}</h1>
        <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SummaryRow label="Status">
            <div class="flex items-center gap-2">
              <StatusBadge status={d.derived_status || n().status || "open"} />
              <Show when={d.derived_status !== n().status}>
                <span class="text-[11px] text-mute">persisted: {n().status || "open"}</span>
              </Show>
            </div>
          </SummaryRow>
          <SummaryRow label="Initiative">
            <span class="mono text-[12px] text-body">{n().initiative || "—"}</span>
          </SummaryRow>
          <Show when={n().claim}>
            <SummaryRow label="Claim">
              <div class="flex flex-wrap items-center gap-2 text-[12px] text-body">
                <span class="mono text-progress">{n().claim.by || "?"}</span>
                <ClaimTime claim={n().claim} />
              </div>
            </SummaryRow>
          </Show>
          <SummaryRow label="Revision">
            <span class="mono text-[12px] text-body">{n().revision || 0}</span>
          </SummaryRow>
          <SummaryRow label="Last activity">
            <Time value={lastAt()} />
          </SummaryRow>
          <Show when={EXPLAIN[d.derived_status]}>
            <SummaryRow label="Why this status">
              <span class="text-[12px] leading-5 text-mute">{EXPLAIN[d.derived_status]}</span>
            </SummaryRow>
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

      {/* ── Blockers (open by default; relevant blockers surfaced) ──── */}
      <Panel
        title="Blockers"
        right={
          <span class="text-[12px] text-mute">
            {(d.blocking || []).filter((b) => !b.satisfied).length} unsatisfied · {(d.blocking || []).length} total
          </span>
        }
      >
        <Show when={(d.blocking || []).length} fallback={
          <EmptyState variant="compact" title="No blockers." />
        }>
          <ul class="space-y-1.5">
            <For each={d.blocking}>
              {(b) => (
                <li>
                  <button
                    type="button"
                    class={`flex min-h-[36px] w-full items-center gap-2 rounded-control border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 ${b.satisfied ? "border-line opacity-70 hover:opacity-100" : "border-blocked/40 bg-blocked-soft hover:border-blocked"}`}
                    onClick={() => onSelect(b.node && b.node.id)}
                    aria-label={`Open blocker ${b.node && b.node.id}`}
                  >
                    <span class={`h-2 w-2 shrink-0 rounded-full ${b.satisfied ? "bg-ready" : "bg-blocked"}`} aria-hidden="true" />
                    <KindBadge node={b.node} />
                    <span class="mono shrink-0 text-[12px] text-body">{b.node && b.node.id}</span>
                    <span class="min-w-0 flex-1 truncate text-[12px] text-body">{b.node && b.node.title}</span>
                    <StatusBadge status={b.satisfied ? "done" : (b.node && b.node.status) || "open"} />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Panel>

      {/* ── Secondary zones: collapsed by default ───────────────────── */}
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
        title="Notes"
        count={(n().notes || []).length}
        hint="Append-only thread — evidence and coordination live here."
      >
        <Show when={(n().notes || []).length} fallback={
          <EmptyState variant="compact" title="No notes yet." />
        }>
          <ul class="space-y-2">
            <For each={[...(n().notes || [])].reverse()}>
              {(note) => <NoteRow note={note} />}
            </For>
          </ul>
        </Show>
      </DetailsSection>

      <DetailsSection
        title="History"
        count={(d.history || []).length}
        hint="Most recent log entries for this node."
      >
        <Show when={(d.history || []).length} fallback={
          <EmptyState variant="compact" title="No history yet." />
        }>
          <ul class="space-y-1">
            <For each={[...(d.history || [])].reverse()}>
              {(h) => (
                <li class="flex items-center gap-2 text-[12px] leading-5 text-body">
                  <Time value={h.ts} />
                  <span class="mono rounded-full bg-panel-2 px-1.5 py-0.5 text-[11px] text-progress">{h.action}</span>
                  <span class="mono text-[11px] text-mute">{h.agent}</span>
                  <Show when={h.note}>
                    <span class="truncate text-[12px] text-mute" title={h.note}>{h.note}</span>
                  </Show>
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
                    <div class="text-[11px] text-mute">{r.type || "doc"} · {r.source || "explicit"}</div>
                  </div>
                  <CopyButton text={r.target} />
                </li>
              )}
            </For>
          </ul>
        </Show>
      </DetailsSection>

      <DetailsSection
        title="Dependents"
        count={(d.dependents || []).length}
        hint="Nodes that reference this one. Granular relationships land in F6b."
      >
        <Show when={(d.dependents || []).length} fallback={
          <EmptyState variant="compact" title="No dependents." />
        }>
          <ul class="space-y-1.5">
            <For each={d.dependents}>
              {(dp) => (
                <li>
                  <button
                    type="button"
                    class="flex min-h-[36px] w-full items-center gap-2 rounded-control border border-line bg-panel px-3 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
                    onClick={() => onSelect(dp.node && dp.node.id)}
                    aria-label={`Open dependent ${dp.node && dp.node.id}`}
                  >
                    <KindBadge node={dp.node} />
                    <span class="mono shrink-0 text-[12px] text-body">{dp.node && dp.node.id}</span>
                    <span class="min-w-0 flex-1 truncate text-[12px] text-body">{dp.node && dp.node.title}</span>
                    <span class="ml-auto text-[11px] uppercase tracking-wider text-mute">{dp.edge_type}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </DetailsSection>

      <DetailsSection
        title="Equivalent CLI command"
        hint="Read-only suggestion. Never executed by the UI."
      >
        <Show when={equivalentCommand(n(), d.derived_status)} fallback={
          <EmptyState variant="compact" title="No CLI equivalent (knowledge has no labor surface)." />
        }>
          <div class="flex items-start gap-2 rounded-control border border-line bg-mid px-3 py-2">
            <pre class="mono flex-1 whitespace-pre-wrap break-all text-[12px] leading-5 text-progress">{equivalentCommand(n(), d.derived_status)}</pre>
            <CopyButton text={equivalentCommand(n(), d.derived_status)} />
          </div>
        </Show>
      </DetailsSection>
    </>
  );
}

// --- subcomponents ---------------------------------------------------------

function SummaryRow(props) {
  // label (string, required)
  // children (node, required)
  return (
    <div class="flex flex-col gap-0.5">
      <span class="mono text-[11px] uppercase tracking-wider text-mute">{props.label}</span>
      <div class="text-[13px] leading-5 text-body">{props.children}</div>
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
    <details class="group rounded-card border border-line bg-panel">
      <summary class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
        <span class="mono text-[12px] text-mute transition-transform group-open:rotate-90" aria-hidden="true">▶</span>
        {heading}
      </summary>
      <div class="border-t border-line p-4">{props.children}</div>
    </details>
  );
}

function NoteRow(props) {
  // note ({ agent, ts, text }), optional `validation` flag in the text.
  const note = props.note || {};
  const isValidation = typeof note.text === "string" && /VALIDATION (PASS|FAIL|BLOCKED)/.test(note.text);
  return (
    <li class={`rounded-control border p-2 ${isValidation ? "border-progress/40 bg-progress-soft" : "border-line bg-panel-2"}`}>
      <div class="flex items-center gap-2 text-[11px] text-mute">
        <span class="mono text-progress">{note.agent || "—"}</span>
        <Time value={note.ts} />
        <Show when={isValidation}>
          <span class="mono rounded-full border border-progress/40 bg-panel px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-progress">validation</span>
        </Show>
      </div>
      <div class="mt-1 whitespace-pre-wrap text-[13px] leading-5 text-body">{note.text}</div>
    </li>
  );
}

function DetailLoading() {
  return (
    <div class="space-y-3" aria-hidden="true">
      <div class="h-7 w-2/3 rounded-full bg-panel-2" />
      <div class="h-4 w-1/2 rounded-full bg-panel-2" />
      <div class="h-4 w-1/3 rounded-full bg-panel-2" />
    </div>
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
