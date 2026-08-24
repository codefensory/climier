// Contract tests for ui/src/shell.mjs — the responsive shell helper used by
// ui/src/App.jsx (Phase 3 / F3c, docs/ui-redesign-plan.md sections 4-layout
// and 6-Fase 3 + "Estados de datos").
//
// Why this file exists:
//   - The shell helper holds the breakpoint math, sidebar geometry, and
//     project-name derivation that the rest of the shell relies on. Locking
//     them down with pure-function tests means a typo in a width threshold
//     or a missing rail glyph fails in CI instead of rendering a broken
//     layout in the browser.
//   - The shell helper is consumed by App.jsx (JSX) which we cannot import
//     in a Node test environment without a transform pipeline; testing the
//     helper directly is the lowest-cost way to pin the contract.
//
// The acceptance criteria for T-ui-shell-layout include "Shell funciona a
// 1440, 1024 y 390 px" and "Indicador de refresh visible durante polling".
// Both are testable here: classifyWidth pins the bucket boundaries,
// sidebarWidthPx + sidebarShowsLabels pin the visual result.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  BREAKPOINT,
  BREAKPOINT_THRESHOLDS,
  classifyWidth,
  SIDEBAR_WIDTH_PX,
  sidebarWidthPx,
  sidebarShowsLabels,
  sidebarShowsGroupHeaders,
  drawerAvailable,
  RAIL_GLYPH,
  railGlyph,
  projectDisplayName,
} from "../ui/src/shell.mjs";

import { ROUTE_META, NAV_GROUPS } from "../ui/src/routes.mjs";

const UI_DIR = path.resolve("ui");
const SHELL_FILE = path.join(UI_DIR, "src", "shell.mjs");

// === File presence + exports ===============================================

test("shell.mjs exists and exports the expected helpers", () => {
  assert.ok(fs.existsSync(SHELL_FILE), `${SHELL_FILE} must exist`);
  assert.equal(typeof classifyWidth, "function");
  assert.equal(typeof sidebarWidthPx, "function");
  assert.equal(typeof sidebarShowsLabels, "function");
  assert.equal(typeof sidebarShowsGroupHeaders, "function");
  assert.equal(typeof drawerAvailable, "function");
  assert.equal(typeof railGlyph, "function");
  assert.equal(typeof projectDisplayName, "function");
  assert.ok(BREAKPOINT && typeof BREAKPOINT === "object");
  assert.ok(BREAKPOINT_THRESHOLDS && typeof BREAKPOINT_THRESHOLDS === "object");
  assert.ok(SIDEBAR_WIDTH_PX && typeof SIDEBAR_WIDTH_PX === "object");
  assert.ok(RAIL_GLYPH && typeof RAIL_GLYPH === "object");
});

// === Breakpoint boundaries ==================================================
// Acceptance: shell works at 1440, 1024, and 390 px. 1440 is WIDE, 1024 is
// MID, 390 is NARROW. The threshold tests also pin the off-by-one behaviour
// at the bucket boundaries (DESIGN.md §3.1: 768 / 1280 cutoffs).

test("classifyWidth: 1440 -> WIDE (acceptance check)", () => {
  assert.equal(classifyWidth(1440), BREAKPOINT.WIDE);
});

test("classifyWidth: 1280 -> WIDE (boundary inclusive at the lower end)", () => {
  // 1280 is the wide threshold per DESIGN.md. The bucket goes from
  // 1280 (inclusive) upward.
  assert.equal(classifyWidth(1280), BREAKPOINT.WIDE);
});

test("classifyWidth: 1279 -> MID (boundary exclusive at the upper end)", () => {
  // The mid bucket runs up to but not including 1280.
  assert.equal(classifyWidth(1279), BREAKPOINT.MID);
});

test("classifyWidth: 1024 -> MID (acceptance check)", () => {
  assert.equal(classifyWidth(1024), BREAKPOINT.MID);
});

test("classifyWidth: 768 -> MID (boundary inclusive at the lower end)", () => {
  assert.equal(classifyWidth(768), BREAKPOINT.MID);
});

test("classifyWidth: 767 -> NARROW (boundary exclusive at the upper end)", () => {
  assert.equal(classifyWidth(767), BREAKPOINT.NARROW);
});

test("classifyWidth: 390 -> NARROW (acceptance check)", () => {
  assert.equal(classifyWidth(390), BREAKPOINT.NARROW);
});

test("classifyWidth: non-numeric / undefined falls back to WIDE", () => {
  // SSR / test environments without window.innerWidth get WIDE so the
  // shell doesn't silently collapse to a drawer during boot.
  for (const input of [undefined, null, NaN, "1024", {}, []]) {
    assert.equal(classifyWidth(input), BREAKPOINT.WIDE, `input ${JSON.stringify(input)} -> WIDE`);
  }
});

// === Sidebar geometry ======================================================

test("sidebarWidthPx matches the design contract per breakpoint", () => {
  assert.equal(sidebarWidthPx(BREAKPOINT.WIDE), 240, "Wide sidebar is 240 px");
  assert.equal(sidebarWidthPx(BREAKPOINT.MID), 72, "Mid rail is 72 px (upper bound of 64–72 px)");
  assert.equal(sidebarWidthPx(BREAKPOINT.NARROW), 0, "Narrow has no permanent sidebar");
  assert.equal(SIDEBAR_WIDTH_PX.wide, 240);
  assert.equal(SIDEBAR_WIDTH_PX.mid, 72);
  assert.equal(SIDEBAR_WIDTH_PX.narrow, 0);
});

