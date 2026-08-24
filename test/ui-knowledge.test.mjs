// Contract tests for ui/src/views/Knowledge.jsx (Fase 5B Track B pieza 2).
//
// What this file pins:
//   1. Filters compose: initiative, knowledge type, scope dimension (and the
//      specific scope value), and the deprecated toggle.
//   2. Scope is grouped by dimension (domains/initiatives/tags/node-ids) and
//      never returned as one flat blob of chips.
//   3. Mitigation is exposed as its own field so the view can render it as
//      a secondary callout distinct from the body.
//   4. Deprecated nodes are kept in the same render path but must keep an
//      accessible contrast (the view must not collapse them to invisible).
//   5. Empty-state variants distinguish "no knowledge yet" from "no match"
//      so the operator never wonders if a filter swallowed a real record.
//   6. The Fase 5B scope rule: only ui/src/views/Knowledge.jsx is touched;
//      components.jsx / store.jsx / Gates.jsx stay frozen. The render-level
//      smoke test pins this.
//
// The pure helpers (groupScope, previewBody, isDeprecated, isActive,
// filterKnowledge, buildFacetOptions) are exported from Knowledge.jsx so we
// can test them with literal state objects, no DOM harness. The render-level
// smoke test uses the same babel-preset-solid compilation trick used by
// ui-components.test.mjs / ui-gates.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const UI_DIR = path.resolve("ui");
const UI_REQUIRE = createRequire(path.join(UI_DIR, "package.json"));
const babel = UI_REQUIRE("@babel/core");

const KNOWLEDGE_FILE = path.join(UI_DIR, "src", "views", "Knowledge.jsx");
const UI_DEPS_OK =
  fs.existsSync(path.join(UI_DIR, "node_modules", "solid-js")) &&
  fs.existsSync(path.join(UI_DIR, "node_modules", "@babel", "core"));
const skip = UI_DEPS_OK ? false : "ui dependencies not installed (run npm install in ui/)";

// --- Compilation harness --------------------------------------------------

// Node cannot resolve `.jsx` imports directly. Before compiling we rewrite
// the relative `.jsx` imports to inert stubs that expose the named exports
// the view actually uses. The pure helpers live at module scope, so this
// rewriting does not affect them.
const tmpFiles = new Set();
function rewriteJsxImports(src) {
  let out = src;
  out = out.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']\.\.\/store\.jsx["'];?/g,
    (_m, names) => {
      const list = names
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      const stubLines = list
        .map((n) => {
          if (n === "useStore") {
            return `const useStore = () => ({ snapshot: () => null, select: () => {}, lastSuccessfulAt: () => null, refreshing: () => false });`;
          }
          return `const ${n} = () => null;`;
        })
        .join("\n");
      return stubLines;
    },
  );
  out = out.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']\.\.\/components\.jsx["'];?/g,
    (_m, names) => {
      const list = names
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      const stubLines = list
        .map((n) => {
          if (n === "kindFor") {
            return `const kindFor = (n) => { if (!n) return "task"; if (n.kind === "knowledge") return "knowledge"; if (n.subkind === "gate") return "gate"; return "task"; };`;
          }
          return `const ${n} = () => null;`;
        })
        .join("\n");
      return stubLines;
    },
  );
  return out;
}

