// ui/src/routes.mjs
//
// Pure routing metadata + hash helpers shared by the shell (ui/src/App.jsx)
// and the test suite (test/ui-routes.test.mjs). No JSX, no DOM, no side
// effects — the only function that touches `window` is `writeHashRoute`,
// and it guards against the SSR / Node test environment.
//
// Why a separate file: keeping the registry and the parser out of App.jsx
// lets the test suite exercise the contract (registry completeness, hash
// parsing edge cases) without needing a JSX loader. App.jsx is the
// consumer; this file is the source of truth.
//
// The component mapping (id -> JSX component) lives in App.jsx because the
// view files are themselves JSX. This file is the *metadata* layer: it
// says which ids exist, which group they belong to, and how to parse the
// hash. App.jsx glues the metadata to the view components.

// === Route metadata ========================================================
// Each entry: label (sidebar text) + group (sidebar bucket). The component
// is attached by App.jsx from the same id.
export const ROUTE_META = {
  overview:  { label: "Overview",  group: "Monitor" },
  board:     { label: "Board",     group: "Monitor" },
  tasks:     { label: "Tasks",     group: "Work" },
  gates:     { label: "Gates",     group: "Work" },
  knowledge: { label: "Knowledge", group: "Context" },
  activity:  { label: "Activity",  group: "Audit" },
};

export const DEFAULT_ROUTE = "overview";

// Group order = sidebar order. Activity sits in "Audit" and is never the
// fallback target — unknown routes land on Overview.
export const NAV_GROUPS = [
  { label: "Monitor", ids: ["overview", "board"] },
  { label: "Work",    ids: ["tasks", "gates"] },
  { label: "Context", ids: ["knowledge"] },
  { label: "Audit",   ids: ["activity"] },
];

// === Hash helpers ==========================================================
// Pure: parse a raw hash (with or without leading "#" or "#/", with optional
// "?query" or "#fragment" suffix) into a known route id. Returns
// `{ id, unknown, raw }` so the caller can render a fallback banner instead
// of silently routing to Activity.
export function parseHashRoute(rawHash) {
  if (rawHash == null || rawHash === "") {
    return { id: DEFAULT_ROUTE, unknown: false, raw: "" };
  }
  // Strip the leading hash marker: one or more "#" plus an optional "/".
  // We deliberately do NOT consume "?" here — a hash like "#?x=1" is a
  // query string with no route id and must resolve to the default.
  let s = String(rawHash).replace(/^#+\/?/, "");
  // After stripping, if the next char is "?" (or the string is empty),
  // the hash carried no route id. Fall back to the default.
  if (s === "" || s.startsWith("?")) {
    return { id: DEFAULT_ROUTE, unknown: false, raw: "" };
  }
  // Split off any "?query" or "#fragment" suffix so "#/tasks?x=1" and
  // "#/tasks#section" both resolve to "tasks".
  s = s.split(/[?#]/)[0].trim();
  if (!s) return { id: DEFAULT_ROUTE, unknown: false, raw: "" };
  if (ROUTE_META[s]) return { id: s, unknown: false, raw: s };
  return { id: DEFAULT_ROUTE, unknown: true, raw: s };
}

// Write a route id to the URL hash using pushState. We avoid
// `location.hash = …` because that scrolls the page to the top on every
// navigation. pushState with a new URL of the same path+hash creates a
// history entry (back/forward works) without the scroll jump. No-op when
// the hash already matches. Guarded so it can be imported in tests.
export function writeHashRoute(id) {
  if (typeof window === "undefined" || typeof window.history === "undefined") return;
  if (!ROUTE_META[id]) id = DEFAULT_ROUTE;
  const target = "#/" + id;
  if (window.location.hash === target) return;
  const url = new URL(window.location.href);
  url.hash = target;
  window.history.pushState(null, "", url);
}