test("sidebarWidthPx: unknown breakpoints default to the wide width", () => {
  assert.equal(sidebarWidthPx("unknown"), 240);
});

test("sidebarShowsLabels is true only on WIDE", () => {
  assert.equal(sidebarShowsLabels(BREAKPOINT.WIDE), true);
  assert.equal(sidebarShowsLabels(BREAKPOINT.MID), false);
  assert.equal(sidebarShowsLabels(BREAKPOINT.NARROW), false);
});

test("sidebarShowsGroupHeaders is true only on WIDE", () => {
  assert.equal(sidebarShowsGroupHeaders(BREAKPOINT.WIDE), true);
  assert.equal(sidebarShowsGroupHeaders(BREAKPOINT.MID), false);
  assert.equal(sidebarShowsGroupHeaders(BREAKPOINT.NARROW), false);
});

test("drawerAvailable is true only on NARROW", () => {
  assert.equal(drawerAvailable(BREAKPOINT.NARROW), true);
  assert.equal(drawerAvailable(BREAKPOINT.MID), false);
  assert.equal(drawerAvailable(BREAKPOINT.WIDE), false);
});

// === Rail glyph map ========================================================

test("RAIL_GLYPH covers every route id from routes.mjs", () => {
  // The rail is consumed by App.jsx; missing glyphs would render as
  // empty squares, which is the kind of silent bug the test catches.
  for (const id of Object.keys(ROUTE_META)) {
    assert.ok(RAIL_GLYPH[id], `RAIL_GLYPH.${id} must exist`);
    assert.equal(typeof RAIL_GLYPH[id], "string");
    assert.ok(RAIL_GLYPH[id].length > 0 && RAIL_GLYPH[id].length <= 2,
      `RAIL_GLYPH.${id} must be 1-2 chars (got '${RAIL_GLYPH[id]}')`);
  }
});

test("railGlyph returns the mapped glyph and a sane fallback for unknown ids", () => {
  for (const id of Object.keys(ROUTE_META)) {
    assert.equal(railGlyph(id), RAIL_GLYPH[id]);
  }
  // Fallback: first two characters upper-cased.
  assert.equal(railGlyph("not-a-route"), "NO");
  assert.equal(railGlyph("x"), "X");
});

// === projectDisplayName ===================================================

test("projectDisplayName derives a friendly label from project_id", () => {
  // Bare ids fall through unchanged — they are already human-readable.
  assert.equal(projectDisplayName({ project: { project_id: "climier" } }), "climier");
  assert.equal(projectDisplayName({ project: { project_id: "ui-redesign" } }), "ui-redesign");
  // Path-like ids collapse to the last segment so a long project_id like
  // "team/climier-ui" doesn't blow out the header.
  assert.equal(projectDisplayName({ project: { project_id: "team/climier-ui" } }), "climier-ui");
  assert.equal(projectDisplayName({ project: { project_id: "team__climier-ui" } }), "climier-ui");
  assert.equal(projectDisplayName({ project: { project_id: "team/climier ui" } }), "climier ui");
  // Empty / missing / malformed input falls back to a generic label.
  assert.equal(projectDisplayName({ project: { project_id: "" } }), "climier project");
  assert.equal(projectDisplayName({ project: {} }), "climier project");
  assert.equal(projectDisplayName(null), "climier project");
  assert.equal(projectDisplayName(undefined), "climier project");
});

// === App.jsx consumes shell.mjs ============================================
// The breakpoint math must come from shell.mjs; App.jsx is the consumer.
// We grep the source so a regression that duplicates the math (and
// therefore drifts from the contract) fails this test.

const APP_FILE = path.join(UI_DIR, "src", "App.jsx");

test("App.jsx imports from ./shell.mjs (no duplicate breakpoint math)", () => {
  const source = fs.readFileSync(APP_FILE, "utf8");
  assert.match(source, /from\s+["']\.\/shell\.mjs["']/,
    "App.jsx must import helpers from ./shell.mjs to avoid drifting breakpoints");
});

test("App.jsx uses classifyWidth / sidebarWidthPx in its layout", () => {
  const source = fs.readFileSync(APP_FILE, "utf8");
  assert.match(source, /classifyWidth/, "App.jsx must call classifyWidth");
  // The component must reach the helper, not re-implement the threshold
  // with raw `window.innerWidth` comparisons.
  assert.doesNotMatch(source, /innerWidth\s*<\s*1280/,
    "App.jsx must not hardcode breakpoint thresholds");
});

// === Nav group / route coupling ============================================
// The sidebar shows NAV_GROUPS in the order routes.mjs declares. The shell
// helper test is the right place to remind future refactors that any new
// route id added to ROUTE_META must add a RAIL_GLYPH entry, otherwise the
// rail will fall back to a two-character slice.

test("NAV_GROUPS ids and ROUTE_META ids stay in sync (existing route test)", () => {
  const grouped = new Set();
  for (const g of NAV_GROUPS) for (const id of g.ids) grouped.add(id);
  for (const id of Object.keys(ROUTE_META)) {
    assert.ok(grouped.has(id), `ROUTE_META.${id} must appear in NAV_GROUPS`);
  }
});