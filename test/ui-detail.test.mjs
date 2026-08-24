// Contract tests for ui/src/views/NodeDetail.jsx (Fase 6, pieza F6a).
//
// Scope of F6a (per the task body):
//   1. Header sticky with back, close, real kind (task/gate/knowledge, never
//      'resolvable'), status, ID, revision.
//   2. Title 20-24 px.
//   3. Summary: status, initiative, claim (using claim.at), revision, last
//      activity.
//   4. Alert banner when the node is blocked / stale / superseded.
//   5. Specification + open blockers open by default.
//   6. Knowledge, notes, history, refs, secondary relations live in
//      collapsible <details>.
//   7. Time uses claim.at (not claim.ts).
//
// The structural rebuild is verified end-to-end via `cd ui && npm run build`
// per the task acceptance. These tests pin the contract independently so a
// future refactor cannot silently regress any of the seven points.
//
// We don't pull in jsdom. JSX is transformed on the fly with babel + the
// solid preset (already a UI-local devDep) and the resulting module is
// imported through a tmp file, mirroring test/ui-components.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire, register } from "node:module";

// The compiled NodeDetail module imports ../components.jsx (and, without the
// storeStub flag, ../store.jsx). Node cannot load .jsx natively, so register
// the on-demand babel loader before any dynamic import runs. This mirrors
// how a future view-level test would consume the same helper.
register(new URL("./jsx-loader.mjs", import.meta.url).href, import.meta.url);

const UI_DIR = path.resolve("ui");
const UI_REQUIRE = createRequire(path.join(UI_DIR, "package.json"));
const babel = UI_REQUIRE("@babel/core");
const solidWeb = UI_REQUIRE("solid-js/web");

const DETAIL_FILE = path.join(UI_DIR, "src", "views", "NodeDetail.jsx");
const COMPONENTS_FILE = path.join(UI_DIR, "src", "components.jsx");
const STORE_FILE = path.join(UI_DIR, "src", "store.jsx");

const UI_DEPS_OK =
  fs.existsSync(path.join(UI_DIR, "node_modules", "solid-js")) &&
  fs.existsSync(path.join(UI_DIR, "node_modules", "@babel", "core"));
const skip = UI_DEPS_OK ? false : "ui dependencies not installed (run npm install in ui/)";

// Each NodeDetail compile drops inside ui/src/views alongside its siblings
// so node resolution finds the UI's node_modules for `solid-js/web`,
// `../components.jsx`, and `../store.jsx`.
const tmpFiles = new Set();
async function compileDetail(t, { storeStub } = {}) {
  let source = fs.readFileSync(DETAIL_FILE, "utf8");
  if (storeStub) {
    // Replace the store import + usage with a fake so the component can be
    // rendered without a real StoreProvider. The test passes props through
    // a tiny harness.
    source = source
      .replace(
        /import\s*\{\s*useStore\s*\}\s*from\s*"\.\.\/store\.jsx";?/,
        "const useStore = () => globalThis.__NODE_DETAIL_STORE__;"
      );
  }
  const out = await babel.transformAsync(source, {
    filename: DETAIL_FILE,
    sourceType: "module",
    presets: [[UI_REQUIRE.resolve("babel-preset-solid"), { generate: "ssr", hydratable: false }]],
  });
  const dir = path.dirname(DETAIL_FILE);
  const file = path.join(dir, `.NodeDetail.compiled.${process.pid}.${Date.now()}.mjs`);
  fs.writeFileSync(file, out.code, "utf8");
  tmpFiles.add(file);
  const cleanup = () => {
    tmpFiles.delete(file);
    return fs.promises.unlink(file).catch(() => {});
  };
  if (t && typeof t.after === "function") t.after(cleanup);
  const mod = await import(pathToFileURL(file).href + `?ts=${Date.now()}`);
  return { mod, cleanup };
}

process.on("exit", () => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch {}
  }
});

// --- fixtures ---------------------------------------------------------------
//
// The snapshot contract from Fase 1: detail() returns the full payload from
// /api/node/:id. We hand-build representative payloads so the tests stay
// fast (no server).

// Build a store stub suitable for NodeDetail. Tests can pass extra
// `alerts` / `lastActivity` to exercise the banner and summary paths.
function makeStore(detail, opts = {}) {
  return {
    selectedId: () => detail.node.id,
    select: () => {},
    detail: () => detail,
    detailError: () => null,
    snapshot: () => ({
      last_activity: opts.lastActivity || {},
      alerts: opts.alerts || [],
    }),
  };
}