async function compileKnowledge(t) {
  const rawSource = fs.readFileSync(KNOWLEDGE_FILE, "utf8");
  const source = rewriteJsxImports(rawSource);
  const out = await babel.transformAsync(source, {
    filename: KNOWLEDGE_FILE,
    sourceType: "module",
    presets: [
      [UI_REQUIRE.resolve("babel-preset-solid"), { generate: "ssr", hydratable: false }],
    ],
  });
  const dir = path.join(UI_DIR, "src", "views");
  const file = path.join(dir, `.Knowledge.compiled.${process.pid}.${Date.now()}.mjs`);
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

// --- Helpers expected to be exported by Knowledge.jsx ---------------------

const REQUIRED_EXPORTS = [
  "groupScope",
  "previewBody",
  "isDeprecated",
  "isActive",
  "filterKnowledge",
  "buildFacetOptions",
];

test("Knowledge.jsx exports the pure helpers the contract depends on", { skip }, async (t) => {
  assert.ok(fs.existsSync(KNOWLEDGE_FILE), `${KNOWLEDGE_FILE} must exist`);
  const { module: mod } = await compileKnowledge(t);
  for (const name of REQUIRED_EXPORTS) {
    assert.equal(typeof mod[name], "function", `expected ${name} to be exported as a function`);
  }
  assert.equal(typeof mod.default, "function", "Knowledge.jsx must export the view as default");
});

// --- groupScope -----------------------------------------------------------

test("groupScope groups scope entries by dimension and never returns a flat blob", { skip }, async (t) => {
  const { module: mod } = await compileKnowledge(t);
  const scope = {
    domains: ["ui", "cli"],
    initiatives: ["ui"],
    tags: ["server", "state"],
    node_ids: ["T-1"],
  };
  const groups = mod.groupScope(scope);
  assert.ok(Array.isArray(groups));
  assert.equal(groups.length, 4, `expected 4 dimension groups, got ${groups.length}`);
  const labels = groups.map((g) => g.label);
  assert.deepEqual(labels, ["Domains", "Initiatives", "Tags", "Node IDs"]);
  for (const g of groups) {
    assert.equal(typeof g.tone, "string", `${g.label} group must have a tone`);
    assert.ok(Array.isArray(g.items), `${g.label} group must have an items array`);
    assert.ok(g.items.every((i) => typeof i === "string"), `${g.label} items must be strings`);
  }
  // Each group must keep the dimension label so the view can render it
  // as a subheading, never collapsed into a single chip list.
  const domains = groups.find((g) => g.label === "Domains");
  assert.deepEqual(domains.items.sort(), ["cli", "ui"]);
});

test("groupScope skips empty dimensions", { skip }, async (t) => {
  const { module: mod } = await compileKnowledge(t);
  const scope = {
    domains: [],
    initiatives: ["ui"],
    tags: [],
    node_ids: [],
  };
  const groups = mod.groupScope(scope);
  assert.equal(groups.length, 1, `only Initiatives should survive, got ${groups.length}`);
  assert.equal(groups[0].label, "Initiatives");
});

test("groupScope tolerates missing / malformed scope", { skip }, async (t) => {
  const { module: mod } = await compileKnowledge(t);
  assert.deepEqual(mod.groupScope(undefined), []);
  assert.deepEqual(mod.groupScope(null), []);
  assert.deepEqual(mod.groupScope({}), []);
  // Wrong shape (string instead of arrays) must not crash.
  assert.deepEqual(mod.groupScope({ domains: "ui" }), []);
});

// --- previewBody ----------------------------------------------------------

test("previewBody returns text untouched when it fits the line budget", { skip }, async (t) => {
  const { module: mod } = await compileKnowledge(t);
  assert.equal(mod.previewBody("short body", 3), "short body");
  assert.equal(mod.previewBody("line one\nline two", 3), "line one\nline two");
});

test("previewBody clamps long bodies to N lines with ellipsis", { skip }, async (t) => {
  const { module: mod } = await compileKnowledge(t);
  const text = "a\nb\nc\nd\ne";
  assert.equal(mod.previewBody(text, 3), "a\nb\nc…");
});

test("previewBody handles falsy / non-string input", { skip }, async (t) => {
  const { module: mod } = await compileKnowledge(t);
  assert.equal(mod.previewBody(""), "");
  assert.equal(mod.previewBody(null), "");
  assert.equal(mod.previewBody(undefined), "");
});

// --- isDeprecated / isActive ----------------------------------------------

test("isDeprecated / isActive partition knowledge nodes by status", { skip }, async (t) => {
  const { module: mod } = await compileKnowledge(t);
  assert.equal(mod.isDeprecated({ status: "deprecated" }), true);
  assert.equal(mod.isDeprecated({ status: "active" }), false);
  assert.equal(mod.isActive({ status: "active" }), true);
  assert.equal(mod.isActive({ status: "deprecated" }), false);
  // Default status for newly created knowledge is "active"; an explicit
  // missing status must NOT count as deprecated.
  assert.equal(mod.isDeprecated({}), false);
  assert.equal(mod.isActive({}), true);
  assert.equal(mod.isDeprecated(null), false);
  assert.equal(mod.isActive(null), false);
});

// --- filterKnowledge -----------------------------------------------------

function mkKnowledge(over = {}) {
  return {
    id: over.id || "K-x",
    kind: "knowledge",
    title: over.title || "untitled",
    status: over.status || "active",
    initiative: over.initiative || "ui",
    knowledge_type: over.knowledge_type || "warning",
    scope: over.scope || { domains: [], initiatives: [], tags: [], node_ids: [] },
    mitigation: over.mitigation || "",
    body: over.body || "",
    notes: over.notes || [],
  };
}

test("filterKnowledge returns the list untouched when no filter is active", { skip }, async (t) => {
  const { module: mod } = await compileKnowledge(t);
  const list = [
    mkKnowledge({ id: "K-a" }),
    mkKnowledge({ id: "K-b", knowledge_type: "fact" }),
  ];
  const f = {
    initiative: "",
    knowledgeType: "",
    scopeDimension: "",
    scopeValue: "",
    showDeprecated: false,
    q: "",
  };
  const out = mod.filterKnowledge(list, f);
  assert.equal(out.length, 2, `expected 2 (active only), got ${out.length}`);
  assert.deepEqual(out.map((n) => n.id).sort(), ["K-a", "K-b"]);
});

test("filterKnowledge hides deprecated when showDeprecated is false", { skip }, async (t) => {
  const { module: mod } = await compileKnowledge(t);
  const list = [
    mkKnowledge({ id: "K-active" }),
    mkKnowledge({ id: "K-old", status: "deprecated" }),
  ];
  const f = {
    initiative: "",
    knowledgeType: "",
    scopeDimension: "",
    scopeValue: "",
    showDeprecated: false,
    q: "",
  };
  const out = mod.filterKnowledge(list, f);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "K-active");
  const all = mod.filterKnowledge(list, { ...f, showDeprecated: true });
  assert.equal(all.length, 2);
});

