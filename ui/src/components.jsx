// Shared presentational primitives for the Climier UI.
//
// Contract: docs/ui-redesign-plan.md section 4 + ui/DESIGN.md section 4.
// Tokens live in ui/src/index.css (Phase 2 F2a, ship via T-ui-css-tokens).
// Every primitive here consumes those tokens directly; this file is the only
// place view code reaches for them.
//
// Visual rules enforced here (see ui/DESIGN.md for the rationale):
//   - Cards: hairline border, 12 px radius, no shadow (elevation level 3 is
//     reserved for drawers/popovers; opt in via Panel `elevated`).
//   - Controls: minimum 36 px tall, 8 px radius. Pill (rounded-full) is
//     reserved for badges and chips — never for buttons.
//   - Interactives: cursor-pointer when clickable, visible focus ring via
//     the global :focus-visible rule in index.css, accessible name on every
//     control.
//   - Status: colour + shape + text. The dot inside a StatusBadge plus the
//     visible label provide redundancy for colourblind users.

import { Show, For } from "solid-js";

// === Status / kind tokens ==================================================
// Each entry holds the three utility classes a pill needs (text + border +
// soft background) plus the dot class. Custom semantic tokens defined in
// ui/src/index.css drive all of them — Tailwind v4 generates the utilities.

const STATUS_TOKEN = {
  ready:       { text: "text-ready",        border: "border-ready",        soft: "bg-ready-soft",        dot: "bg-ready" },
  in_progress: { text: "text-progress",     border: "border-progress",     soft: "bg-progress-soft",     dot: "bg-progress" },
  blocked:     { text: "text-blocked",      border: "border-blocked",      soft: "bg-blocked-soft",      dot: "bg-blocked" },
  gate:        { text: "text-gate",         border: "border-gate",         soft: "bg-gate-soft",         dot: "bg-gate" },
  knowledge:   { text: "text-knowledge",    border: "border-knowledge",    soft: "bg-knowledge-soft",    dot: "bg-knowledge" },
  done:        { text: "text-ready",        border: "border-ready",        soft: "bg-ready-soft",        dot: "bg-ready" },
  resolved:    { text: "text-gate",         border: "border-gate",         soft: "bg-gate-soft",         dot: "bg-gate" },
  superseded:  { text: "text-knowledge",    border: "border-knowledge",    soft: "bg-knowledge-soft",    dot: "bg-knowledge" },
  canceled:    { text: "text-mute",         border: "border-line",         soft: "bg-panel-2",           dot: "bg-mute" },
  deprecated:  { text: "text-mute",         border: "border-line",         soft: "bg-panel-2",           dot: "bg-mute" },
  archived:    { text: "text-mute",         border: "border-line",         soft: "bg-panel-2",           dot: "bg-mute" },
  open:        { text: "text-gate",         border: "border-gate",         soft: "bg-gate-soft",         dot: "bg-gate" },
  active:      { text: "text-knowledge",    border: "border-knowledge",    soft: "bg-knowledge-soft",    dot: "bg-knowledge" },
  backlog:     { text: "text-mute",         border: "border-line",         soft: "bg-panel-2",           dot: "bg-mute" },
  missing:     { text: "text-blocked",      border: "border-blocked",      soft: "bg-blocked-soft",      dot: "bg-blocked" },
};

// Three kinds only — task / gate / knowledge. The CLI schema uses
// `kind: "resolvable"` for tasks and gates; we collapse that here because
// the dashboard distinguishes tasks from gates via `subkind`, never via the
// umbrella `resolvable` token.
const KIND_TOKEN = {
  task:      { text: "text-progress",  border: "border-progress",  soft: "bg-progress-soft" },
  gate:      { text: "text-gate",      border: "border-gate",      soft: "bg-gate-soft" },
  knowledge: { text: "text-knowledge", border: "border-knowledge", soft: "bg-knowledge-soft" },
};

export function kindFor(node) {
  if (!node) return "task";
  if (node.kind === "knowledge") return "knowledge";
  if (node.subkind === "gate") return "gate";
  return "task";
}