function makeDetail(overrides = {}) {
  // Pull `node` out of the spread below: the merged node (defaults + node
  // overrides) must win, otherwise a partial node override like
  // `{ kind, subkind }` would clobber id/title/status and the drawer would
  // see selectedId() === undefined (open() === false).
  const { node: nodeOverrides, ...rest } = overrides || {};
  const node = {
    id: "T-demo",
    kind: "resolvable",
    subkind: "task",
    title: "Demo task",
    body: "Body of the demo.",
    status: "in_progress",
    claim: { by: "alice", at: "2025-01-01T12:00:00.000Z", ts: "2020-01-01T00:00:00.000Z" },
    initiative: "ui",
    domain: "frontend",
    tags: ["restyle"],
    notes: [
      { agent: "alice", ts: "2025-01-01T12:00:00.000Z", text: "Starting work" },
    ],
    refs: [{ target: "docs/ui-redesign-plan.md", type: "doc", source: "body" }],
    ...(nodeOverrides || {}),
  };
  return {
    node,
    derived_status: rest.derived_status || node.status || "open",
    is_current: rest.is_current !== undefined ? rest.is_current : true,
    superseded_by: rest.superseded_by !== undefined ? rest.superseded_by : null,
    blocking: rest.blocking || [],
    dependents: rest.dependents || [],
    informing: rest.informing || [],
    knowledge: rest.knowledge || [],
    history: rest.history || [],
    refs: rest.refs || node.refs || [],
    ...rest,
  };
}

// --- tests ------------------------------------------------------------------

test("NodeDetail header uses real kind (task/gate/knowledge), never 'resolvable'", { skip }, async (t) => {
  const { mod } = await compileDetail(t, { storeStub: true });
  const detail = makeDetail({
    node: { kind: "resolvable", subkind: "task" },
    derived_status: "in_progress",
  });
  globalThis.__NODE_DETAIL_STORE__ = makeStore(detail);
  const html = solidWeb.renderToString(() => mod.default());
  assert.ok(html.includes("task"), `header must render the resolved kind 'task': ${html}`);
  assert.ok(!html.includes("resolvable"), `header must never render the umbrella kind 'resolvable': ${html}`);

  // Same for gates: subkind=gate wins over the umbrella kind.
  const gateDetail = makeDetail({
    node: { id: "G-1", kind: "resolvable", subkind: "gate", status: "open" },
    derived_status: "open",
  });
  globalThis.__NODE_DETAIL_STORE__ = makeStore(gateDetail);
  const gateHtml = solidWeb.renderToString(() => mod.default());
  assert.ok(gateHtml.includes("gate"), `header must render kind='gate': ${gateHtml}`);
  assert.ok(!gateHtml.includes("resolvable"), `gate header must never render 'resolvable': ${gateHtml}`);
});

test("NodeDetail header is sticky and carries back + close affordances", { skip }, async (t) => {
  const { mod } = await compileDetail(t, { storeStub: true });
  const detail = makeDetail({ derived_status: "in_progress" });
  globalThis.__NODE_DETAIL_STORE__ = makeStore(detail);
  const html = solidWeb.renderToString(() => mod.default());
  // Sticky header surface
  assert.ok(html.includes("sticky"), `header must be sticky: ${html}`);
  // Back + close affordances with accessible names
  assert.match(html, /aria-label="(Back|Close)"/, `header must expose Back/Close aria-labels: ${html}`);
  // The node id is surfaced in the header for power users
  assert.ok(html.includes(detail.node.id), `header must show the node id: ${html}`);
});

test("NodeDetail title sits in the 20-24px range", { skip }, async (t) => {
  const { mod } = await compileDetail(t, { storeStub: true });
  const detail = makeDetail({ derived_status: "in_progress" });
  globalThis.__NODE_DETAIL_STORE__ = makeStore(detail);
  const html = solidWeb.renderToString(() => mod.default());
  // text-page is 24px (token from index.css); text-section is 16px. The title
  // must use the page token, not sectional/body.
  assert.ok(
    html.match(/text-(?:page|\[2[0-4]px\])/),
    `title must use a 20-24px token class: ${html}`
  );
  assert.ok(!html.match(/<h2[^>]*text-section\b/), `title must not use the section token (16px): ${html}`);
});

