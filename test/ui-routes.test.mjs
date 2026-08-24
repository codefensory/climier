// Contract tests for ui/src/routes.mjs.
//
// Why this file exists:
//   - routes.mjs is the pure source of truth for the shell's routing:
//     route ids, labels, group assignment, and hash parsing. The JSX side
//     of the shell (ui/src/App.jsx) glues those metadata entries to the
//     view components. Locking down the metadata here means a typo or
//     a forgotten group in App.jsx fails fast in CI instead of silently
//     dropping a view from the sidebar.
//   - The acceptance criteria for T-ui-shell-routes include "back/forward
//     changes view, refresh preserves the route" and "unknown route does
//     not fall through to Activity". Both contracts live in parseHashRoute:
//     refresh preservation (default + id parsing) and unknown-route
//     detection (`unknown: true` instead of a silent fallback to Activity).
//
// The test file is .mjs, not .jsx, and routes.mjs imports only from
// solid-js-free sources, so it can be imported directly without a JSX
// loader. The component mapping is App.jsx's concern, not routes.mjs's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

import {
  ROUTE_META,
  DEFAULT_ROUTE,
  NAV_GROUPS,
  parseHashRoute,
  writeHashRoute,
} from "../ui/src/routes.mjs";

const UI_DIR = path.resolve("ui");
const ROUTES_FILE = path.join(UI_DIR, "src", "routes.mjs");
const APP_FILE = path.join(UI_DIR, "src", "App.jsx");

// === Registry completeness ==================================================

test("routes.mjs exists and exports the expected helpers", () => {
  assert.ok(fs.existsSync(ROUTES_FILE), `${ROUTES_FILE} must exist`);
  assert.equal(typeof ROUTE_META, "object");
  assert.equal(typeof DEFAULT_ROUTE, "string");
  assert.ok(Array.isArray(NAV_GROUPS));
  assert.equal(typeof parseHashRoute, "function");
  assert.equal(typeof writeHashRoute, "function");
});

test("ROUTE_META covers the seven required views", () => {
  const required = ["overview", "board", "graph", "tasks", "gates", "knowledge", "activity"];
  for (const id of required) {
    assert.ok(ROUTE_META[id], `ROUTE_META.${id} must exist`);
    assert.equal(typeof ROUTE_META[id].label, "string", `${id} needs a label`);
    assert.ok(ROUTE_META[id].label.length > 0, `${id} label must be non-empty`);
    assert.equal(typeof ROUTE_META[id].group, "string", `${id} needs a group`);
    assert.ok(ROUTE_META[id].group.length > 0, `${id} group must be non-empty`);
  }
});

test("Activity is not the default route (the pre-Phase-3 bug)", () => {
  // Acceptance: "Ruta desconocida no cae en Activity". The DEFAULT_ROUTE
  // must therefore be Overview, and parseHashRoute must fall back to it
  // (not Activity) for unknown inputs.
  assert.equal(DEFAULT_ROUTE, "overview", "DEFAULT_ROUTE must be overview");
  assert.notEqual(DEFAULT_ROUTE, "activity");
});

test("NAV_GROUPS order and composition match the plan", () => {
  // The plan (docs/ui-redesign-plan.md section 6) names exactly these
  // four groups in this order.
  const labels = NAV_GROUPS.map((g) => g.label);
  assert.deepEqual(labels, ["Monitor", "Work", "Context", "Audit"]);

  // Monitor must hold Overview/Board/Graph (no Activity fallback target).
  const monitor = NAV_GROUPS.find((g) => g.label === "Monitor");
  assert.deepEqual(monitor.ids, ["overview", "board", "graph"]);

  // Work must hold Tasks/Gates.
  const work = NAV_GROUPS.find((g) => g.label === "Work");
  assert.deepEqual(work.ids, ["tasks", "gates"]);

  // Context must hold Knowledge.
  const context = NAV_GROUPS.find((g) => g.label === "Context");
  assert.deepEqual(context.ids, ["knowledge"]);

  // Audit must hold only Activity.
  const audit = NAV_GROUPS.find((g) => g.label === "Audit");
  assert.deepEqual(audit.ids, ["activity"]);
});

