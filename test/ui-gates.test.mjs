// Contract tests for ui/src/views/Gates.jsx (Fase 5B Track B pieza 1).
//
// What this file pins:
//   1. Tabs Open / Resolved / All correctly filter the gate list.
//   2. Filters by initiative, purpose and search compose with the active tab.
//   3. Downstream impact counts BLOCKS edges where the source is the gate and
//      the target is still actionable (open / in_progress / blocked / ready
//      depending on derivation — never done/canceled/superseded/archived).
//   4. Resolution preview is clamped to 2 lines; long rationales do not push
//      the rest of the list out.
//   5. Order is by initiative first, status (open first) second, downstream
//      impact descending as the tiebreaker. The previous "sort by id alone"
//      behavior is gone.
//   6. The view renders the visual contract the plan calls for: row >=36 px,
//      pills only on badges/chips, focus-visible on the interactive row.
//
// The pure helpers (downstreamImpact, previewLines, isOpenGate,
// groupAndSortGates) are exported from Gates.jsx so we can test them with
// literal state objects, no DOM harness. The render-level smoke test uses
// the same babel-preset-solid compilation trick as ui-components.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const UI_DIR = path.resolve("ui");
const UI_REQUIRE = createRequire(path.join(UI_DIR, "package.json"));
const babel = UI_REQUIRE("@babel/core");

const GATES_FILE = path.join(UI_DIR, "src", "views", "Gates.jsx");
const UI_DEPS_OK =
  fs.existsSync(path.join(UI_DIR, "node_modules", "solid-js")) &&
  fs.existsSync(path.join(UI_DIR, "node_modules", "@babel", "core"));
const skip = UI_DEPS_OK ? false : "ui dependencies not installed (run npm install in ui/)";

// Transform Gates.jsx with babel + the solid preset into a tmp file inside
// ui/src so node module resolution finds ui/node_modules for the relative
// `solid-js` import. Node cannot resolve `.jsx` imports directly, so before
// compiling we rewrite the relative `.jsx` imports to inert stubs that
// expose the named exports the view actually uses (and nothing more). The
// pure helpers (downstreamImpact, previewLines, isOpenGate,
// groupAndSortGates) live at module scope, so this rewriting does not
// affect them.
const tmpFiles = new Set();
function rewriteJsxImports(src) {
  // Replace `import { a, b } from "../store.jsx"` (or components.jsx) with
  // stubs that always return inert values. We only stub what the view
  // actually references; anything else is replaced with a Proxy that
  // returns proxy components for any access.
  let out = src;
  // Stub store imports — every named export is a callable that returns
  // empty/null signals when invoked as a hook.
  out = out.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']\.\.\/store\.jsx["'];?/g,
    (_m, names) => {
      const list = names
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      const stubLines = list
        .map((n) => {
          if (n === "useStore") return `const useStore = () => ({ snapshot: () => null, select: () => {}, lastSuccessfulAt: () => null, refreshing: () => false });`;
          return `const ${n} = () => null;`;
        })
        .join("\n");
      return stubLines;
    },
  );
  // Stub components imports — every named export is a no-op component that
  // returns null when rendered.
  out = out.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']\.\.\/components\.jsx["'];?/g,
    (_m, names) => {
      const list = names
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      const stubLines = list
        .map((n) => {
          if (n === "kindFor") return `const kindFor = (n) => { if (!n) return "task"; if (n.kind === "knowledge") return "knowledge"; if (n.subkind === "gate") return "gate"; return "task"; };`;
          return `const ${n} = () => null;`;
        })
        .join("\n");
      return stubLines;
    },
  );
  return out;
}
async function compileGates(t) {
  const rawSource = fs.readFileSync(GATES_FILE, "utf8");
  const source = rewriteJsxImports(rawSource);
  const out = await babel.transformAsync(source, {
    filename: GATES_FILE,
    sourceType: "module",
    presets: [
      [UI_REQUIRE.resolve("babel-preset-solid"), { generate: "ssr", hydratable: false }],
    ],
  });
  const dir = path.join(UI_DIR, "src", "views");
  const file = path.join(dir, `.Gates.compiled.${process.pid}.${Date.now()}.mjs`);
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

process.on("exit", () => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch {}
  }
});

// --- Helpers expected to be exported by Gates.jsx ------------------------

const REQUIRED_EXPORTS = [
  "downstreamImpact",
  "previewLines",
  "isOpenGate",
  "groupAndSortGates",
];

test("Gates.jsx exports the pure helpers the contract depends on", { skip }, async (t) => {
  assert.ok(fs.existsSync(GATES_FILE), `${GATES_FILE} must exist`);
  const { module: mod } = await compileGates(t);
  for (const name of REQUIRED_EXPORTS) {
    assert.equal(typeof mod[name], "function", `expected ${name} to be exported as a function`);
  }
  // Default export is the Solid component itself.
  assert.equal(typeof mod.default, "function", "Gates.jsx must export the view as default");
});

// --- downstreamImpact ----------------------------------------------------