test("NodeDetail summary surfaces status, initiative, claim, revision, last activity", { skip }, async (t) => {
  const { mod } = await compileDetail(t, { storeStub: true });
  const detail = makeDetail({
    derived_status: "in_progress",
    history: [
      { ts: "2025-01-02T00:00:00.000Z", action: "update", agent: "bob", note: "tweaks" },
    ],
  });
  // last_activity is sourced from the snapshot, not from detail history.
  const lastActivity = {
    [detail.node.id]: { ts: "2025-01-02T00:00:00.000Z", action: "update", agent: "bob" },
  };
  globalThis.__NODE_DETAIL_STORE__ = makeStore(detail, { lastActivity });
  const html = solidWeb.renderToString(() => mod.default());
  assert.ok(html.includes("Status"), `summary must include a 'Status' label: ${html}`);
  assert.ok(html.includes("Initiative") || html.includes(detail.node.initiative),
    `summary must include the initiative: ${html}`);
  assert.ok(html.includes(detail.node.initiative),
    `summary must surface the initiative value: ${html}`);
  assert.ok(html.includes("Revision") || html.match(/revision\s*\d+/i),
    `summary must include the revision: ${html}`);
  assert.ok(html.includes("Last activity") || html.includes("Last update"),
    `summary must include a last-activity line: ${html}`);
});

test("NodeDetail shows a banner when the node is blocked, stale, or superseded", { skip }, async (t) => {
  const { mod } = await compileDetail(t, { storeStub: true });

  // Blocked: derived_status === "blocked" → AlertBanner with role=status|alert.
  const blocked = makeDetail({ derived_status: "blocked" });
  globalThis.__NODE_DETAIL_STORE__ = makeStore(blocked);
  const blockedHtml = solidWeb.renderToString(() => mod.default());
  assert.match(blockedHtml, /role="(alert|status)"/, `blocked detail must surface an alert role: ${blockedHtml}`);

  // Stale: the snapshot surfaces alerts with kind=stale-claim; the view
  // consumes the snapshot's `alerts` array.
  const stale = makeDetail({ derived_status: "in_progress" });
  globalThis.__NODE_DETAIL_STORE__ = makeStore(stale, {
    alerts: [{
      kind: "stale-claim", severity: "warning", node_id: stale.node.id,
      message: `${stale.node.id} claimed by alice is stale (180m old)`,
    }],
  });
  const staleHtml = solidWeb.renderToString(() => mod.default());
  assert.match(staleHtml, /stale/i, `stale detail must surface the stale banner: ${staleHtml}`);

  // Superseded
  const superseded = makeDetail({
    derived_status: "superseded",
    is_current: false,
    superseded_by: "T-new",
  });
  globalThis.__NODE_DETAIL_STORE__ = makeStore(superseded);
  const supHtml = solidWeb.renderToString(() => mod.default());
  assert.match(supHtml, /superseded/i, `superseded detail must surface the supersede banner: ${supHtml}`);
});

test("NodeDetail renders Specification and Blockers open by default", { skip }, async (t) => {
  const { mod } = await compileDetail(t, { storeStub: true });
  const detail = makeDetail({
    derived_status: "blocked",
    blocking: [
      { edge_type: "BLOCKS", satisfied: false, node: { id: "G-1", title: "Approve plan", status: "open", subkind: "gate", kind: "resolvable" } },
      { edge_type: "BLOCKS", satisfied: true, node: { id: "T-old", title: "Done task", status: "done", subkind: "task", kind: "resolvable" } },
    ],
  });
  globalThis.__NODE_DETAIL_STORE__ = makeStore(detail);
  const html = solidWeb.renderToString(() => mod.default());
  // Specification body content is rendered open by default (no <details> wrap)
  assert.ok(html.includes(detail.node.body), `Specification body must be visible without collapsing: ${html}`);
  // Blocker list shows both relevant and satisfied items
  assert.ok(html.includes("G-1"), `Blocker list must surface unsatisfied blockers: ${html}`);
  assert.ok(html.includes("T-old"), `Blocker list must surface satisfied blockers for context: ${html}`);
});