// === PageHeader =============================================================
// Top-of-view header: eyebrow + title + subtitle on the left, contextual
// meta + actions on the right. Global refresh/read-only status belongs to the
// shell's floating LiveStatus indicator, not to individual page headers.
// Sticky mode adds a subtle canvas-tinted backdrop so the header keeps the
// title visible while the body scrolls under it.

export function PageHeader(props) {
  // title       (string, required)
  // eyebrow     (string, optional)
  // subtitle    (string, optional)
  // meta        (node, optional — small right-side text)
  // right       (node, optional — buttons, badges, anything)
  // sticky      (bool, optional)
  const stickyCls = props.sticky
    ? "sticky top-0 z-10 border-line bg-canvas/95 backdrop-blur-[2px]"
    : "";
  return (
    <header class={`flex items-end justify-between gap-4 border-b border-line pb-4 ${stickyCls}`}>
      <div class="min-w-0">
        <Show when={props.eyebrow}>
          <div class="mono text-[12px] uppercase tracking-wider text-mute">{props.eyebrow}</div>
        </Show>
        <h1 class="mt-1 truncate text-page text-ink">{props.title}</h1>
        <Show when={props.subtitle}>
          <p class="mt-1 text-[14px] leading-5 text-body">{props.subtitle}</p>
        </Show>
      </div>
      <div class="flex shrink-0 items-center gap-3">
        <Show when={props.meta}>
          <div class="mono text-[12px] text-mute">{props.meta}</div>
        </Show>
        <Show when={props.right}>{props.right}</Show>
      </div>
    </header>
  );
}

// === Panel =================================================================
// Surface card. Hairline border, card radius, no shadow by default.
// Header is optional; footer is optional; body padding is configurable.

export function Panel(props) {
  // title       (string, optional)
  // eyebrow     (string, optional)
  // right       (node, optional)
  // footer      (node, optional)
  // tone        ("info" | "warning" | "error", optional — surface + border)
  // padding     ("compact" | "standard" | "loose", default "standard")
  // elevated    (bool, optional — drawer/popover shadow, level 3)
  // children    (node, required body)
  const PAD = { compact: "p-3", standard: "p-4", loose: "p-5" };
  const padding = PAD[props.padding] || PAD.standard;
  const TONE = {
    info:    { border: "border-progress", soft: "bg-progress-soft" },
    warning: { border: "border-gate",     soft: "bg-gate-soft" },
    error:   { border: "border-blocked",  soft: "bg-blocked-soft" },
  };
  const tone = TONE[props.tone];
  const border = tone ? tone.border : "border-line";
  const surface = tone ? tone.soft : "bg-panel";
  const shadow = props.elevated ? "shadow-md" : "";
  return (
    <section class={`flex flex-col rounded-card border ${border} ${surface} ${shadow}`}>
      <Show when={props.title || props.eyebrow || props.right}>
        <div class="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div class="min-w-0">
            <Show when={props.eyebrow}>
              <div class="mono text-[12px] uppercase tracking-wider text-mute">{props.eyebrow}</div>
            </Show>
            <Show when={props.title}>
              <h3 class="truncate text-section text-ink">{props.title}</h3>
            </Show>
          </div>
          <Show when={props.right}>
            <div class="flex shrink-0 items-center gap-2">{props.right}</div>
          </Show>
        </div>
      </Show>
      <div class={`flex-1 ${padding}`}>{props.children}</div>
      <Show when={props.footer}>
        <div class="border-t border-line bg-panel-2 px-4 py-2.5 text-[12px] leading-4 text-mute">
          {props.footer}
        </div>
      </Show>
    </section>
  );
}

// === MetricCard ============================================================
// Operational number with label + optional one-line explanation.
// When `onClick` is provided the card becomes a <button>: same DOM shape,
// keyboard reachable, focus-visible ring inherited from the global rule.
// When it is NOT provided the card stays a <div>: no cursor, no false
// affordance, no role="button" lie.