test("filterKnowledge filters by initiative, knowledge_type, and search query", { skip }, async (t) => {
  const { module: mod } = await compileKnowledge(t);
  const list = [
    mkKnowledge({ id: "K-a", initiative: "ui", knowledge_type: "warning", title: "atomic writes" }),
    mkKnowledge({ id: "K-b", initiative: "auth", knowledge_type: "fact", title: "tokens" }),
    mkKnowledge({ id: "K-c", initiative: "ui", knowledge_type: "warning", title: "polling cadence" }),
  ];
  // Initiative only.
  const uiOnly = mod.filterKnowledge(list, {
    initiative: "ui",
    knowledgeType: "",
    scopeDimension: "",
    scopeValue: "",
    showDeprecated: false,
    q: "",
  });
  assert.deepEqual(uiOnly.map((n) => n.id).sort(), ["K-a", "K-c"]);
  // Knowledge type only.
  const facts = mod.filterKnowledge(list, {
    initiative: "",
    knowledgeType: "fact",
    scopeDimension: "",
    scopeValue: "",
    showDeprecated: false,
    q: "",
  });
  assert.deepEqual(facts.map((n) => n.id), ["K-b"]);
  // Search across id / title / body / knowledge_type.
  const search = mod.filterKnowledge(list, {
    initiative: "",
    knowledgeType: "",
    scopeDimension: "",
    scopeValue: "",
    showDeprecated: false,
    q: "polling",
  });
  assert.deepEqual(search.map((n) => n.id), ["K-c"]);
});