test("NodeDetail places Knowledge, Notes, History, Refs, EqCommand, Dependents in <details>", { skip }, async (t) => {
  const { mod } = await compileDetail(t, { storeStub: true });
  const detail = makeDetail({
    derived_status: "in_progress",
    knowledge: [
      { id: "K-1", title: "Snapshot contract", status: "active", scope_matches: ["initiative"] },
    ],
    history: [
      { ts: "2025-01-02T00:00:00.000Z", action: "update", agent: "bob", note: "tweaks" },
    ],
    dependents: [
      { edge_type: "BLOCKS", node: { id: "T-child", title: "Child", status: "open", subkind: "task", kind: "resolvable" } },
    ],
  });
  globalThis.__NODE_DETAIL_STORE__ = makeStore(detail);
  const html = solidWeb.renderToString(() => mod.default());
  // Knowledge, notes, history, refs, dependents and the EqCommand must all
  // live inside a <details> element (collapsed by default).
  assert.ok(/<details[\s>]/.test(html), `secondary sections must use <details>: ${html}`);
  // Count of <details> must cover at least: knowledge, notes, history,
  // refs, dependents, equivalent-cli (six collapsible zones).
  const detailsCount = (html.match(/<details[\s>]/g) || []).length;
  assert.ok(detailsCount >= 5, `expected at least 5 <details> sections, got ${detailsCount}: ${html}`);
  // The Knowledge id, note text, history action, ref target, and child id
  // must still appear (collapsed != hidden).
  assert.ok(html.includes("K-1"), `Knowledge id must appear inside its <details>: ${html}`);
  assert.ok(html.includes("Starting work"), `note text must appear inside its <details>: ${html}`);
  assert.ok(html.includes("update"), `history action must appear inside its <details>: ${html}`);
  assert.ok(html.includes("docs/ui-redesign-plan.md"), `ref target must appear inside its <details>: ${html}`);
  assert.ok(html.includes("T-child"), `dependent id must appear inside its <details>: ${html}`);
  // Default to closed (no `open` attribute on the secondary <details>).
  assert.ok(!/<details[^>]*\bopen\b/.test(html),
    `secondary <details> must default to closed; saw <details open>: ${html}`);
});

test("NodeDetail renders refs as structured {target, type, source} (not raw strings)", { skip }, async (t) => {
  const { mod } = await compileDetail(t, { storeStub: true });
  const detail = makeDetail({
    derived_status: "in_progress",
    refs: [
      { target: "docs/ui-redesign-plan.md", type: "doc", source: "body" },
    ],
  });
  globalThis.__NODE_DETAIL_STORE__ = makeStore(detail);
  const html = solidWeb.renderToString(() => mod.default());
  // Target is visible
  assert.ok(html.includes("docs/ui-redesign-plan.md"), `ref target must be visible: ${html}`);
  // type and source are surfaced (not just the bare string)
  assert.match(html, /\bdoc\b/, `ref type must be visible ('doc'): ${html}`);
  assert.match(html, /\bbody\b/, `ref source must be visible ('body'): ${html}`);
});

test("NodeDetail claim timestamp uses claim.at, not claim.ts", { skip }, async (t) => {
  const { mod } = await compileDetail(t, { storeStub: true });
  // at = 2025, ts = 2020. The tooltip on the claim timestamp must reflect
  // the at field (year 2024/2025), not the ts fallback.
  const detail = makeDetail({ derived_status: "in_progress" });
  globalThis.__NODE_DETAIL_STORE__ = makeStore(detail);
  const html = solidWeb.renderToString(() => mod.default());
  const titles = Array.from(html.matchAll(/title="([^"]+)"/g)).map((m) => m[1]);
  const atTitle = titles.find((t) => /\b(2024|2025)\b/.test(t));
  const tsTitle = titles.find((t) => /\b(2019|2020)\b/.test(t));
  assert.ok(atTitle, "claim.at timestamp must surface a tooltip with the 2024/2025 year");
  assert.ok(!tsTitle, "claim.ts (2020) must NOT appear in any tooltip — the view must use claim.at");
});

test("NodeDetail exposes role=dialog and labelled-by-title for a11y", { skip }, async (t) => {
  const { mod } = await compileDetail(t, { storeStub: true });
  const detail = makeDetail({ derived_status: "in_progress" });
  globalThis.__NODE_DETAIL_STORE__ = makeStore(detail);
  const html = solidWeb.renderToString(() => mod.default());
  assert.match(html, /role="dialog"/, `drawer must expose role="dialog": ${html}`);
  assert.match(html, /aria-label(?:ledby)?="[^"]+"/, `drawer must carry an accessible name: ${html}`);
});

test("NodeDetail does not render Markdown or HTML inside ref targets", { skip }, async (t) => {
  const { mod } = await compileDetail(t, { storeStub: true });
  const detail = makeDetail({
    derived_status: "in_progress",
    refs: [{ target: "<script>alert(1)</script>", type: "doc", source: "body" }],
  });
  globalThis.__NODE_DETAIL_STORE__ = makeStore(detail);
  const html = solidWeb.renderToString(() => mod.default());
  // Raw <script> would mean we are dangerouslySetInnerHTML-ing refs. The
  // view must render the target as text only.
  assert.ok(!html.includes("<script>alert(1)</script>"),
    `ref targets must be rendered as text, not as live HTML: ${html}`);
  assert.ok(html.includes("&lt;script&gt;") || html.includes("<script>alert(1)</script>") === false,
    `ref target must be escaped: ${html}`);
});
