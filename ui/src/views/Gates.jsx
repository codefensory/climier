// Gates view — Fase 5B Track B pieza 1.
//
// Contract (docs/ui-redesign-plan.md section 6, Fase 5B):
//   1. Tabs Open/Resolved/All + filters initiative/purpose/search.
//   2. Open gates surface their downstream impact (BLOCKS edges where the
//      gate is `from` and the target is still actionable).
//   3. Resolved gates preview only the choice + a 2-line clamp of the
//      rationale; full body lives behind the existing NodeDetail drawer.
//   4. Reading width is bounded by the shared 1440px page frame on big monitors; rows
//      don't stretch edge-to-edge forever.
//   5. Order is by initiative first, then status (open first), with impact
//      as the tiebreaker — never id alone.
//
// Identity contract (ADR-010 §3.4, ui-live-store-execution §3.4 / §12):
//   - consumes `useStoreSelectors().nodesMap()` so the gate references
//     iterated inside each Panel stay stable across polls when content
//     does not change;
//   - iterates initiative keys (strings) as the outer <For> source so
//     Panel identity is preserved across polls; the inner <For> iterates
//     gate refs from the reconciled map so GateRow DOM is preserved;
//   - filters, tabs and sorting behavior are preserved verbatim — only
//     the iteration target changed.
//
// Contract scope: this file owns its view and its pure helpers. components.jsx,
// store.jsx, the snapshot shape and the NodeDetail drawer stay frozen per the
// Fase 5B rule (primitives only grow via the shared components contract, not
// here). The drawer is reused via `select(id)`; we do not render our own.
//
// Pure helpers are exported as named functions so the Fase 5B contract can be
// pinned by tests without re-implementing the view (see test/ui-gates.test.mjs).

import { createMemo, createSignal, Show, For } from "solid-js";
import { useStore, useStoreSelectors } from "../store.jsx";
import {
  PageHeader,
  PageLayout,
  FilterBar,
  Panel,
  EmptyState,
  StatusBadge,
  KindBadge,
  Chip,
  Time,
} from "../components.jsx";

const PURPOSES = ["decision", "approval", "external-dependency", "research"];

const TABS = [
  { key: "open", label: "Open" },
  { key: "resolved", label: "Resolved" },
  { key: "all", label: "All" },
];

// Statuses that mean "this target can never be re-blocked by anything" —
// counting them in downstream impact would inflate the number an operator
// sees without telling them about real work.
const TERMINAL_TARGET_STATUSES = new Set([
  "done",
  "canceled",
  "superseded",
  "archived",
]);

// Returns the BLOCKS edges whose source is `gateId` and whose target is
// still actionable. The caller cares about the count; the row preview also
// shows up to 4 target ids so the operator can see what they would free.
// `nodes` is the reconciled entity map; consumers pass it directly so
// identity stays stable across polls.
export function downstreamImpact(edges, gateId, nodes) {
  if (!Array.isArray(edges)) return [];
  return edges.filter((e) => {
    if (!e || e.type !== "BLOCKS") return false;
    if (e.from !== gateId) return false;
    const target = nodes && nodes[e.to];
    if (!target) return false;
    if (TERMINAL_TARGET_STATUSES.has(target.status)) return false;
    return true;
  });
}

// Clamps free text to N newline-terminated lines. Used for body/rationale
// previews so a long decision text does not push real estate out of the
// list. Returns "" for falsy input so callers can <Show when={...}>.
export function previewLines(text, max = 2) {
  if (!text) return "";
  const lines = String(text).split(/\r?\n/);
  if (lines.length <= max) return text;
  return lines.slice(0, max).join("\n") + "…";
}

// True if `g` should be treated as "open work" — gates waiting on someone.
// Mirrors the persistence default of status === "open" plus "superseded"
// being deliberately excluded (a superseded gate never blocks anything).
// A null/undefined gate is not "open" — there is no gate at all.
export function isOpenGate(g) {
  if (!g) return false;
  const s = g.status || "open";
  return s === "open";
}