export function MetricCard(props) {
  // value       (number | string, required)
  // label       (string, required)
  // explanation (string, optional)
  // tone        ("ready" | "progress" | "blocked" | "gate" | "knowledge", optional accent on the number)
  // onClick     (function, optional — presence flips the tag to <button>)
  const tone = props.tone ? STATUS_TOKEN[props.tone] : null;
  const valueColor = tone ? tone.text : "text-ink";
  const interactive = typeof props.onClick === "function";
  const baseCls = "block w-full rounded-card border border-line bg-panel p-4";
  const interactiveCls = "cursor-pointer transition-colors hover:border-mid";
  const focusCls = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";
  const valueCls = `text-metric tabular-nums ${valueColor}`;
  const inner = (
    <>
      <div class={valueCls}>{props.value}</div>
      <div class="mt-0.5 text-[12px] leading-4 text-mute">{props.label}</div>
      <Show when={props.explanation}>
        <div class="mt-1 line-clamp-2 text-[12px] leading-4 text-mute">{props.explanation}</div>
      </Show>
    </>
  );
  return (
    <Show when={interactive} fallback={
      <div class={baseCls}>{inner}</div>
    }>
      <button
        type="button"
        class={`${baseCls} ${interactiveCls} ${focusCls}`}
        onClick={props.onClick}
        aria-label={props.label}
      >
        {inner}
      </button>
    </Show>
  );
}

// === StatusBadge ============================================================
// Pill with semantic colour + soft background + visible label. The dot inside
// is redundant by design: the dashboard's status contract is colour + shape +
// text (see DESIGN.md §6), never colour alone.

export function StatusBadge(props) {
  const tone = STATUS_TOKEN[props.status] || STATUS_TOKEN.missing;
  return (
    <span class={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12px] font-medium leading-4 ${tone.soft} ${tone.text} ${tone.border}`}>
      <span class={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
      <span>{props.status}</span>
    </span>
  );
}

// === KindBadge =============================================================
// Kind marker — task / gate / knowledge. Square shape (not pill) so the eye
// can distinguish it from a StatusBadge at a glance; see DESIGN.md §6.

export function KindBadge(props) {
  const kind = kindFor(props.node);
  const tone = KIND_TOKEN[kind] || KIND_TOKEN.task;
  return (
    <span class={`inline-flex items-center rounded-[6px] border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${tone.soft} ${tone.text} ${tone.border}`}>
      {kind}
    </span>
  );
}

// === Chip ==================================================================
// Small pill for initiative, scope, tag, etc. Pill shape is reserved here
// (chips are explicitly allowed to be pills). Accepts an optional semantic
// tone; defaults to a neutral panel-2 surface.

export function Chip(props) {
  // tone       ("ready" | "progress" | "blocked" | "gate" | "knowledge", optional)
  // disabled   (bool, optional — visually dimmed)
  // leading    (node, optional slot before children)
  // trailing   (node, optional slot after children)
  // children   (node, required)
  const tone = props.tone && STATUS_TOKEN[props.tone] ? STATUS_TOKEN[props.tone] : null;
  const cls = tone
    ? `${tone.soft} ${tone.text} ${tone.border}`
    : "bg-panel-2 text-body border-line";
  const opacity = props.disabled ? "opacity-50" : "";
  return (
    <span class={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] leading-4 ${cls} ${opacity}`}>
      <Show when={props.leading}>{props.leading}</Show>
      <span>{props.children}</span>
      <Show when={props.trailing}>{props.trailing}</Show>
    </span>
  );
}

// === FilterBar =============================================================
// Single-line container for filter controls. Always reaches the 36 px control
// floor; "Clear filters" appears only when onClear is provided.

export function FilterBar(props) {
  // label       (string, optional)
  // hint        (string, optional)
  // children    (node, required — filter controls)
  // onClear     (function, optional — shows Clear filters button)
  // clearLabel  (string, optional override)
  const clearCls = "ml-auto inline-flex min-h-[36px] items-center rounded-control border border-line bg-panel-2 px-3 text-[12px] text-body hover:bg-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";
  return (
    <div class="flex min-h-[36px] flex-wrap items-center gap-2 rounded-control border border-line bg-panel px-3 py-2">
      <Show when={props.label}>
        <span class="mono text-[12px] uppercase tracking-wider text-mute">{props.label}</span>
      </Show>
      <div class="flex flex-1 flex-wrap items-center gap-2">{props.children}</div>
      <Show when={props.hint}>
        <span class="text-[12px] text-mute">{props.hint}</span>
      </Show>
      <Show when={typeof props.onClear === "function"}>
        <button type="button" class={clearCls} onClick={props.onClear}>
          {props.clearLabel || "Clear filters"}
        </button>
      </Show>
    </div>
  );
}

