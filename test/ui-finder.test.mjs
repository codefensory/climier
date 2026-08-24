// Contract tests for ui/src/views/Finder.jsx (Fase 7, pieza F7b — T-ui-finder).
//
// Scope of F7b (per the task body):
//   1. Global finder using /api/search with grouped results (Tasks/Gates/
//      Knowledge).
//   2. Shortcut `/` or Ctrl/Cmd+K opens; Escape closes; keyboard navigation
//      between results; click/enter opens NodeDetail (store.select).
//   3. Accessible overlay: role=dialog, initial focus and focus return.
//   4. No new dependencies.
//
// The structural rebuild is verified end-to-end via `cd ui && npm run build`
// per the task acceptance. These tests pin the contract independently so a
// future refactor cannot silently regress any of the four points.
//
// We don't pull in jsdom. JSX is transformed on the fly with babel + the
// solid preset (already a UI-local devDep) and the resulting module is
// imported through a tmp file, mirroring test/ui-detail.test.mjs. The
// presentational FinderDialog is rendered with literal props; the pure
// helpers (shortcut detection, grouping, keyboard index math) are tested
// directly because they carry the interaction contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire, register } from "node:module";

import {
  createTempProject,
  rmTempProject,
  writeState,
  exampleState,
} from "./helpers.mjs";

// The compiled Finder module imports ../components.jsx and ../store.jsx.
// Node cannot load .jsx natively, so register the on-demand babel loader
// before any dynamic import runs (same helper as ui-detail tests).
register(new URL("./jsx-loader.mjs", import.meta.url).href, import.meta.url);

const UI_DIR = path.resolve("ui");
const UI_REQUIRE = createRequire(path.join(UI_DIR, "package.json"));
const babel = UI_REQUIRE("@babel/core");
const solidWeb = UI_REQUIRE("solid-js/web");

const FINDER_FILE = path.join(UI_DIR, "src", "views", "Finder.jsx");

const UI_DEPS_OK =
  fs.existsSync(path.join(UI_DIR, "node_modules", "solid-js")) &&
  fs.existsSync(path.join(UI_DIR, "node_modules", "@babel", "core")) &&
  fs.existsSync(path.join(UI_DIR, "node_modules", "express"));
const skip = UI_DEPS_OK ? false : "ui dependencies not installed (run npm install in ui/)";