// Group gates by initiative. Initiatives with no gate are skipped (this view
// never invents content). Within each group, gates are sorted so that open
// gates come first, and within open gates higher downstream impact wins.
// Groups are sorted so that groups containing any open gate come first,
// otherwise alphabetically — operators scan the "what blocks work?" set
// before they audit the historical record.
//
// Returns a list of `{ initiative, gates }` records (not tuples) so callers
// can iterate the outer list with stable object identity when grouped
// objects are produced by a memo. `nodes` is the reconciled entity map.
export function groupAndSortGates(gates, edges, nodes) {
  const by = new Map();
  for (const g of gates) {
    if (!g) continue;
    const k = g.initiative || "—";
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(g);
  }
  const groups = [];
  for (const [initiative, list] of by.entries()) {
    list.sort((a, b) => {
      const aOpen = isOpenGate(a) ? 0 : 1;
      const bOpen = isOpenGate(b) ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
      const ai = isOpenGate(a)
        ? downstreamImpact(edges, a.id, nodes).length
        : 0;
      const bi = isOpenGate(b)
        ? downstreamImpact(edges, b.id, nodes).length
        : 0;
      if (bi !== ai) return bi - ai; // desc
      return a.id.localeCompare(b.id);
    });
    groups.push({ initiative, gates: list });
  }
  groups.sort((a, b) => {
    const aHasOpen = a.gates.some(isOpenGate);
    const bHasOpen = b.gates.some(isOpenGate);
    if (aHasOpen !== bHasOpen) return aHasOpen ? -1 : 1;
    return a.initiative.localeCompare(b.initiative);
  });
  return groups;
}

function GateRow(props) {
  // gate          (object)
  // impactCount   (number)
  // impactSample  (string[])  — up to 4 target ids
  // lastActivity  (object|null)
  // onOpen        (function)
  const gate = () => props.gate;
  const open = () => isOpenGate(gate());
  const hasImpact = () => open() && props.impactCount > 0;
  return (
    <button
      type="button"
      class={`ui-list-row flex min-h-[36px] w-full items-stretch gap-3 rounded-control border border-line bg-panel px-3 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 cursor-pointer`}
      onClick={props.onOpen}
      aria-label={`Open ${gate().id} — ${gate().title}`}
    >
      <div class="flex min-w-0 flex-1 flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-2">
          <span class="mono shrink-0 text-[12px] text-body">{gate().id}</span>
          <KindBadge node={gate()} />
          <StatusBadge status={gate().status || "open"} />
          <Show when={gate().purpose}>
            <Chip tone="gate">{gate().purpose}</Chip>
          </Show>
          <Show when={hasImpact()}>
            <span
              class={`ml-auto inline-flex items-center gap-1 rounded-full border border-blocked bg-blocked-soft px-2 py-0.5 text-[12px] font-medium tabular-nums text-blocked`}
              title={`${props.impactCount} task(s) currently blocked by this gate`}
            >
              <span aria-hidden="true">↓</span>
              {props.impactCount} blocked
            </span>
          </Show>
        </div>
        <div class="min-w-0">
          <div class="truncate text-[13px] leading-5 font-medium text-ink" title={gate().title}>
            {gate().title}
          </div>
          <Show when={gate().resolution}>
            <div class="mt-1 line-clamp-2 whitespace-pre-wrap text-[12px] leading-4 text-body" title={previewLines(gate().resolution.rationale, 2)}>
              {previewLines(gate().resolution.rationale, 2)}
            </div>
          </Show>
          <Show when={!gate().resolution && gate().body}>
            <div class="mt-1 line-clamp-2 whitespace-pre-wrap text-[12px] leading-4 text-body" title={gate().body}>
              {previewLines(gate().body, 2)}
            </div>
          </Show>
        </div>
        <Show when={hasImpact() && props.impactSample.length > 0}>
          <div class="flex flex-wrap items-center gap-1.5 text-[12px] text-mute">
            <span>blocks:</span>
            <For each={props.impactSample}>
              {(id) => (
                <Chip disabled>
                  <span class="mono">{id}</span>
                </Chip>
              )}
            </For>
            <Show when={props.impactCount > props.impactSample.length}>
              <span>+{props.impactCount - props.impactSample.length} more</span>
            </Show>
          </div>
        </Show>
      </div>
      <div class="flex shrink-0 flex-col items-end justify-between gap-1 text-right">
        <Show when={props.lastActivity}>
          <span class="mono text-[11px] text-mute">{props.lastActivity.action}</span>
          <Time value={props.lastActivity.ts} />
        </Show>
        <span class="mono text-[11px] text-mute">
          notes {gate().notes?.length || 0}
        </span>
      </div>
    </button>
  );
}