test("every id in NAV_GROUPS exists in ROUTE_META and is unique", () => {
  const seen = new Set();
  for (const group of NAV_GROUPS) {
    for (const id of group.ids) {
      assert.ok(ROUTE_META[id], `NAV_GROUPS references unknown id: ${id}`);
      assert.ok(!seen.has(id), `duplicate route id in NAV_GROUPS: ${id}`);
      seen.add(id);
      assert.equal(ROUTE_META[id].group, group.label,
        `ROUTE_META.${id}.group (${ROUTE_META[id].group}) must match NAV_GROUPS bucket (${group.label})`);
    }
  }
});

test("every ROUTE_META id appears in exactly one NAV_GROUPS bucket", () => {
  const grouped = new Set();
  for (const g of NAV_GROUPS) for (const id of g.ids) grouped.add(id);
  for (const id of Object.keys(ROUTE_META)) {
    assert.ok(grouped.has(id), `ROUTE_META.${id} is not in any NAV_GROUPS bucket`);
  }
});

// === parseHashRoute contract ===============================================

test("parseHashRoute returns the default for empty / null / undefined", () => {
  for (const input of [undefined, null, "", "#", "#/", "#/?", "#?x=1"]) {
    const parsed = parseHashRoute(input);
    assert.equal(parsed.id, DEFAULT_ROUTE, `input ${JSON.stringify(input)} -> default`);
    assert.equal(parsed.unknown, false, `input ${JSON.stringify(input)} must not be unknown`);
    assert.equal(parsed.raw, "", `input ${JSON.stringify(input)} -> raw ""`);
  }
});

test("parseHashRoute accepts #/id, #id, and #/id?query / #/id#frag", () => {
  for (const input of ["#/tasks", "#tasks", "#/tasks?x=1", "#/tasks#section", "#/tasks?initiative=ui"]) {
    const parsed = parseHashRoute(input);
    assert.equal(parsed.id, "tasks", `input ${JSON.stringify(input)} -> tasks`);
    assert.equal(parsed.unknown, false, `input ${JSON.stringify(input)} must not be unknown`);
    assert.equal(parsed.raw, "tasks");
  }
});

test("parseHashRoute flags unknown routes without falling through to Activity", () => {
  // The acceptance: "Ruta desconocida no cae en Activity". An unknown id
  // must land on the DEFAULT_ROUTE (overview) and report unknown=true so
  // the shell can show a banner. It must NEVER report activity.
  for (const input of ["#/foo", "#/nope", "#/activity-but-typo", "#/Overview", "#/TASKS"]) {
    const parsed = parseHashRoute(input);
    assert.notEqual(parsed.id, "activity", `unknown input ${input} must not resolve to activity`);
    assert.equal(parsed.id, DEFAULT_ROUTE, `unknown input ${input} must fall back to default`);
    assert.equal(parsed.unknown, true, `unknown input ${input} must be flagged`);
    assert.ok(parsed.raw.length > 0, `unknown input ${input} must expose the raw id`);
  }
});

test("parseHashRoute is case-sensitive (registry keys are lowercase)", () => {
  // If we accepted mixed case, "Overview" would silently fall back instead
  // of being flagged as unknown. The shell uses the registry as the
  // source of truth and ids are lowercase; case mismatches are user typos.
  const parsed = parseHashRoute("#/Tasks");
  assert.equal(parsed.id, DEFAULT_ROUTE);
  assert.equal(parsed.unknown, true);
});

// === writeHashRoute guard ==================================================

test("writeHashRoute is a no-op in the Node test environment", () => {
  // The function must guard against environments without `window`. Calling
  // it in a test must not throw, and must not touch any global.
  assert.doesNotThrow(() => writeHashRoute("tasks"));
  assert.doesNotThrow(() => writeHashRoute("not-a-route"));
});

// === App.jsx wiring =========================================================

test("App.jsx wires every ROUTE_META id to a view component", () => {
  // The registry in App.jsx must cover every metadata id; otherwise the
  // sidebar would show a nav button for an id that renders nothing.
  // We can't compile JSX here, so we check the source statically: the
  // file must contain a `ROUTE_COMPONENTS` map with every id as a key.
  const source = fs.readFileSync(APP_FILE, "utf8");
  const block = source.match(/const\s+ROUTE_COMPONENTS\s*=\s*\{([\s\S]*?)\}/);
  assert.ok(block, "App.jsx must declare ROUTE_COMPONENTS");
  for (const id of Object.keys(ROUTE_META)) {
    assert.match(block[1], new RegExp(`\\b${id}\\s*:`),
      `ROUTE_COMPONENTS in App.jsx must map ${id} to a view`);
  }
});