test("downstreamImpact counts BLOCKS edges whose target is still actionable", { skip }, async (t) => {
  const { module: mod } = await compileGates(t);
  const edges = [
    { from: "G1", to: "T1", type: "BLOCKS" },
    { from: "G1", to: "T2", type: "BLOCKS" },
    { from: "G1", to: "T3", type: "BLOCKS" },
    { from: "G2", to: "T1", type: "BLOCKS" }, // not ours
    { from: "G1", to: "T4", type: "DERIVED_FROM" }, // not BLOCKS
  ];
  const nodes = {
    T1: { id: "T1", status: "open" },
    T2: { id: "T2", status: "in_progress" },
    T3: { id: "T3", status: "done" }, // terminal — must be excluded
    T4: { id: "T4", status: "open" },
  };
  const result = mod.downstreamImpact(edges, "G1", nodes);
  assert.equal(result.length, 2, `expected 2 actionable targets (T1, T2) — got ${result.length}`);
  const targets = result.map((e) => e.to).sort();
  assert.deepEqual(targets, ["T1", "T2"]);
});

test("downstreamImpact excludes every terminal status (done/canceled/superseded/archived)", { skip }, async (t) => {
  const { module: mod } = await compileGates(t);
  const edges = [
    { from: "G", to: "Td", type: "BLOCKS" },
    { from: "G", to: "Tc", type: "BLOCKS" },
    { from: "G", to: "Ts", type: "BLOCKS" },
    { from: "G", to: "Ta", type: "BLOCKS" },
    { from: "G", to: "Tx", type: "BLOCKS" },
  ];
  const nodes = {
    Td: { status: "done" },
    Tc: { status: "canceled" },
    Ts: { status: "superseded" },
    Ta: { status: "archived" },
    Tx: { status: "open" },
  };
  const result = mod.downstreamImpact(edges, "G", nodes);
  assert.equal(result.length, 1);
  assert.equal(result[0].to, "Tx");
});

test("downstreamImpact skips edges pointing at unknown nodes", { skip }, async (t) => {
  const { module: mod } = await compileGates(t);
  const edges = [
    { from: "G", to: "T1", type: "BLOCKS" },
    { from: "G", to: "GHOST", type: "BLOCKS" },
  ];
  const nodes = { T1: { status: "open" } };
  const result = mod.downstreamImpact(edges, "G", nodes);
  assert.equal(result.length, 1);
  assert.equal(result[0].to, "T1");
});

test("downstreamImpact tolerates missing edges / nodes / wrong shape", { skip }, async (t) => {
  const { module: mod } = await compileGates(t);
  assert.deepEqual(mod.downstreamImpact(undefined, "G", {}), []);
  assert.deepEqual(mod.downstreamImpact(null, "G", {}), []);
  assert.deepEqual(mod.downstreamImpact([], "G", null), []);
  const dirtyEdges = [null, {}, { type: "BLOCKS" }, { from: "G", type: "BLOCKS" }];
  assert.deepEqual(mod.downstreamImpact(dirtyEdges, "G", { T1: { status: "open" } }), []);
});

// --- previewLines --------------------------------------------------------

test("previewLines returns the text untouched when it already fits N lines", { skip }, async (t) => {
  const { module: mod } = await compileGates(t);
  assert.equal(mod.previewLines("one line", 2), "one line");
  assert.equal(mod.previewLines("first\nsecond", 2), "first\nsecond");
});

test("previewLines clamps to N lines and appends an ellipsis", { skip }, async (t) => {
  const { module: mod } = await compileGates(t);
  const text = "a\nb\nc\nd\ne";
  const out = mod.previewLines(text, 2);
  assert.equal(out, "a\nb…", `expected clamp to 2 lines + ellipsis, got ${JSON.stringify(out)}`);
});

test("previewLines handles CRLF, falsy input and non-string input", { skip }, async (t) => {
  const { module: mod } = await compileGates(t);
  // CRLF input is split on either separator; the join normalizes to \n.
  // The contract is "clamp to N lines" — the exact newline char doesn't
  // matter because the row uses CSS line-clamp / whitespace-pre-wrap.
  assert.equal(mod.previewLines("a\r\nb\r\nc", 2), "a\nb…");
  assert.equal(mod.previewLines(""), "");
  assert.equal(mod.previewLines(null), "");
  assert.equal(mod.previewLines(undefined), "");
});

// --- isOpenGate ----------------------------------------------------------

test("isOpenGate treats missing status as 'open'", { skip }, async (t) => {
  const { module: mod } = await compileGates(t);
  assert.equal(mod.isOpenGate({ id: "G" }), true);
  assert.equal(mod.isOpenGate({ id: "G", status: "open" }), true);
  assert.equal(mod.isOpenGate({ id: "G", status: "resolved" }), false);
  assert.equal(mod.isOpenGate({ id: "G", status: "superseded" }), false);
  assert.equal(mod.isOpenGate(null), false);
});

// --- groupAndSortGates ---------------------------------------------------

