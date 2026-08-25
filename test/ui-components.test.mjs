// Contract smoke tests for ui/src/components.jsx.
//
// Why this file exists:
//   - The UI is a subproject with no in-process test runner. The verification
//     for the Fase 2 F2b task is "cd ui && npm run build en verde". Build
//     alone proves "it compiles" but not "the contract is what the views
//     need". These tests pin the contract:
//       * every primitive required by ui/DESIGN.md §4 is exported;
//       * the visual rules from ui/DESIGN.md §3-7 actually apply (controls
//         ≥36 px, pills reserved for badges/chips, focus-visible rings on
//         interactives, no shadow on cards by default);
//       * legacy names (StatCard, Section, Empty, fmtTime, lastActionLabel)
//         keep working so the current views still build until Fase 5
//         migrates them;
//       * KindBadge never renders the umbrella "resolvable" token (that's a
//         CLI schema value, not a dashboard kind);
//       * Time prefers claim.at per the snapshot contract from Fase 1.
//
// We don't pull in jsdom. JSX is transformed on the fly with
// babel-preset-solid (already a transitive dep of vite-plugin-solid) and the
// resulting module is imported through a data: URL so this test stays
// zero-dep at the project level.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// Babel + the solid preset live in the UI subproject's node_modules (the CLI
// itself stays stdlib-only). Resolve them relative to that subproject rather
// than the repo root, so this test never adds a dependency to the CLI.
const UI_DIR = path.resolve("ui");
const UI_REQUIRE = createRequire(path.join(UI_DIR, "package.json"));
const babel = UI_REQUIRE("@babel/core");

const COMPONENTS_FILE = path.join(UI_DIR, "src", "components.jsx");
const UI_DEPS_OK = fs.existsSync(path.join(UI_DIR, "node_modules", "solid-js"))
  && fs.existsSync(path.join(UI_DIR, "node_modules", "@babel", "core"));
const skip = UI_DEPS_OK ? false : "ui dependencies not installed (run npm install in ui/)";

// Primitives required by the Fase 2 F2b contract (task body + ui/DESIGN.md §4).
const REQUIRED_EXPORTS = [
  "PageHeader",
  "PageLayout",
  "Panel",
  "MetricCard",
  "StatusBadge",
  "KindBadge",
  "Chip",
  "FilterBar",
  "AlertBanner",
  "EmptyState",
  "NodeRow",
  "ProgressBar",
  "LiveStatus",
  "Skeleton",
  "IconButton",
  "Time",
  "ClaimTime",
  "kindFor",
];

// Legacy names the current views (ui/src/views/*.jsx) still import.
const LEGACY_EXPORTS = [
  "StatCard",
  "Section",
  "Empty",
  "fmtTime",
  "lastActionLabel",
];

// Transform components.jsx with babel + the solid preset and write the
// result to a tmp file inside ui/src so its relative imports of solid-js/web
// resolve through the UI's node_modules. Returns { module, cleanup } where
// cleanup removes the tmp file. A fresh tmp file per test keeps the module
// cache from serving stale output across iterations.
//
// Each test is responsible for calling cleanup(); we register a t.after()
// at the helper level too as a safety net so a failing assertion doesn't
// leave the file lying around for the next run to trip over.
const tmpFiles = new Set();
async function compileComponents(t) {
  const source = fs.readFileSync(COMPONENTS_FILE, "utf8");
  const out = await babel.transformAsync(source, {
    filename: COMPONENTS_FILE,
    sourceType: "module",
    // Resolve the preset through the same UI-local require so we don't
    // depend on the CLI having @babel/* on its NODE_PATH.
    presets: [[UI_REQUIRE.resolve("babel-preset-solid"), { generate: "ssr", hydratable: false }]],
  });
  // Drop the file inside ui/src so node module resolution finds
  // ui/node_modules for the relative `import "solid-js/web"`.
  const dir = path.join(UI_DIR, "src");
  const file = path.join(dir, `.components.compiled.${process.pid}.${Date.now()}.mjs`);
  fs.writeFileSync(file, out.code, "utf8");
  tmpFiles.add(file);
  const cleanup = () => {
    tmpFiles.delete(file);
    return fs.promises.unlink(file).catch(() => {});
  };
  if (t && typeof t.after === "function") t.after(cleanup);
  const module = await import(pathToFileURL(file).href);
  return { module, cleanup };
}

// Best-effort cleanup at process exit so a crashed test run doesn't pollute
// the working tree with .components.compiled.*.mjs files.
process.on("exit", () => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch {}
  }
});