export default function Gates() {
  const { snapshot, select } = useStore();
  const selectors = useStoreSelectors();
  const s = () => snapshot();
  const nodesById = () => selectors.nodesMap();

  const [tab, setTab] = createSignal("open");
  const [q, setQ] = createSignal("");
  const [initiative, setInitiative] = createSignal("");
  const [purpose, setPurpose] = createSignal("");

  // Gate IDs from the reconciled map. The map reference is stable across
  // polls when no gate is added/removed or changes subkind, so the id
  // list is stable too. Inner content updates don't invalidate identity.
  const gateIds = createMemo(() => {
    const map = nodesById();
    const out = [];
    for (const id of Object.keys(map)) {
      const n = map[id];
      if (n && n.subkind === "gate") out.push(id);
    }
    return out;
  });

  const allGates = createMemo(() => {
    const map = nodesById();
    const out = [];
    for (const id of gateIds()) {
      const n = map[id];
      if (n) out.push(n);
    }
    return out;
  });

  const initiatives = createMemo(() => {
    const set = new Set();
    for (const g of allGates()) if (g.initiative) set.add(g.initiative);
    return [...set].sort();
  });

  const summary = createMemo(() => {
    const all = allGates();
    return {
      total: all.length,
      open: all.filter(isOpenGate).length,
      resolved: all.filter((g) => g.status === "resolved").length,
      superseded: all.filter((g) => g.status === "superseded").length,
      canceled: all.filter((g) => g.status === "canceled").length,
    };
  });

  // Filter to the ids that pass the current filters, then build full
  // gate refs from the reconciled map. Filtering by id first keeps the
  // iteration target primitive; downstream iteration over those ids is
  // identity-stable even when the filter set shifts.
  const scopedIds = createMemo(() => {
    const map = nodesById();
    let ids = gateIds();
    if (tab() === "open") {
      ids = ids.filter((id) => isOpenGate(map[id]));
    } else if (tab() === "resolved") {
      ids = ids.filter((id) => map[id] && map[id].status === "resolved");
    } else {
      ids = ids.filter((id) => {
        const n = map[id];
        return n && n.status !== "archived";
      });
    }
    const iniWanted = initiative();
    if (iniWanted) ids = ids.filter((id) => map[id] && map[id].initiative === iniWanted);
    const purposeWanted = purpose();
    if (purposeWanted) ids = ids.filter((id) => map[id] && map[id].purpose === purposeWanted);
    const needle = q();
    if (needle) {
      const lower = needle.toLowerCase();
      ids = ids.filter((id) => {
        const g = map[id];
        if (!g) return false;
        const hay = `${g.id} ${g.title} ${g.body || ""} ${(g.tags || []).join(" ")} ${g.purpose || ""}`.toLowerCase();
        return hay.includes(lower);
      });
    }
    return ids;
  });

  // Group + sort. Edges (used for impact sort) are read from the
  // snapshot directly; this is intentional. The memo recomputes when
  // snapshot edges change reference, but the resulting inner arrays
  // still contain the same stable gate refs from the reconciled map,
  // so <For> preserves the GateRow DOM. The grouping structure uses
  // `{ initiative, gates }` records instead of tuples so callers can
  // iterate stable objects.
  const grouped = createMemo(() => {
    const map = nodesById();
    const scoped = [];
    for (const id of scopedIds()) {
      const n = map[id];
      if (n) scoped.push(n);
    }
    return groupAndSortGates(scoped, s()?.edges || [], map);
  });

  // Stable outer iteration: pull the initiative keys out of the
  // grouped memo. Strings are stable across polls (even if the memo
  // recomputes its outer array each poll because edges changed ref),
  // so <For> matches Panels by value identity.
  const groupKeys = createMemo(() => grouped().map((g) => g.initiative));

  // Per-group gate arrays. Inner arrays contain the same stable gate
  // refs the grouped memo produced; <For> preserves row identity
  // because gate refs are stable.
  const gatesByInitiative = createMemo(() => {
    const out = {};
    for (const g of grouped()) out[g.initiative] = g.gates;
    return out;
  });

  function clearFilters() {
    setQ("");
    setInitiative("");
    setPurpose("");
  }

  const filterIsActive = () =>
    Boolean(q() || initiative() || purpose() || tab() !== "all");

  return (
    <PageLayout>
      <PageHeader
        eyebrow="Decisions"
        title="Gates"
        subtitle="Open decisions, approvals, and research that block downstream work. Resolved and superseded gates stay on the record for audit."
        right={
          <span class="text-[12px] text-mute tabular-nums">
            <span class="font-medium text-ink">{summary().open}</span>
            <span class="mx-1">open</span>
            <span class="mx-1 text-line">·</span>
            <span class="font-medium text-ink">{summary().resolved}</span>
            <span class="mx-1">resolved</span>
          </span>
        }
        sticky
      />

      <div class="ui-page-controls">
        <div>
          <div
            role="tablist"
            class="ui-tab-strip flex flex-wrap items-center gap-1 rounded-control border border-line p-1"
            aria-label="Gate status filter"
          >
            <For each={TABS}>
              {(t) => {
                const active = () => tab() === t.key;
                const count = () => {
                  if (t.key === "open") return summary().open;
                  if (t.key === "resolved") return summary().resolved;
                  return summary().total;
                };
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active()}
                    class={`inline-flex min-h-[36px] items-center gap-2 rounded-control px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 ${
                      active()
                        ? "bg-panel text-ink shadow-sm"
                        : "text-mute hover:bg-panel hover:text-body"
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
              hint=""
              onClear={clearFilters}
              clearLabel="Clear filters"
            >
              <input
                type="search"
                value={q()}
                onInput={(e) => setQ(e.currentTarget.value)}
                placeholder="search id / title / body…"
                aria-label="Search gates"
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
                value={purpose()}
                onChange={(e) => setPurpose(e.currentTarget.value)}
                aria-label="Filter by purpose"
                class="min-h-[36px] rounded-control border border-line bg-panel-2 px-3 text-[13px] outline-none"
              >
                <option value="">All purposes</option>
                <For each={PURPOSES}>{(p) => <option value={p}>{p}</option>}</For>
              </select>
            </FilterBar>
          </div>
        </div>
      </div>

      <div class="ui-page-results space-y-6">
        <div>
          <Show when={groupKeys().length === 0}>
            <Show
              when={filterIsActive()}
              fallback={
                <EmptyState
                  variant="page"
                  title="No gates yet"
                  hint="Gates appear here when a decision, approval, or external dependency needs a verdict before downstream work can move."
                />
              }
            >
              <EmptyState
                variant="section"
                title="No gates match the current filters"
                hint="Clear filters or switch tab to see the rest of the record."
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
          </Show>

          <For each={groupKeys()}>
            {(k) => {
              const list = () => gatesByInitiative()[k] || [];
              return (
                <Panel
                  eyebrow={k === "—" ? "no initiative" : "initiative"}
                  title={k === "—" ? "—" : k}
                  right={
                    <span class="text-[12px] tabular-nums text-mute">
                      {list().length} gate{list().length === 1 ? "" : "s"}
                      <Show when={list().some(isOpenGate)}>
                        <span class="mx-1 text-line">·</span>
                        <span class="text-gate">
                          {list().filter(isOpenGate).length} open
                        </span>
                      </Show>
                    </span>
                  }
                >
                  <div class="space-y-3">
                    <For each={list()}>
                      {(g) => {
                        // Per-row impact recomputes when edges change
                        // ref, but the GateRow DOM stays because the
                        // outer <For> matches by stable gate ref.
                        const impact = () =>
                          downstreamImpact(s()?.edges || [], g.id, nodesById());
                        const sample = () => impact().slice(0, 4).map((e) => e.to);
                        const lastActivity = () => s()?.last_activity?.[g.id];
                        return (
                          <GateRow
                            gate={g}
                            impactCount={impact().length}
                            impactSample={sample()}
                            lastActivity={lastActivity()}
                            onOpen={() => select(g.id)}
                          />
                        );
                      }}
                    </For>
                  </div>
                </Panel>
              );
            }}
          </For>
        </div>
      </div>
    </PageLayout>
  );
}