// === AlertBanner ===========================================================
// Non-modal banner. role="alert" for error/warning so screen readers
// announce it; role="status" for info so the announcement is polite.

export function AlertBanner(props) {
  // tone       ("info" | "warning" | "error", default "info")
  // title      (string, optional)
  // children   (node, required body)
  // onDismiss  (function, optional — shows Dismiss button)
  const TONE = {
    info:    { border: "border-progress", soft: "bg-progress-soft", text: "text-progress" },
    warning: { border: "border-gate",     soft: "bg-gate-soft",     text: "text-gate" },
    error:   { border: "border-blocked",  soft: "bg-blocked-soft",  text: "text-blocked" },
  };
  const tone = TONE[props.tone] || TONE.info;
  const role = props.tone === "error" ? "alert" : "status";
  const dismissCls = "rounded-control px-2 py-1 text-[12px] text-mute hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";
  return (
    <div class={`flex items-start gap-3 rounded-control border ${tone.border} ${tone.soft} px-4 py-3 text-[13px] leading-5 ${tone.text}`} role={role}>
      <div class="min-w-0 flex-1">
        <Show when={props.title}>
          <div class="font-semibold text-ink">{props.title}</div>
        </Show>
        <div class="text-body">{props.children}</div>
      </div>
      <Show when={typeof props.onDismiss === "function"}>
        <button type="button" class={dismissCls} onClick={props.onDismiss} aria-label="Dismiss">
          Dismiss
        </button>
      </Show>
    </div>
  );
}

// === EmptyState ============================================================
// Three variants:
//   - page:    full-page placeholder (rounded card, large padding)
//   - section: in-panel placeholder (dashed border, medium padding) — the
//              default; matches the original Empty usage.
//   - compact: single-line muted text for the "all healthy" path.

export function EmptyState(props) {
  // variant   ("page" | "section" | "compact", default "section")
  // title     (string, required)
  // hint      (string, optional)
  // cta       (node, optional — action button)
  // children  (node, optional body)
  const variant = props.variant || "section";
  const VARIANT_CLS = {
    page:    "rounded-card border border-line bg-panel p-8 text-center",
    section: "rounded-card border border-dashed border-line bg-panel p-6 text-center",
    compact: "text-[12px] leading-4 text-mute",
  };
  const TITLE_SIZE = {
    page:    "text-[18px] leading-6",
    section: "text-[14px] leading-5",
    compact: "",
  };
  return (
    <div class={VARIANT_CLS[variant]}>
      <Show when={variant !== "compact"}>
        <div class={`font-semibold text-ink ${TITLE_SIZE[variant]}`}>{props.title}</div>
      </Show>
      <Show when={variant === "compact"}>
        <span>{props.title}</span>
      </Show>
      <Show when={props.hint && variant !== "compact"}>
        <div class="mt-1 text-[13px] leading-5 text-mute">{props.hint}</div>
      </Show>
      <Show when={props.cta}>
        <div class="mt-3 flex justify-center">{props.cta}</div>
      </Show>
      <Show when={props.children}>
        <div class="mt-2 text-[13px] text-body">{props.children}</div>
      </Show>
    </div>
  );
}

// === NodeRow ================================================================
// One row in a Tasks / Gates / Knowledge table or list. Clickable when
// onClick is provided; otherwise a non-interactive div.