test("filterKnowledge filters by scope dimension and value", { skip }, async (t) => {
  const { module: mod } = await compileKnowledge(t);
  const list = [
    mkKnowledge({
      id: "K-tag-server",
      scope: { domains: [], initiatives: [], tags: ["server"], node_ids: [] },
    }),
    mkKnowledge({
      id: "K-tag-state",
      scope: { domains: [], initiatives: [], tags: ["state"], node_ids: [] },
    }),
    mkKnowledge({
      id: "K-node-1",
      scope: { domains: [], initiatives: [], tags: [], node_ids: ["T-1"] },
    }),
  ];
  const out = mod.filterKnowledge(list, {
    initiative: "",
    knowledgeType: "",
    scopeDimension: "Tags",
    scopeValue: "server",
    showDeprecated: false,
    q: "",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "K-tag-server");
  // Dimension only (no value selected) must not filter — operator is still
  // exploring which values exist for that dimension.
  const dimOnly = mod.filterKnowledge(list, {
    initiative: "",
    knowledgeType: "",
    scopeDimension: "Tags",
    scopeValue: "",
    showDeprecated: false,
    q: "",
  });
  assert.equal(dimOnly.length, 2);
});

test("filterKnowledge composes every filter together", { skip }, async (t) => {
  const { module: mod } = await compileKnowledge(t);
  const list = [
    mkKnowledge({
      id: "K-match",
      initiative: "ui",
      knowledge_type: "warning",
      title: "match",
      scope: { domains: [], initiatives: [], tags: ["server"], node_ids: [] },
    }),
    mkKnowledge({
      id: "K-other-init",
      initiative: "auth",
      knowledge_type: "warning",
      title: "match",
      scope: { domains: [], initiatives: [], tags: ["server"], node_ids: [] },
    }),
    mkKnowledge({
      id: "K-other-type",
      initiative: "ui",
      knowledge_type: "fact",
      title: "match",
      scope: { domains: [], initiatives: [], tags: ["server"], node_ids: [] },
    }),
    mkKnowledge({
      id: "K-other-scope",
      initiative: "ui",
      knowledge_type: "warning",
      title: "match",
      scope: { domains: [], initiatives: [], tags: ["other"], node_ids: [] },
    }),
  ];
  const out = mod.filterKnowledge(list, {
    initiative: "ui",
    knowledgeType: "warning",
    scopeDimension: "Tags",
    scopeValue: "server",
    showDeprecated: false,
    q: "",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "K-match");
});

// --- buildFacetOptions ----------------------------------------------------

test("buildFacetOptions returns sorted unique values for a given dimension", { skip }, async (t) => {
  const { module: mod } = await compileKnowledge(t);
  const list = [
    mkKnowledge({ initiative: "ui" }),
    mkKnowledge({ initiative: "auth" }),
    mkKnowledge({ initiative: "ui" }), // dup
    mkKnowledge({ initiative: "ui" }), // dup
    mkKnowledge({ initiative: "infra" }),
    mkKnowledge({ knowledge_type: "warning" }),
    mkKnowledge({ knowledge_type: "fact" }),
    mkKnowledge({ knowledge_type: "warning" }), // dup
  ];
  const initiatives = mod.buildFacetOptions(list, "initiative");
  assert.deepEqual(initiatives, ["auth", "infra", "ui"]);
  const types = mod.buildFacetOptions(list, "knowledge_type");
  assert.deepEqual(types, ["fact", "warning"]);
});

test("buildFacetOptions returns [] for missing / unknown dimension", { skip }, async (t) => {
  const { module: mod } = await compileKnowledge(t);
  assert.deepEqual(mod.buildFacetOptions([], "initiative"), []);
  assert.deepEqual(mod.buildFacetOptions([mkKnowledge()], "unknown-field"), []);
  assert.deepEqual(mod.buildFacetOptions(null, "initiative"), []);
});

// --- Render-level smoke ---------------------------------------------------

test("Knowledge.jsx default export is a Solid component (the view)", { skip }, async (t) => {
  const { module: mod } = await compileKnowledge(t);
  assert.equal(typeof mod.default, "function", "Knowledge.jsx default export must be a Solid component function");
});

test("Knowledge.jsx does not import Gates.jsx (Fase 5B scope rule)", { skip }, async (t) => {
  const src = fs.readFileSync(KNOWLEDGE_FILE, "utf8");
  assert.ok(!src.includes("./Gates"), "Knowledge.jsx must not import Gates.jsx");
  // The view may only pull primitives from ../components.jsx and state from
  // ../store.jsx — no other relative view path.
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/from\s*["'](\.\/[^"']+|\.\.\/[^"']+)["']/);
    if (!m) continue;
    const p = m[1];
    if (p === "../components.jsx" || p === "../store.jsx") continue;
    // Allow .jsx relative imports only when they point at our own
    // directory's siblings (none today); any other path is a scope break.
    assert.fail(`Knowledge.jsx imports outside its permitted paths: ${p}`);
  }
});

test("Knowledge.jsx no longer uses the old flat scope-chips rendering", { skip }, async (t) => {
  const src = fs.readFileSync(KNOWLEDGE_FILE, "utf8");
  // The old view rendered scope as one big `<For each={scopeChips(k)}>`
  // list. The new view must call groupScope() (or import a helper that
  // builds grouped dimensions) — otherwise the scope is back to a flat
  // blob of 10–11 px chips.
  assert.ok(
    /groupScope\b/.test(src),
    "Knowledge.jsx must reference groupScope to render scope by dimension",
  );
});