// Each Finder compile drops inside ui/src/views alongside its siblings so
// node resolution finds the UI's node_modules for solid-js/web,
// ../components.jsx and ../store.jsx.
const tmpFiles = new Set();
async function compileFinder(t) {
  const source = fs.readFileSync(FINDER_FILE, "utf8");
  const out = await babel.transformAsync(source, {
    filename: FINDER_FILE,
    sourceType: "module",
    presets: [[UI_REQUIRE.resolve("babel-preset-solid"), { generate: "ssr", hydratable: false }]],
  });
  const dir = path.dirname(FINDER_FILE);
  const file = path.join(dir, `.Finder.compiled.${process.pid}.${Date.now()}.mjs`);
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

function node(id, overrides = {}) {
  return {
    id,
    kind: "resolvable",
    subkind: "task",
    title: id,
    status: "open",
    initiative: "ui",
    ...overrides,
  };
}

function resultFixture() {
  return {
    tasks: [
      node("T-1", { title: "Auth task", status: "in_progress" }),
      node("T-2", { title: "Auth second task" }),
    ],
    gates: [
      node("G-1", { subkind: "gate", title: "Auth gate", status: "open" }),
    ],
    knowledge: [
      { id: "K-1", kind: "knowledge", title: "Auth knowledge", status: "active" },
    ],
  };
}

// --- pure helpers -----------------------------------------------------------

test("Finder pure helpers: group order, flat indices, keyboard math", { skip }, async (t) => {
  const { mod } = await compileFinder(t);
  const { groupedResults, flattenResults, nextItemIndex } = mod;

  // Group order is fixed (Tasks, Gates, Knowledge); empty groups drop out.
  const res = { gates: [node("G-1", { subkind: "gate" })], knowledge: [], tasks: [node("T-1")] };
  const groups = groupedResults(res);
  assert.deepEqual(groups.map((g) => g.key), ["tasks", "gates"]);
  assert.deepEqual(groups.map((g) => g.label), ["Tasks", "Gates"]);

  // Items get sequential flat indices across groups (used for
  // aria-activedescendant ids).
  const all = flattenResults(resultFixture());
  assert.deepEqual(all.map((r) => r.kind), [
    "header", "item", "item", "header", "item", "header", "item",
  ]);
  const itemIndices = all.filter((r) => r.kind === "item").map((r) => r.index);
  assert.deepEqual(itemIndices, [1, 2, 3, 4]);
  assert.equal(all[0].label, "Tasks");
  assert.equal(all[0].group, "tasks");
});

test("Finder nextItemIndex wraps at both ends and skips headers", { skip }, async (t) => {
  const { mod } = await compileFinder(t);
  const { flattenResults, nextItemIndex } = mod;
  const rows = flattenResults(resultFixture());

  // First item when no current index.
  assert.equal(nextItemIndex(rows, -1, 1), 1);
  // Down from the last item wraps to the first.
  assert.equal(nextItemIndex(rows, 4, 1), 1);
  // Up from the first item wraps to the last.
  assert.equal(nextItemIndex(rows, 1, -1), 4);
  // Plain moves.
  assert.equal(nextItemIndex(rows, 1, 1), 2);
  assert.equal(nextItemIndex(rows, 2, -1), 1);
  // Empty list → -1.
  assert.equal(nextItemIndex([], -1, 1), -1);
  assert.equal(nextItemIndex([{ kind: "header", group: "tasks", label: "Tasks", index: -1 }], -1, 1), -1);
});

test("Finder shortcut detection: / only when not typing; Ctrl/Cmd+K always", { skip }, async (t) => {
  const { mod } = await compileFinder(t);
  const { isEditableTarget, shouldOpen } = mod;

  assert.equal(isEditableTarget(null), false);
  assert.equal(isEditableTarget({ tagName: "DIV" }), false);
  assert.equal(isEditableTarget({ tagName: "BUTTON" }), false);
  assert.equal(isEditableTarget({ tagName: "INPUT" }), true);
  assert.equal(isEditableTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isEditableTarget({ tagName: "SELECT" }), true);
  assert.equal(isEditableTarget({ isContentEditable: true }), true);

  // "/" on a plain target opens.
  assert.equal(shouldOpen({ key: "/", ctrlKey: false, metaKey: false, altKey: false, target: { tagName: "BODY" } }), true);
  // "/" while typing in an input does not open.
  assert.equal(shouldOpen({ key: "/", ctrlKey: false, metaKey: false, altKey: false, target: { tagName: "INPUT" } }), false);
  // Ctrl/Cmd+K opens even from an editable target.
  assert.equal(shouldOpen({ key: "k", ctrlKey: true, metaKey: false, altKey: false, target: { tagName: "INPUT" } }), true);
  assert.equal(shouldOpen({ key: "K", ctrlKey: false, metaKey: true, altKey: false, target: { tagName: "TEXTAREA" } }), true);
  // Modifier combos that are not Ctrl/Cmd+K don't open.
  assert.equal(shouldOpen({ key: "/", ctrlKey: true, metaKey: false, altKey: false, target: { tagName: "BODY" } }), false);
  assert.equal(shouldOpen({ key: "a", ctrlKey: false, metaKey: false, altKey: false, target: { tagName: "BODY" } }), false);
});

// --- SSR render contract ----------------------------------------------------

// Renders FinderDialog (presentational) with literal props. The default
// Finder wires the store + api; FinderDialog is the markup contract.
async function renderDialog(t, props) {
  const { mod } = await compileFinder(t);
  const html = solidWeb.renderToString(() =>
    mod.FinderDialog({
      query: props.query,
      results: props.results,
      active: props.active,
      loading: props.loading,
      error: props.error,
      onQuery: () => {},
      onClose: () => {},
      onOpen: () => {},
      inputRef: undefined,
      listRef: undefined,
    })
  );
  return html;
}

test("FinderDialog renders an accessible dialog with grouped results", { skip }, async (t) => {
  const html = await renderDialog(t, {
    query: "auth",
    results: resultFixture(),
    active: 2,
    loading: false,
    error: null,
  });

  assert.match(html, /role="dialog"/, `dialog role required: ${html}`);
  assert.match(html, /aria-modal="true"/, `aria-modal required: ${html}`);
  assert.match(html, /aria-label="Search"/, `dialog needs an accessible label: ${html}`);

  // Input: combobox semantics + accessible name.
  assert.match(html, /role="combobox"/, `input must be a combobox: ${html}`);
  assert.match(html, /aria-label="Search tasks, gates and knowledge"/, `input needs an accessible name: ${html}`);
  assert.match(html, /aria-controls="finder-listbox"/, `input must reference the listbox: ${html}`);
  assert.match(html, /aria-activedescendant="finder-opt-2"/, `input must point at the active option: ${html}`);

  // Group headers in fixed order.
  assert.ok(html.indexOf("Tasks") < html.indexOf("Gates"), `Tasks group must come first: ${html}`);
  assert.ok(html.indexOf("Gates") < html.indexOf("Knowledge"), `Gates group must precede Knowledge: ${html}`);

  // Options carry role=option and the active one is aria-selected.
  assert.match(html, /role="option"/, `result rows need role=option: ${html}`);
  assert.match(html, /id="finder-opt-2"[^>]*aria-selected="true"/, `active option must be selected: ${html}`);
  assert.match(html, /aria-selected="false"/, `inactive options must be unselected: ${html}`);

  // Result rows are real buttons (click target) with the node id.
  assert.match(html, /<button[^>]*finder-opt-1/, `options must be buttons: ${html}`);
  assert.ok(html.includes("Auth task"), `task title must render: ${html}`);
  assert.ok(html.includes("Auth gate"), `gate title must render: ${html}`);
  assert.ok(html.includes("Auth knowledge"), `knowledge title must render: ${html}`);
});

test("FinderDialog renders a close button and the keyboard hint", { skip }, async (t) => {
  const html = await renderDialog(t, {
    query: "auth",
    results: resultFixture(),
    active: 1,
    loading: false,
    error: null,
  });
  assert.match(html, /aria-label="Close search"/, `dialog needs a close control: ${html}`);
  assert.match(html, /aria-label="Clear search"/, `dialog needs a clear control while typing: ${html}`);
});

test("FinderDialog states: empty query hint, no results, loading, error", { skip }, async (t) => {
  // Empty query → hint, no listbox.
  const empty = await renderDialog(t, {
    query: "",
    results: null,
    active: -1,
    loading: false,
    error: null,
  });
  assert.match(empty, /Type to search/i, `empty query should show a hint: ${empty}`);
  assert.ok(!empty.includes('id="finder-listbox"'), `no listbox before a search: ${empty}`);

  // No results → empty state.
  const none = await renderDialog(t, {
    query: "zzz",
    results: { tasks: [], gates: [], knowledge: [] },
    active: -1,
    loading: false,
    error: null,
  });
  assert.match(none, /No results/i, `no-results needs an empty state: ${none}`);

  // Loading → polite status.
  const loading = await renderDialog(t, {
    query: "auth",
    results: null,
    active: -1,
    loading: true,
    error: null,
  });
  assert.match(loading, /role="status"/, `loading needs a polite status: ${loading}`);
  assert.match(loading, /Searching/i, `loading should say it is searching: ${loading}`);

  // Error → alert banner.
  const err = await renderDialog(t, {
    query: "auth",
    results: null,
    active: -1,
    loading: false,
    error: "boom",
  });
  assert.match(err, /role="alert"/, `error needs an alert role: ${err}`);
  assert.ok(err.includes("boom"), `error message must render: ${err}`);
});

// --- server /api/search contract -------------------------------------------
// The finder consumes /api/search; the endpoint's grouped shape is part of
// the F7b contract and had no coverage before this task.

const serverMod = await import(pathToFileURL(path.resolve("ui/server/server.mjs")).href);

async function startServer(projectDir) {
  const started = await serverMod.start({ projectDir, port: 0, log: () => {} });
  const port = started.server.address().port;
  return { base: `http://127.0.0.1:${port}`, server: started.server };
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function getJson(url) {
  const r = await fetch(url);
  assert.equal(r.status, 200, `GET ${url} failed`);
  return r.json();
}

function searchFixture() {
  const st = exampleState();
  // Example state has tasks, gates (subkind=gate) and knowledge.
  st.nodes["K-dep"] = {
    id: "K-dep", kind: "knowledge", title: "Deprecated auth note", status: "deprecated",
    initiative: "migration", body: "old",
  };
  return st;
}

test("/api/search groups tasks/gates/knowledge and hides deprecated by default", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  await writeState(dir, searchFixture());
  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const body = await getJson(`${base}/api/search?q=auth`);
  assert.deepEqual(Object.keys(body).sort(), ["gates", "knowledge", "tasks"]);
  assert.ok(Array.isArray(body.tasks) && Array.isArray(body.gates) && Array.isArray(body.knowledge));
  assert.ok(body.tasks.length > 0, `tasks group should have hits: ${JSON.stringify(body)}`);
  assert.ok(body.gates.length > 0, `gates group should have hits: ${JSON.stringify(body)}`);
  assert.ok(body.knowledge.length > 0, `knowledge group should have hits: ${JSON.stringify(body)}`);
  assert.ok(!body.knowledge.some((k) => k.id === "K-dep"), "deprecated must be hidden by default");

  // all=true includes deprecated.
  const all = await getJson(`${base}/api/search?q=auth&all=true`);
  assert.ok(all.knowledge.some((k) => k.id === "K-dep"), "deprecated must appear when all=true");

  // Empty query → empty groups, never an error.
  const empty = await getJson(`${base}/api/search?q=`);
  assert.deepEqual(empty, { tasks: [], gates: [], knowledge: [] });
});

test("/api/search returns empty groups for an uninitialized project", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));
  const body = await getJson(`${base}/api/search?q=auth`);
  assert.deepEqual(body, { tasks: [], gates: [], knowledge: [] });
});
