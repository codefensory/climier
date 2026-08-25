// Knowledge view — Fase 5B Track B pieza 2.
//
// Contract (docs/ui-redesign-plan.md section 6, Fase 5B):
//   1. Filters compose: initiative, knowledge type, scope dimension (plus the
//      specific scope value inside that dimension), and the deprecated
//      toggle (driven by the Active / Deprecated / All tab).
//   2. Scope is grouped by dimension (Domains / Initiatives / Tags /
//      Node IDs). No more flat blob of 10–11 px chips.
//   3. Mitigation is rendered as a secondary callout with its own visual
//      hierarchy — distinctly softer than the body — so the operator can
//      scan "what to do about it" without it dominating the title.
//   4. Cards live inside a 2-column grid only when the viewport is wide
//      enough; on smaller screens they stack. A `max-w-[1280px]` wrapper
//      keeps reading width controlled on big monitors.
//   5. The semantic accent sits on the badges/icon, not on a coloured
//      border around every card. Cards share the same hairline neutral
//      border as Gates / Tasks / Activity.
//   6. Empty states distinguish "no knowledge registered" from "no match
//      for these filters" — never a single dashed box for both.
//   7. Deprecated nodes are kept visible by default (tab-gated, not
//      hidden) with text contrast against the muted background that
//      meets the same floor as other secondary copy.
//
// Contract scope: this file owns its view and its pure helpers.
// components.jsx, store.jsx, Gates.jsx, the snapshot shape and the
// NodeDetail drawer stay frozen per the Fase 5B rule (primitives only grow
// via the shared components contract, not here). The drawer is reused via
// `select(id)`; we do not render our own.
//
// Pure helpers are exported as named functions so the contract can be
// pinned by tests without re-implementing the view (see
// test/ui-knowledge.test.mjs).

import { createMemo, createSignal, Show, For } from "solid-js";
import { useStore } from "../store.jsx";
import {
  PageHeader,
  FilterBar,
  Panel,
  EmptyState,
  StatusBadge,
  KindBadge,
  Chip,
  Time,
} from "../components.jsx";

// Tabs drive the deprecated visibility. "active" mirrors the persistence
// default; "all" includes deprecated plus anything else that may grow
// (e.g. archived knowledge if the model gains it later).
const TABS = [
  { key: "active", label: "Active", matches: ["active"] },
  { key: "deprecated", label: "Deprecated", matches: ["deprecated"] },
  { key: "all", label: "All", matches: ["active", "deprecated"] },
];

// Scope dimension metadata. The tone stays neutral except for `node_ids`,
// which inherits the BLOCKS / relational semantic so operators can tell at
// a glance that those IDs are pointing at specific graph nodes.
const SCOPE_DIMENSIONS = [
  { key: "domains", label: "Domains", tone: "neutral" },
  { key: "initiatives", label: "Initiatives", tone: "neutral" },
  { key: "tags", label: "Tags", tone: "neutral" },
  { key: "node_ids", label: "Node IDs", tone: "blocked" },
];

// Returns the scope groups for a knowledge node, one entry per non-empty
// dimension. Each entry carries the dimension label, the tone used for
// the chips, and the items as plain strings. Empty dimensions are skipped
// so the view never has to render "Domains: (empty)" — the dimension only
// shows up when there is at least one entry. Defensive against missing
// or malformed scope objects.
export function groupScope(scope) {
  if (!scope || typeof scope !== "object") return [];
  const out = [];
  for (const dim of SCOPE_DIMENSIONS) {
    const items = scope[dim.key];
    if (!Array.isArray(items)) continue;
    const filtered = items.filter((s) => typeof s === "string" && s.length > 0);
    if (filtered.length === 0) continue;
    out.push({
      key: dim.key,
      label: dim.label,
      tone: dim.tone,
      items: filtered,
    });
  }
  return out;
}

// Clamps free text to N newline-terminated lines. Used for body previews
// so a long note does not push real estate out of the list. Returns "" for
// falsy input so callers can <Show when={...}>.
export function previewBody(body, max = 4) {
  if (!body) return "";
  const lines = String(body).split(/\r?\n/);
  if (lines.length <= max) return body;
  return lines.slice(0, max).join("\n") + "…";
}

// Status predicates. Missing status defaults to "active" — that matches
// the persistence default in src/commands/add-knowledge.mjs. A null/undef
// node is not active and not deprecated (there is no node at all).
export function isDeprecated(k) {
  return Boolean(k) && k.status === "deprecated";
}

export function isActive(k) {
  return Boolean(k) && (!k.status || k.status === "active");
}