test("components.jsx exists and exports every required primitive", { skip }, async (t) => {
  assert.ok(fs.existsSync(COMPONENTS_FILE), `${COMPONENTS_FILE} must exist`);
  const { module: mod } = await compileComponents(t);
  for (const name of REQUIRED_EXPORTS) {
    assert.equal(typeof mod[name], "function", `expected ${name} to be exported as a function`);
  }
});

test("PageLayout provides the shared standard and workspace frames", { skip }, async (t) => {
  const { module: mod } = await compileComponents(t);
  const { renderToString } = await UI_REQUIRE("solid-js/web");

  const standard = renderToString(() => mod.PageLayout({ children: "content" }));
  assert.ok(standard.includes("ui-page-layout-standard"));
  assert.ok(!standard.includes("ui-page-layout-workspace"));

  const workspace = renderToString(() => mod.PageLayout({ mode: "workspace", children: "canvas" }));
  assert.ok(workspace.includes("ui-page-layout-workspace"));
  assert.ok(workspace.includes("canvas"));
});

test("components.jsx keeps legacy exports for current views", { skip }, async (t) => {
  const { module: mod } = await compileComponents(t);
  for (const name of LEGACY_EXPORTS) {
    assert.equal(typeof mod[name], "function", `legacy export ${name} must remain a function`);
  }
});

test("kindFor collapses 'resolvable' to 'task' and never returns 'resolvable'", { skip }, async (t) => {
  const { module: mod } = await compileComponents(t);
  // kindFor is exported as a function but not a component. It must collapse
  // the CLI's umbrella `resolvable` kind into a real kind the dashboard
  // understands.
  assert.equal(typeof mod.kindFor, "function");
  assert.equal(mod.kindFor({ kind: "resolvable" }), "task");
  assert.equal(mod.kindFor({ kind: "resolvable", subkind: "gate" }), "gate");
  assert.equal(mod.kindFor({ kind: "knowledge" }), "knowledge");
  assert.equal(mod.kindFor({ kind: "task" }), "task");
  assert.equal(mod.kindFor(undefined), "task");
  assert.equal(mod.kindFor(null), "task");
});

test("fmtTime returns sane relative labels", { skip }, async (t) => {
  const { module: mod } = await compileComponents(t);
  const now = Date.now();
  assert.equal(mod.fmtTime(new Date(now - 5_000).toISOString()), "just now");
  assert.match(mod.fmtTime(new Date(now - 5 * 60_000).toISOString()), /^[0-9]+m ago$/);
  assert.match(mod.fmtTime(new Date(now - 2 * 3_600_000).toISOString()), /^[0-9]+h ago$/);
  assert.equal(mod.fmtTime(null), "");
  assert.equal(mod.fmtTime(""), "");
  assert.equal(mod.fmtTime("not-a-date"), "");
});

test("lastActionLabel maps known actions to human labels", { skip }, async (t) => {
  const { module: mod } = await compileComponents(t);
  assert.equal(mod.lastActionLabel("add-node"), "created");
  assert.equal(mod.lastActionLabel("take"), "claimed");
  assert.equal(mod.lastActionLabel("resolve"), "resolved");
  assert.equal(mod.lastActionLabel("release"), "released");
  assert.equal(mod.lastActionLabel("reopen"), "reopened");
  assert.equal(mod.lastActionLabel("cancel"), "canceled");
  assert.equal(mod.lastActionLabel("update"), "updated");
  assert.equal(mod.lastActionLabel("add-note"), "note");
  assert.equal(mod.lastActionLabel("unknown-action"), "unknown-action");
});

test("KindBadge never renders 'resolvable' even when the node has kind='resolvable'", { skip }, async (t) => {
  const { module: mod } = await compileComponents(t);
  const { renderToString } = await UI_REQUIRE("solid-js/web");
  // Task with umbrella kind: must show 'task', not 'resolvable'.
  const html1 = renderToString(() => mod.KindBadge({ node: { kind: "resolvable" } }));
  assert.ok(html1.includes("task"), `KindBadge({kind:'resolvable'}) should render 'task': ${html1}`);
  assert.ok(!html1.includes("resolvable"), `KindBadge must never render 'resolvable': ${html1}`);

  // Gate: subkind gate.
  const html2 = renderToString(() => mod.KindBadge({ node: { kind: "resolvable", subkind: "gate" } }));
  assert.ok(html2.includes("gate"), `KindBadge({subkind:'gate'}) should render 'gate': ${html2}`);

  // Knowledge: kind=knowledge wins over subkind.
  const html3 = renderToString(() => mod.KindBadge({ node: { kind: "knowledge" } }));
  assert.ok(html3.includes("knowledge"), `KindBadge({kind:'knowledge'}) should render 'knowledge': ${html3}`);
});