export function NodeRow(props) {
  // node       (object, required — expects at least { id, title, status })
  // right      (node, optional right-side slot)
  // onClick    (function, optional — presence flips the tag to <button>)
  // selected   (bool, optional — highlight)
  const interactive = typeof props.onClick === "function";
  const n = () => props.node || {};
  const tone = STATUS_TOKEN[n().status] || STATUS_TOKEN.missing;
  const selectedCls = props.selected
    ? `${tone.border} ${tone.soft}`
    : "border-line bg-panel hover:bg-panel-2";
  const interactiveCls = "cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";
  const inner = (
    <>
      <span class={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
      <span class="mono shrink-0 text-[12px] text-body">{n().id}</span>
      <span class="min-w-0 flex-1 truncate text-[13px] leading-5 text-ink">{n().title}</span>
      <StatusBadge status={n().status || "open"} />
      <Show when={props.right}>
        <div class="flex shrink-0 items-center gap-2">{props.right}</div>
      </Show>
    </>
  );
  return (
    <Show when={interactive} fallback={
      <div class={`flex items-center gap-3 rounded-control border px-3 py-2 ${selectedCls}`}>
        {inner}
      </div>
    }>
      <button
        type="button"
        class={`flex min-h-[36px] w-full items-center gap-3 rounded-control border px-3 py-2 text-left ${selectedCls} ${interactiveCls}`}
        onClick={props.onClick}
      >
        {inner}
      </button>
    </Show>
  );
}

// === ProgressBar ===========================================================
// Segmented bar + legend. `segments` is an array of { tone, count, label? }.

export function ProgressBar(props) {
  // segments (array<{ tone: string, count: number, label?: string }>, required)
  const total = () =>
    props.segments.reduce((sum, s) => sum + Math.max(0, Number(s.count) || 0), 0);
  const seg = () => {
    const t = total();
    if (t === 0) return props.segments.map((s) => ({ ...s, pct: 0 }));
    return props.segments.map((s) => ({
      ...s,
      pct: (Math.max(0, Number(s.count) || 0) / t) * 100,
    }));
  };
  return (
    <div class="flex flex-col gap-2">
      <div
        class="flex h-2 w-full overflow-hidden rounded-full bg-mid"
        role="img"
        aria-label={props.segments.map((s) => `${s.label || s.tone}: ${s.count}`).join("; ")}
      >
        <For each={seg()}>
          {(s) => {
            const tone = STATUS_TOKEN[s.tone] || STATUS_TOKEN.missing;
            return (
              <span
                class={tone.dot}
                style={{ width: `${s.pct}%` }}
                title={`${s.label || s.tone}: ${s.count}`}
              />
            );
          }}
        </For>
      </div>
      <div class="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-mute">
        <For each={props.segments}>
          {(s) => {
            const tone = STATUS_TOKEN[s.tone] || STATUS_TOKEN.missing;
            return (
              <span class="inline-flex items-center gap-1.5">
                <span class={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
                <span>{s.label || s.tone}</span>
                <span class="tabular-nums">{s.count}</span>
              </span>
            );
          }}
        </For>
      </div>
    </div>
  );
}

// === LiveStatus ============================================================
// Read-only badge + last refresh timestamp. Tiny pulse dot while a refresh
// is in flight; muted dot on error; success dot when idle.

export function LiveStatus(props) {
  // lastAt     (ISO string | Date, optional)
  // refreshing (bool, optional)
  // error      (string | null, optional)
  // readOnly   (bool, optional; default true)
  const err = () => Boolean(props.error);
  const ref = () => Boolean(props.refreshing) && !err();
  return (
    <div class="inline-flex items-center gap-2 text-[12px] text-mute">
      <Show when={err()} fallback={
        <Show when={ref()} fallback={
          <span class="inline-block h-1.5 w-1.5 rounded-full bg-ready" aria-hidden="true" />
        }>
          <span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-progress" aria-hidden="true" />
        </Show>
      }>
        <span class="inline-block h-1.5 w-1.5 rounded-full bg-blocked" aria-hidden="true" />
      </Show>
      <Show when={props.readOnly !== false}>
        <span class="mono uppercase tracking-wider">Read-only</span>
      </Show>
      <Show when={props.lastAt}>
        <span class="mono" title={absoluteTs(props.lastAt)}>
          {ref() ? "refreshing…" : `last refresh ${fmtTime(props.lastAt)}`}
        </span>
      </Show>
    </div>
  );
}

// === Skeleton ===============================================================
// Placeholder block. aria-hidden so screen readers skip it; never mixes with
// real content (only used during the initial load state).

export function Skeleton(props) {
  // rows   (number, optional; default 1)
  // lines  (number, optional per-row lines; default 1)
  // class  (string, optional extra classes for the outer wrapper)
  const rows = Math.max(1, Number(props.rows) || 1);
  const lines = Math.max(1, Number(props.lines) || 1);
  const rowsArr = () => Array.from({ length: rows });
  const linesArr = () => Array.from({ length: lines });
  return (
    <div class={props.class || "flex flex-col gap-2"} aria-hidden="true">
      <For each={rowsArr()}>
        {() => (
          <div class="flex flex-col gap-1.5 rounded-control border border-line bg-panel p-3">
            <For each={linesArr()}>
              {() => <div class="h-3 w-full rounded-full bg-panel-2" />}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}

// === IconButton =============================================================
// Square icon-only control. `label` is required and doubles as aria-label and
// title (the visible text is the icon glyph; screen readers rely on the
// label). Square at all sizes — pill is not a button shape.

export function IconButton(props) {
  // label    (string, required — accessible name + tooltip)
  // onClick  (function, optional)
  // tone     ("neutral" | "danger", default "neutral")
  // size     ("sm" | "md", default "md")
  // disabled (bool, optional)
  // children (node, required — the icon glyph)
  const size = props.size === "sm" ? "h-8 w-8" : "h-9 w-9";
  const toneCls = props.tone === "danger"
    ? "border-line text-blocked hover:bg-blocked-soft"
    : "border-line text-body hover:bg-panel-2";
  const baseCls = `inline-flex ${size} shrink-0 items-center justify-center rounded-control border bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${toneCls}`;
  return (
    <button
      type="button"
      class={baseCls}
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.children}
    </button>
  );
}

// === Time ===================================================================
// Relative timestamp with absolute timestamp in the tooltip. Use <Time> for
// any free timestamp; use <ClaimTime> for a `claim` object so the contract
// (claim.at > claim.ts) is enforced at the call site.

const ABS_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function parseTs(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function absoluteTs(v) {
  const d = parseTs(v);
  if (!d) return "";
  return ABS_FORMAT.format(d);
}

export function Time(props) {
  // value (ISO string | Date, required)
  const d = parseTs(props.value);
  return (
    <span class="mono text-[12px] text-mute" title={d ? absoluteTs(d) : ""}>
      {d ? fmtTime(d) : "—"}
    </span>
  );
}

export function ClaimTime(props) {
  // claim ({ by?: string, at?: string, ts?: string } | null | undefined)
  // Prefers claim.at per the snapshot contract; falls back to claim.ts for
  // legacy compat. Avoid spreading the bug into new code.
  const claim = props.claim || {};
  const value = claim.at || claim.ts;
  return <Time value={value} />;
}

// === Back-compat for current views ==========================================
// Views under ui/src/views/*.jsx import a small set of legacy names. These
// shims keep them building while Fase 5 migrates them to the new contract.
// New code should use the new names directly.

export function StatCard(props) {
  return (
    <MetricCard
      value={props.value}
      label={props.label}
      onClick={props.onClick}
    />
  );
}

export function Section(props) {
  return (
    <Panel title={props.title} right={props.right}>
      {props.children}
    </Panel>
  );
}

export function Empty(props) {
  return <EmptyState variant="section" title={props.children} />;
}

// === Pure helpers ===========================================================
// Kept as named exports so callers that only need string formatting don't have
// to instantiate a Solid component.

export function fmtTime(ts) {
  const d = parseTs(ts);
  if (!d) return "";
  const diff = Date.now() - d.getTime();
  if (diff < 0) {
    // Future timestamps: keep the label honest.
    const ahead = -diff;
    if (ahead < 60_000) return "in seconds";
    if (ahead < 3_600_000) return `in ${Math.floor(ahead / 60_000)}m`;
    if (ahead < 86_400_000) return `in ${Math.floor(ahead / 3_600_000)}h`;
    return d.toLocaleString();
  }
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleString();
}

export function lastActionLabel(action) {
  const map = {
    "add-node": "created",
    take: "claimed",
    resolve: "resolved",
    release: "released",
    reopen: "reopened",
    cancel: "canceled",
    update: "updated",
    "add-note": "note",
    supersede: "superseded",
  };
  return map[action] || action;
}