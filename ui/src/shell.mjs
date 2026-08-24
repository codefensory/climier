// ui/src/shell.mjs
//
// Pure helpers for the responsive shell (Phase 3 / F3c of
// docs/ui-redesign-plan.md sections 4-layout and 6-Fase 3, plus
// "Estados de datos").
//
// Why a separate file: App.jsx is JSX with reactivity glue; the breakpoint
// math and responsive-state derivation are pure and can be exercised by the
// test suite without a JSX loader. Keeping them here means App.jsx stays
// focused on rendering and lifecycle, while the rules themselves live where
// they can be locked down by `node --test`.

// === Breakpoint model ======================================================
// Three buckets, named after ui/DESIGN.md §3.1 and docs/ui-redesign-plan.md
// §4 Layout:
//   - NARROW: < 768 px. Topbar + drawer; the sidebar is hidden behind the
//     drawer and toggled by a hamburger button.
//   - MID:    768–1279 px. Rail 64–72 px wide; nav labels hidden, icons
//     (the first letter of each label) shown.
//   - WIDE:   >= 1280 px. Full sidebar 240 px wide with labels.
//
// Thresholds are exclusive at the upper bound (CSS uses max-width media
// queries); the mid bucket runs from 768 (inclusive) to 1280 (exclusive).

export const BREAKPOINT = Object.freeze({
  NARROW: "narrow",
  MID:    "mid",
  WIDE:   "wide",
});

export const BREAKPOINT_THRESHOLDS = Object.freeze({
  narrow_max: 767,
  mid_max:    1279,
});

// classifyWidth maps a viewport width (px) to a breakpoint. The function is
// pure: a missing / non-numeric input is treated as WIDE so SSR / test
// environments render the most permissive layout and never collapse
// silently to a drawer.
export function classifyWidth(width) {
  if (typeof width !== "number" || !Number.isFinite(width)) return BREAKPOINT.WIDE;
  if (width <= BREAKPOINT_THRESHOLDS.narrow_max) return BREAKPOINT.NARROW;
  if (width <= BREAKPOINT_THRESHOLDS.mid_max) return BREAKPOINT.MID;
  return BREAKPOINT.WIDE;
}

// === Sidebar / rail geometry ==============================================
// Pixel widths per breakpoint. Values mirror the design contract:
//   - WIDE  -> 240 px (DESIGN.md §3.1 wide column)
//   - MID   -> 72 px (DESIGN.md §3.1 mid rail upper bound)
//   - NARROW -> 0 px (no permanent sidebar; drawer overlay only)
//
// Exposed as a lookup so tests can assert the contract directly and the
// Sidebar component can render the right Tailwind class without re-deriving
// the math.
export const SIDEBAR_WIDTH_PX = Object.freeze({
  narrow: 0,
  mid:    72,
  wide:   240,
});

export function sidebarWidthPx(breakpoint) {
  return SIDEBAR_WIDTH_PX[breakpoint] ?? SIDEBAR_WIDTH_PX.wide;
}

// === Visibility flags =====================================================
// Whether the permanent sidebar shows full labels (WIDE only), rail icons
// (MID), or is hidden behind the drawer (NARROW). All three are pure reads
// off the breakpoint, which keeps the JSX free of width math.
export function sidebarShowsLabels(breakpoint) {
  return breakpoint === BREAKPOINT.WIDE;
}

export function sidebarShowsGroupHeaders(breakpoint) {
  return breakpoint === BREAKPOINT.WIDE;
}

export function drawerAvailable(breakpoint) {
  return breakpoint === BREAKPOINT.NARROW;
}

// === Rail icon label ======================================================
// On MID breakpoints the rail shows a single square button per route. There
// is no icon library (DESIGN.md §8) so each route gets a 1-2 character
// abbreviation derived from its label. The map is exhaustive over ROUTE_META
// ids — see `test/ui-shell-layout.test.mjs`.
export const RAIL_GLYPH = Object.freeze({
  overview:  "Ov",
  board:     "Bo",
  graph:     "Gr",
  tasks:     "Tk",
  gates:     "Gt",
  knowledge: "Kn",
  activity:  "Ac",
});

export function railGlyph(id) {
  return RAIL_GLYPH[id] || id.slice(0, 2).toUpperCase();
}

// === Project display name =================================================
// The server snapshot exposes `project.project_id` and `project.root` but no
// human-friendly name. Derive a short label from the project_id (its last
// path segment) so the header reads something better than the raw uuid-like
// id. Falls back to "climier project" when nothing usable is present.
export function projectDisplayName(snapshot) {
  const project = snapshot && snapshot.project;
  if (!project) return "climier project";
  const id = typeof project.project_id === "string" ? project.project_id.trim() : "";
  if (!id) return "climier project";
  // Path separators only: a single slash or a double underscore separates a
  // path-like project_id ("team/climier-ui" -> "climier-ui"). A bare id
  // such as "ui-redesign" keeps its hyphens/underscores intact — it is
  // already human-readable.
  const parts = id.split(/\/|__/).filter(Boolean);
  if (parts.length > 1) return parts[parts.length - 1];
  return id;
}