test("MetricCard renders <button> only when onClick is provided", { skip }, async (t) => {
  const { module: mod } = await compileComponents(t);
  const { renderToString } = await UI_REQUIRE("solid-js/web");

  const divHtml = renderToString(() =>
    mod.MetricCard({ value: 7, label: "Ready", explanation: "tasks no agent claims yet" })
  );
  assert.ok(!divHtml.includes("<button"), "MetricCard without onClick must not render a <button>");
  assert.ok(divHtml.includes("Ready"));
  assert.ok(divHtml.includes("7"));

  const btnHtml = renderToString(() =>
    mod.MetricCard({ value: 7, label: "Ready", onClick: () => {} })
  );
  assert.ok(btnHtml.includes("<button"), "MetricCard with onClick must render a <button>");
  assert.ok(btnHtml.includes('aria-label="Ready"'), "clickable MetricCard must expose an accessible name");
});

test("Controls and cards comply with the visual contract", { skip }, async (t) => {
  const { module: mod } = await compileComponents(t);
  const { renderToString } = await UI_REQUIRE("solid-js/web");

  // IconButton: must be square (not pill), must have min 36 px hit area,
  // must surface the label via aria-label and title.
  const icon = renderToString(() => mod.IconButton({ label: "Close", onClick: () => {} }, "<span>×</span>"));
  assert.ok(icon.includes("h-9"), `IconButton md size must hit the 36 px floor (h-9): ${icon}`);
  assert.ok(icon.includes("w-9"), `IconButton md size must be square (w-9): ${icon}`);
  assert.ok(icon.includes("rounded-control"), `IconButton must use control radius, not pill: ${icon}`);
  assert.ok(!icon.includes("rounded-full"), `IconButton must never be a pill: ${icon}`);
  assert.ok(icon.includes('aria-label="Close"'), "IconButton must expose its label to assistive tech");
  assert.ok(icon.includes('title="Close"'), "IconButton must expose its label as a tooltip");

  // Panel: cards are radius 12, no shadow by default; drawer/popovers opt in.
  const panel = renderToString(() => mod.Panel({ title: "Tasks" }, "<div>body</div>"));
  assert.ok(panel.includes("rounded-card"), `Panel must use card radius: ${panel}`);
  assert.ok(!panel.includes("shadow"), `Panel without elevated must not have a shadow: ${panel}`);

  const drawer = renderToString(() => mod.Panel({ title: "Drawer", elevated: true }, "<div>body</div>"));
  assert.ok(drawer.includes("shadow-md"), `Panel elevated must add a shadow: ${drawer}`);

  // FilterBar: must reach the 36 px control floor.
  const fb = renderToString(() => mod.FilterBar({ label: "Filters" }, "<button>x</button>"));
  assert.ok(fb.includes("min-h-[36px]"), `FilterBar must enforce the 36 px control floor: ${fb}`);

  // FilterBar: Clear filters button appears only when onClear is provided.
  const noClear = renderToString(() => mod.FilterBar({ label: "Filters" }, "<button>x</button>"));
  assert.ok(!noClear.includes("Clear filters"), `FilterBar without onClear must not show Clear filters: ${noClear}`);
  const withClear = renderToString(() =>
    mod.FilterBar({ label: "Filters", onClear: () => {} }, "<button>x</button>")
  );
  assert.ok(withClear.includes("Clear filters"), `FilterBar with onClear must show Clear filters: ${withClear}`);

  // NodeRow: must reach the 36 px floor when interactive.
  const row = renderToString(() =>
    mod.NodeRow({ node: { id: "T-1", title: "Build", status: "ready" }, onClick: () => {} })
  );
  assert.ok(row.includes("min-h-[36px]"), `NodeRow clickable must hit the 36 px floor: ${row}`);
  assert.ok(row.includes("cursor-pointer"), `NodeRow clickable must advertise cursor:pointer: ${row}`);
  assert.ok(row.includes("focus-visible"), `NodeRow clickable must carry the focus-visible ring class: ${row}`);
});