// Filter a list of knowledge nodes by the operator's current filter
// state. The view owns this composition — primitives do not — because
// the contract is the view's, not the data model's.
export function filterKnowledge(list, f) {
  if (!Array.isArray(list)) return [];
  let out = list.filter(Boolean);
  // Tab → deprecated visibility.
  if (!f.showDeprecated) {
    out = out.filter((n) => !isDeprecated(n));
  }
  if (f.initiative) out = out.filter((n) => n.initiative === f.initiative);
  if (f.knowledgeType) {
    out = out.filter((n) => (n.knowledge_type || "") === f.knowledgeType);
  }
  if (f.scopeDimension) {
    const dim = SCOPE_DIMENSIONS.find((d) => d.label === f.scopeDimension);
    if (dim) {
      out = out.filter((n) => {
        const sc = (n && n.scope) || {};
        const items = Array.isArray(sc[dim.key]) ? sc[dim.key] : [];
        if (!f.scopeValue) return items.length > 0;
        return items.includes(f.scopeValue);
      });
    }
  }
  if (f.q) {
    const needle = f.q.toLowerCase();
    out = out.filter((n) =>
      `${n.id || ""} ${n.title || ""} ${n.body || ""} ${n.knowledge_type || ""}`
        .toLowerCase()
        .includes(needle),
    );
  }
  return out;
}

// Build a sorted unique list of values for a given field across the
// knowledge list. Returns [] for missing input or unknown fields so the
// caller never has to defend against a typo at the call site.
export function buildFacetOptions(list, field) {
  if (!Array.isArray(list)) return [];
  const set = new Set();
  for (const n of list) {
    if (!n) continue;
    const v = n[field];
    if (typeof v === "string" && v.length > 0) set.add(v);
  }
  return [...set].sort();
}

