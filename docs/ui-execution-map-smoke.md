# Execution Map — manual smoke (T-ui-graph-integration)

This document is the **manual smoke** reference for the integrated
Execution Map. Spec lives in
[RFC Graph 2.0](../.decisions/G-ui-graph-2-rfc.md) and
[ADR-001](../.adrs/001-graph-view-model.md),
[ADR-002](../.adrs/002-graph-layout-and-performance.md),
[ADR-003](../.adrs/003-graph-node-and-accessibility.md).
This file lists what a human must observe before declaring the
integration closed; it complements the automated build, benchmark and
`test/ui-*.test.mjs` suites.

## Pre-flight

- `cd ui && npm install` once if `node_modules` is missing.
- `node bin/climier.mjs --project <dir> init` on a throwaway project.
  Seed a few initiatives, a couple of gates, some knowledge and a
  mixture of `BLOCKS` / `SUPERSEDES` / `DERIVED_FROM` edges so all three
  modes and the cross-initiative bridges are exercised.
- `cd ui && npm run dev:api` and `cd ui && npm run dev` (or `npm run build`
  + `npm run preview`) — open the Graph view at a desktop viewport
  (≥ 1024 px).

## Automated gates (must pass before smoke)

| Check | Command | Budget |
|---|---|---|
| Build | `cd ui && npm run build` | 0 errors |
| Benchmark | `cd ui && npm run benchmark:graph` | `execution_pure` p95 ≤ 5 ms · `cytoscape_preset_headless` p95 ≤ 82 ms · `non_topological_poll` reports `relayout_required=false` |
| Tests | `npm test` | 0 failures |
| Dagre absent | `grep -R "cytoscape-dagre" ui/src ui/scripts ui/package.json` | empty |
| Tokens resolved | browser console — `getComputedStyle(document.documentElement).getPropertyValue("--ui-blue")` | returns `#1769e0` (browser-only path) |

## Flow Execution / History / All

1. **Execution (default):** only operational tasks and gates with
   open / in-progress status are visible; closed nodes are dropped.
   Knowledge nodes appear only when incident to an operational node
   via `BLOCKS`.
2. **History:** only endpoints of `SUPERSEDES` / `DERIVED_FROM`
   chains and those edges.
3. **All:** every node and every edge in the snapshot.
   - Keyboard: `←` / `→` / `Home` / `End` cycle the segmented
     control; `aria-pressed` toggles; focus ring visible.

## Lanes (rank × initiative)

1. Lanes appear as hairline bands; each band carries a small label in
   the top-left corner reading the initiative name.
2. `(none)` lane is hidden visually (still computed, but chrome off)
   per ADR-002.
3. Nodes with multiple incoming `BLOCKS` cycle safely: they share a
   rank and the edge back to the cycle is preserved (visible as a
   backedges).

## Focus

1. Select a blocked task/gate in Execution → the `Upstream` focus
   button lights automatically (`focus: { kind: "upstream", id }`).
2. Click a related node inside `NodeDetail`'s focus panel — focus
   moves with the selection (auto-upstream recomputes for the new
   id; the panel hides for non-seed selections).
3. `Upstream`, `Downstream`, `Initiative` segmented buttons are
   mutually exclusive; clicking the active one clears the focus.
4. `NodeDetail` shows the focus panel only when its `focus.id`
   matches the open node.

## NodeDetail integration

1. Right rail defaults to the Properties tab.
2. Activity tab content stays in the DOM (hidden when inactive) so
   screen-reader virtual content and SSR snapshots always carry
   recent history — switching tabs is instant.
3. Back / Close / Escape behave per Fase 6b; navigating inside the
   drawer records history; Back returns without closing while there
   is history.
4. The Graph focus panel only appears between hero and Specification
   when the focus applies to the open node; empty states fall back to
   `EmptyState variant="compact"`.

## Finder (offscreen nodes)

1. Press `/` (or `Ctrl/Cmd+K`) anywhere — Finder opens over the page.
2. Pick a node that is **not** in the current mode → Graph surfaces
   the `Node no visible en este modo` banner with a one-click
   `Switch to <mode>` action that switches the segmented control
   and centers the node without zooming.
3. Pick a node that **is** in the current mode and materially
   off-screen → Graph animates the camera to center it; in-viewport
   selections do not move the camera.

## Tiers (semantic zoom)

| Zoom | Visible content |
|---|---|
| `< 0.65` | overview — glyph/marker only, no legible text |
| `0.65 – < 1.15` | compact — id, abbreviated title, kind · status |
| `≥ 1.15` | detail — full card with initiative |

1. Hysteresis of 0.05 prevents flicker when the wheel oscillates near
   a frontier; tier recompute fires on zoom/Fit/Reset/resize only.
2. The label content tracks the tier without rebuilding cytoscape
   elements.

## Narrow viewport fallback

1. Resize the window below 768 px → canvas disappears; Finder +
   `NodeDetail` are the only paths to inspect a node.
2. Resize back above 768 px → canvas returns to the previous mode
   and zoom (state is preserved by the store; cytoscape resizes via
   its built-in `resize()` handler).

## Polling (non-topological)

1. Leave the view open for one minute (poll = 2 s).
2. Trigger a `climier update <id> --title "new" --as orchestrator`
   on a visible node.
3. Confirm:
   - the title text updates in the canvas card without a relayout
     flash;
   - `cytoscape` nodes/edges are not removed/re-added (devtools →
     cytoscape events panel);
   - benchmark report (see automated gates) confirms
     `relayout_required=false` for the equivalent fixture scenario.

## Acceptance summary

The integration is closed when all boxes above pass and the
automated gates are green. Any new defect must ship with a
reproduction test and the smallest possible change in
`ui/src/views/Graph.jsx` or `ui/src/views/NodeDetail.jsx`. Tests,
store, helpers, Finder, server, api and package files stay frozen.