test("Pill shape is reserved for badges and chips (not buttons or cards)", { skip }, async (t) => {
  const { module: mod } = await compileComponents(t);
  const { renderToString } = await UI_REQUIRE("solid-js/web");

  // Pills are allowed on StatusBadge, KindBadge (rectangle here, not pill),
  // and Chip.
  const badge = renderToString(() => mod.StatusBadge({ status: "ready" }));
  assert.ok(badge.includes("rounded-full"), `StatusBadge is a pill: ${badge}`);

  const chip = renderToString(() => mod.Chip({ children: "ui" }));
  assert.ok(chip.includes("rounded-full"), `Chip is a pill: ${chip}`);

  // KindBadge must NOT be a pill (DESIGN.md §6: pill = status, square = kind).
  const kind = renderToString(() => mod.KindBadge({ node: { kind: "task" } }));
  assert.ok(!kind.includes("rounded-full"), `KindBadge must not be a pill: ${kind}`);
  assert.ok(kind.includes("rounded-[6px]"), `KindBadge must use the small square shape: ${kind}`);

  // FilterBar Clear filters button is a control, not a pill.
  const fb = renderToString(() =>
    mod.FilterBar({ onClear: () => {} }, "<button>x</button>")
  );
  // The clear button has `rounded-control`, never `rounded-full`.
  const clearSegment = fb.match(/Clear filters[\s\S]*?<\/button>/);
  assert.ok(clearSegment, "Clear filters button must be present");
  assert.ok(!clearSegment[0].includes("rounded-full"), `Filter clear button must not be a pill: ${clearSegment[0]}`);
});

test("EmptyState variants render the right shape for each context", { skip }, async (t) => {
  const { module: mod } = await compileComponents(t);
  const { renderToString } = await UI_REQUIRE("solid-js/web");

  const page = renderToString(() =>
    mod.EmptyState({ variant: "page", title: "Nothing yet", hint: "create the first task" })
  );
  assert.ok(page.includes("Nothing yet"));
  assert.ok(page.includes("create the first task"));

  const section = renderToString(() => mod.EmptyState({ title: "Empty" }));
  assert.ok(section.includes("border-dashed"), `section EmptyState uses a dashed border: ${section}`);

  const compact = renderToString(() => mod.EmptyState({ variant: "compact", title: "all healthy" }));
  assert.ok(!compact.includes("border"), `compact EmptyState is a single muted line: ${compact}`);
  assert.ok(compact.includes("all healthy"));
});

test("Time prefers claim.at over claim.ts (claim snapshot contract)", { skip }, async (t) => {
  const { module: mod } = await compileComponents(t);
  const { renderToString } = await UI_REQUIRE("solid-js/web");

  const at = "2025-01-01T00:00:00.000Z";
  const ts = "2020-01-01T00:00:00.000Z"; // intentionally far in the past

  const htmlAt = renderToString(() => mod.ClaimTime({ claim: { by: "alice", at } }));
  const htmlTs = renderToString(() => mod.ClaimTime({ claim: { by: "alice", ts } }));

  // Both render a Time span with a non-empty `title` attribute carrying the
  // absolute timestamp (formatted via Intl). The at-only claim must NOT pick
  // up the stale ts timestamp — its tooltip text differs from the ts-only
  // tooltip because they describe different years.
  assert.match(htmlAt, /title="[^"]+"/, `ClaimTime must surface the timestamp in a tooltip: ${htmlAt}`);
  assert.match(htmlTs, /title="[^"]+"/, `ClaimTime must surface the fallback timestamp: ${htmlTs}`);
  // Different dates produce different tooltips; if the contract were broken
  // and both branches used claim.ts or both used claim.at, the tooltips
  // would be identical.
  const titleAt = htmlAt.match(/title="([^"]+)"/)[1];
  const titleTs = htmlTs.match(/title="([^"]+)"/)[1];
  assert.notEqual(titleAt, titleTs, `claim.at and claim.ts must render different absolute tooltips (at=${titleAt}, ts=${titleTs})`);
  // The at claim's tooltip year must be 2024 or 2025; the ts claim's year
  // must be 2019 or 2020 (UTC vs local). This catches a swapped-by-accident
  // regression where both fall back to the same field.
  assert.match(titleAt, /\b(2024|2025)\b/, `claim.at tooltip must include the at year: ${titleAt}`);
  assert.match(titleTs, /\b(2019|2020)\b/, `claim.ts tooltip must include the ts year: ${titleTs}`);
});

test("Skeleton renders the requested rows × lines and is hidden from assistive tech", { skip }, async (t) => {
  const { module: mod } = await compileComponents(t);
  const { renderToString } = await UI_REQUIRE("solid-js/web");

  const html = renderToString(() => mod.Skeleton({ rows: 2, lines: 3 }));
  assert.ok(html.includes('aria-hidden="true"'), `Skeleton must be hidden from screen readers: ${html}`);
  // 2 rows × 3 lines = 6 line bars.
  const bars = html.match(/rounded-full bg-panel-2/g) || [];
  assert.ok(bars.length >= 6, `Skeleton must render one bar per line (rows × lines): got ${bars.length}`);
});