// One knowledge card. Border is neutral hairline (line); the semantic
// accent lives on the badges (StatusBadge + KindBadge). Deprecated cards
// keep contrast via the title staying ink-coloured and the metadata
// staying on the body's secondary colour instead of mute — small text
// over a slightly darker surface still passes the AA floor.
function KnowledgeCard(props) {
  // node         (object, required)
  // scopeGroups  (array<{label,tone,items}>, required)
  // onOpen       (function, required)
  // lastActivity (object|null)
  const k = () => props.node;
  const groups = () => props.scopeGroups || [];
  const deprecated = () => isDeprecated(k());
  // Mitigation is its own callout; tone tracks the knowledge_type so a
  // "warning" knowledge node gets a warning-styled callout. We deliberately
  // avoid knowledge-coloured tones here — the body already carries that
  // hue via the KindBadge / knowledge_type chip.
  const mitigationTone = () => {
    const t = k().knowledge_type;
    if (t === "warning") return "warning";
    return "info";
  };
  return (
    <article
      class={`flex h-full flex-col rounded-card border border-line bg-panel transition-colors hover:border-mid focus-within:border-mid`}
    >
      <button
        type="button"
        class={`flex min-h-[36px] w-full items-center justify-between gap-3 rounded-t-card px-4 py-3 text-left transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 cursor-pointer`}
        onClick={props.onOpen}
        aria-label={`Open ${k().id} — ${k().title}`}
      >
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span class="mono shrink-0 text-[12px] text-body">{k().id}</span>
          <KindBadge node={k()} />
          <StatusBadge status={k().status || "active"} />
          <Show when={k().knowledge_type}>
            <Chip tone="knowledge">{k().knowledge_type}</Chip>
          </Show>
          <Show when={k().initiative}>
            <Chip>{k().initiative}</Chip>
          </Show>
        </div>
        <span class="mono shrink-0 text-[11px] text-mute">
          notes {k().notes?.length || 0}
        </span>
      </button>

      <div class="flex flex-1 flex-col gap-3 px-4 pb-4 pt-1">
        <h3 class="text-[15px] leading-6 font-semibold text-ink">{k().title}</h3>
        <Show when={k().body}>
          <p class="whitespace-pre-wrap text-[13px] leading-5 text-body" title={k().body}>
            {previewBody(k().body, 4)}
          </p>
        </Show>

        <Show when={k().mitigation}>
          <aside
            class={`rounded-control border px-3 py-2 text-[12px] leading-5 ${
              mitigationTone() === "warning"
                ? "border-gate bg-gate-soft text-gate"
                : "border-progress bg-progress-soft text-progress"
            }`}
            aria-label="Mitigation"
          >
            <div class="flex items-center gap-1.5 font-semibold uppercase tracking-wider">
              <span aria-hidden="true">↳</span>
              <span>Mitigation</span>
            </div>
            <div class="mt-1 whitespace-pre-wrap text-body">
              {k().mitigation}
            </div>
          </aside>
        </Show>

        <Show when={groups().length > 0}>
          <div class="flex flex-col gap-2">
            <For each={groups()}>
              {(g) => (
                <div class="flex flex-col gap-1">
                  <span class="mono text-[11px] uppercase tracking-wider text-mute">
                    {g.label}
                  </span>
                  <div class="flex flex-wrap gap-1.5">
                    <For each={g.items}>
                      {(item) => (
                        <Chip tone={g.tone === "blocked" ? "blocked" : undefined}>
                          <span class="mono">{item}</span>
                        </Chip>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show
          when={
            deprecated()
              ? k().deprecated_at || k().deprecation_reason
              : props.lastActivity
          }
        >
          <div class="mt-auto flex items-center justify-between gap-2 border-t border-line pt-2 text-[11px] text-mute">
            <Show when={deprecated()}>
              <span class="inline-flex items-center gap-1.5">
                <span aria-hidden="true">⊘</span>
                <span class="text-body">Deprecated</span>
                <Show when={k().deprecated_at}>
                  <Time value={k().deprecated_at} />
                </Show>
              </span>
            </Show>
            <Show when={!deprecated() && props.lastActivity}>
              <span class="inline-flex items-center gap-1.5">
                <span class="mono">{props.lastActivity.action}</span>
                <Time value={props.lastActivity.ts} />
              </span>
            </Show>
            <Show when={deprecated() && k().deprecated_by}>
              <span class="mono">by {k().deprecated_by}</span>
            </Show>
          </div>
        </Show>
      </div>
    </article>
  );
}

export default function Knowledge() {
  const { snapshot, select } = useStore();
  const s = () => snapshot();
  const nodes = () => s()?.nodes || {};

  const [tab, setTab] = createSignal("active");
  const [q, setQ] = createSignal("");
  const [initiative, setInitiative] = createSignal("");
  const [knowledgeType, setKnowledgeType] = createSignal("");
  const [scopeDimension, setScopeDimension] = createSignal("");
  const [scopeValue, setScopeValue] = createSignal("");

  const allKnowledge = createMemo(() =>
    Object.values(nodes()).filter((n) => n && n.kind === "knowledge"),
  );

  const summary = createMemo(() => {
    const all = allKnowledge();
    return {
      total: all.length,
      active: all.filter(isActive).length,
      deprecated: all.filter(isDeprecated).length,
    };
  });

  const initiatives = createMemo(() =>
    buildFacetOptions(allKnowledge(), "initiative"),
  );
  const knowledgeTypes = createMemo(() =>
    buildFacetOptions(allKnowledge(), "knowledge_type"),
  );

  // Scope value facet depends on the active dimension: when the operator
  // changes the dimension, the available values should follow. We compute
  // the candidates off the full list (not the filtered one) so a value
  // never disappears mid-edit just because a sibling filter hid its node.
  const scopeValueOptions = createMemo(() => {
    const dim = SCOPE_DIMENSIONS.find((d) => d.label === scopeDimension());
    if (!dim) return [];
    const set = new Set();
    for (const n of allKnowledge()) {
      const sc = (n && n.scope) || {};
      const items = Array.isArray(sc[dim.key]) ? sc[dim.key] : [];
      for (const v of items) {
        if (typeof v === "string" && v.length > 0) set.add(v);
      }
    }
    return [...set].sort();
  });

  const filters = createMemo(() => ({
    initiative: initiative(),
    knowledgeType: knowledgeType(),
    scopeDimension: scopeDimension(),
    scopeValue: scopeValue(),
    showDeprecated: tab() !== "active",
    q: q(),
  }));

  const scoped = createMemo(() => filterKnowledge(allKnowledge(), filters()));

  const filterIsActive = () =>
    Boolean(
      q() ||
        initiative() ||
        knowledgeType() ||
        scopeDimension() ||
        scopeValue() ||
        tab() === "deprecated",
    );

  function clearFilters() {
    setQ("");
    setInitiative("");
    setKnowledgeType("");
    setScopeDimension("");
    setScopeValue("");
    setTab("active");
  }

  return (
    <div class="flex h-full flex-col">
      <PageHeader
        eyebrow="Context"
        title="Knowledge"
        subtitle="Durable facts and warnings scoped to initiatives, domains, tags, or specific nodes. Deprecated entries stay visible so the audit trail is complete."
        right={
          <span class="text-[12px] text-mute tabular-nums">
            <span class="font-medium text-ink">{summary().active}</span>
            <span class="mx-1">active</span>
            <span class="mx-1 text-line">·</span>
            <span class="font-medium text-ink">{summary().deprecated}</span>
            <span class="mx-1">deprecated</span>
            <Show when={summary().total > 0}>
              <span class="mx-1 text-line">·</span>
              <span class="text-mute">{summary().total} total</span>
            </Show>
          </span>
        }
        sticky
      />

      <div class="border-b border-line bg-canvas/95 px-4 py-3">
        <div class="mx-auto max-w-[1280px]">
          <div
            role="tablist"
            class="-mb-px flex flex-wrap items-center gap-1 border-b border-line"
            aria-label="Knowledge status filter"
          >
            <For each={TABS}>
              {(t) => {
                const active = () => tab() === t.key;
                const count = () => {
                  if (t.key === "active") return summary().active;
                  if (t.key === "deprecated") return summary().deprecated;
                  return summary().total;
                };
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active()}
                    class={`inline-flex min-h-[36px] items-center gap-2 border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 ${
                      active()
                        ? "border-knowledge text-ink"
                        : "border-transparent text-mute hover:text-body"
                    }`}
                    onClick={() => setTab(t.key)}
                  >
                    {t.label}
                    <span class="tabular-nums text-[12px] text-mute">
                      {count()}
                    </span>
                  </button>
                );
              }}
            </For>
          </div>
          <div class="pt-3">
            <FilterBar
              label="Filters"
              onClear={clearFilters}
              clearLabel="Clear filters"
            >
              <input
                type="search"
                value={q()}
                onInput={(e) => setQ(e.currentTarget.value)}
                placeholder="search id / title / body…"
                aria-label="Search knowledge"
                class="min-h-[36px] flex-1 rounded-control border border-line bg-panel-2 px-3 text-[13px] outline-none focus:border-mid"
              />
              <select
                value={initiative()}
                onChange={(e) => setInitiative(e.currentTarget.value)}
                aria-label="Filter by initiative"
                class="min-h-[36px] rounded-control border border-line bg-panel-2 px-3 text-[13px] outline-none"
              >
                <option value="">All initiatives</option>
                <For each={initiatives()}>
                  {(i) => <option value={i}>{i}</option>}
                </For>
              </select>
              <select
                value={knowledgeType()}
                onChange={(e) => setKnowledgeType(e.currentTarget.value)}
                aria-label="Filter by knowledge type"
                class="min-h-[36px] rounded-control border border-line bg-panel-2 px-3 text-[13px] outline-none"
              >
                <option value="">All types</option>
                <For each={knowledgeTypes()}>
                  {(t) => <option value={t}>{t}</option>}
                </For>
              </select>
              <select
                value={scopeDimension()}
                onChange={(e) => {
                  setScopeDimension(e.currentTarget.value);
                  setScopeValue("");
                }}
                aria-label="Filter by scope dimension"
                class="min-h-[36px] rounded-control border border-line bg-panel-2 px-3 text-[13px] outline-none"
              >
                <option value="">Any scope</option>
                <For each={SCOPE_DIMENSIONS}>
                  {(d) => <option value={d.label}>{d.label}</option>}
                </For>
              </select>
              <Show when={scopeDimension()}>
                <select
                  value={scopeValue()}
                  onChange={(e) => setScopeValue(e.currentTarget.value)}
                  aria-label={`Filter by ${scopeDimension()} value`}
                  class="min-h-[36px] rounded-control border border-line bg-panel-2 px-3 text-[13px] outline-none"
                >
                  <option value="">Any value</option>
                  <For each={scopeValueOptions()}>
                    {(v) => <option value={v}>{v}</option>}
                  </For>
                </select>
              </Show>
            </FilterBar>
          </div>
        </div>
      </div>

      <div class="flex-1 overflow-auto">
        <div class="mx-auto max-w-[1280px] p-4 lg:p-6">
          <Show
            when={allKnowledge().length > 0}
            fallback={
              <EmptyState
                variant="page"
                title="No knowledge recorded yet"
                hint="Knowledge nodes appear here once you record durable facts, warnings, or patterns via the CLI. They survive across sessions and tasks."
              />
            }
          >
            <Show when={scoped().length === 0}>
              <EmptyState
                variant="section"
                title="No knowledge matches the current filters"
                hint="Adjust the filters above or clear them to see the rest of the record."
                cta={
                  <button
                    type="button"
                    class="inline-flex min-h-[36px] items-center rounded-control border border-line bg-panel px-3 text-[13px] hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
                    onClick={clearFilters}
                  >
                    Clear filters
                  </button>
                }
              />
            </Show>
            <Show when={scoped().length > 0}>
              <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <For each={scoped()}>
                  {(k) => {
                    const groups = groupScope(k.scope || {});
                    const lastActivity = s()?.last_activity?.[k.id];
                    return (
                      <KnowledgeCard
                        node={k}
                        scopeGroups={groups}
                        lastActivity={lastActivity}
                        onOpen={() => select(k.id)}
                      />
                    );
                  }}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}