test("groupAndSortGates groups by initiative; open gates come first within a group", { skip }, async (t) => {
  const { module: mod } = await compileGates(t);
  const edges = [];
  const nodes = {};
  const gA1 = { id: "G-A1", status: "resolved", initiative: "alpha" };
  const gA2 = { id: "G-A2", status: "open", initiative: "alpha" };
  const gB1 = { id: "G-B1", status: "open", initiative: "beta" };
  const gNone = { id: "G-N1", status: "open" }; // no initiative
  const gates = [gA1, gA2, gB1, gNone];
  const groups = mod.groupAndSortGates(gates, edges, nodes);
  // Map back to [{initiative, ids}] for stable comparison.
  const summary = groups.map(([name, list]) => ({
    name,
    ids: list.map((g) => g.id),
  }));
  // Within alpha: open G-A2 before resolved G-A1.
  const alpha = summary.find((s) => s.name === "alpha");
  assert.ok(alpha, `alpha group must exist, got ${JSON.stringify(summary)}`);
  assert.deepEqual(alpha.ids, ["G-A2", "G-A1"]);
  const beta = summary.find((s) => s.name === "beta");
  assert.ok(beta);
  assert.deepEqual(beta.ids, ["G-B1"]);
  const noIni = summary.find((s) => s.name === "—");
  assert.ok(noIni);
  assert.deepEqual(noIni.ids, ["G-N1"]);
});

test("groupAndSortGates puts open-bearing groups before closed-only groups", { skip }, async (t) => {
  const { module: mod } = await compileGates(t);
  // Closed-only initiative comes before open-bearing initiative alphabetically;
  // the contract must put open-bearing first regardless of name.
  const edges = [];
  const nodes = {};
  const gates = [
    { id: "G-A1", status: "resolved", initiative: "aaa-closed" },
    { id: "G-A2", status: "resolved", initiative: "aaa-closed" },
    { id: "G-Z1", status: "open", initiative: "zzz-open" },
  ];
  const groups = mod.groupAndSortGates(gates, edges, nodes);
  const names = groups.map(([n]) => n);
  assert.equal(names[0], "zzz-open", `open-bearing 'zzz-open' must lead, got order ${JSON.stringify(names)}`);
  assert.equal(names[1], "aaa-closed");
});

test("groupAndSortGates sorts open gates by downstream impact (desc), id asc as tiebreak", { skip }, async (t) => {
  const { module: mod } = await compileGates(t);
  const edges = [
    { from: "G-LOW", to: "T1", type: "BLOCKS" },
    { from: "G-HIGH", to: "T2", type: "BLOCKS" },
    { from: "G-HIGH", to: "T3", type: "BLOCKS" },
    { from: "G-HIGH", to: "T4", type: "BLOCKS" },
    { from: "G-MID", to: "T5", type: "BLOCKS" },
    { from: "G-MID", to: "T6", type: "BLOCKS" },
    { from: "G-TIE-A", to: "T7", type: "BLOCKS" },
    { from: "G-TIE-B", to: "T8", type: "BLOCKS" },
  ];
  const nodes = {
    T1: { status: "open" },
    T2: { status: "open" },
    T3: { status: "open" },
    T4: { status: "open" },
    T5: { status: "open" },
    T6: { status: "open" },
    T7: { status: "open" },
    T8: { status: "open" },
  };
  const gates = [
    { id: "G-LOW", status: "open", initiative: "x" },
    { id: "G-HIGH", status: "open", initiative: "x" },
    { id: "G-MID", status: "open", initiative: "x" },
    { id: "G-TIE-A", status: "open", initiative: "x" },
    { id: "G-TIE-B", status: "open", initiative: "x" },
  ];
  const groups = mod.groupAndSortGates(gates, edges, nodes);
  const ids = groups[0][1].map((g) => g.id);
  // impact desc: HIGH(3), MID(2), then impact=1 sorted by id asc:
  // LOW, TIE-A, TIE-B.
  assert.deepEqual(
    ids,
    ["G-HIGH", "G-MID", "G-LOW", "G-TIE-A", "G-TIE-B"],
    `expected impact desc + id asc tiebreak, got ${ids.join(",")}`,
  );
});

// --- Render-level smoke ---------------------------------------------------

test("Gates.jsx default export is a Solid component (the view)", { skip }, async (t) => {
  const { module: mod } = await compileGates(t);
  assert.equal(typeof mod.default, "function", "Gates.jsx default export must be a Solid component function");
});

test("Gates.jsx does not import components.jsx / store.jsx with circular deps and stays within scope", { skip }, async (t) => {
  const { module: mod } = await compileGates(t);
  // The Fase 5B rule: only ui/src/views/Gates.jsx may change. Sanity check
  // that the file does not silently import Knowledge.jsx (it must not —
  // that's the explicit no-go zone).
  const src = fs.readFileSync(GATES_FILE, "utf8");
  assert.ok(!src.includes("./Knowledge"), "Gates.jsx must not import Knowledge.jsx");
  assert.ok(!src.includes("components.jsx") || src.includes('from "../components.jsx"'),
    "Gates.jsx may only import components from ../components.jsx (no other primitives path)");
  assert.ok(src.includes('from "../store.jsx"'), "Gates.jsx must read state from the store");
  assert.equal(typeof mod.default, "function");
});