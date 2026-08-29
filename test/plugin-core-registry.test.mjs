// test/plugin-core-registry.test.mjs — pure unit tests for the
// `buildRegistry(providers)` builder and the explicit built-in
// bootstrap that ships with `src/plugin-core-registry.mjs`.
//
// T-graph-kernel-registry · plan §B6A + ADR-012 §§1–3: the registry
// replaces the legacy `handler` table from ADR-006 with a typed entry
// shape `{ id, kind, provider: { prepare, apply } }`. The builder
// detects operation-id collisions deterministically and returns an
// immutable registry object; the bootstrap re-exports the built-in
// providers task / gate / knowledge that §B4 already validated.
//
// Pure: no filesystem, no lock, no state, no log, no policy, no
// command, no adapter, no CLI, no UI. The tests build literal
// provider stubs and pass them to `buildRegistry`; they never reach
// outside the module surface.

import { test } from "node:test";
import assert from "node:assert/strict";

import { importFresh } from "./helpers.mjs";

const REGISTRY_MODULE = "../src/plugin-core-registry.mjs";

// makeProvider — minimal `{ prepare, apply }` stub. Tests use the
// returned references to verify the registry exposes the same
// provider object by-reference (not a copy).
function makeProvider(tag = "test") {
  const prepare = async () => ({ tag });
  const apply = async () => ({ result: { tag }, effects: null });
  return Object.freeze({ prepare, apply });
}

// makeEntry — convenience builder for entry stubs.
function makeEntry(id, kind, tag) {
  return { id, kind, provider: makeProvider(tag ?? id) };
}

async function importRegistry() {
  return importFresh(REGISTRY_MODULE);
}

test("buildRegistry: returns a frozen registry with entries, providers, ops, byKind, has, get, lookup", async () => {
  const mod = await importRegistry();
  const reg = mod.buildRegistry([
    makeEntry("task.create", "task"),
    makeEntry("task.take", "task"),
    makeEntry("gate.create", "gate"),
    makeEntry("knowledge.create", "knowledge"),
  ]);

  assert.equal(typeof reg, "object", "registry is an object");
  assert.ok(Object.isFrozen(reg), "registry itself is frozen");

  // shape
  assert.ok(reg.entries instanceof Map, "entries is a Map");
  assert.ok(reg.providers instanceof Map, "providers is a Map");
  assert.ok(Array.isArray(reg.ops), "ops is an array");
  assert.ok(reg.byKind instanceof Map, "byKind is a Map");
  assert.ok(Object.isFrozen(reg.ops), "ops is frozen");

  // The Maps guard mutating ops via a Proxy. Object.isFrozen cannot
  // see through the Proxy, so we assert immutability by attempting
  // mutating ops and observing throws.
  assert.throws(() => reg.entries.set("x", 1), /read only/i);
  assert.throws(() => reg.entries.delete("task.create"), /read only/i);
  assert.throws(() => reg.entries.clear(), /read only/i);
  assert.throws(() => reg.providers.set("x", 1), /read only/i);
  assert.throws(() => reg.byKind.set("x", 1), /read only/i);
  // read access still works
  assert.equal(reg.entries.size, 4);
  assert.equal(reg.providers.get("task.create") === reg.lookup("task.create").provider, true);

  // maps frozen by mutation contract (see assertion block above);
  // these duplicate checks below stay here for documentation.
  assert.throws(() => reg.entries.set("x", 1), /read only/i);
  assert.throws(() => reg.providers.set("x", 1), /read only/i);

  // helpers
  assert.equal(typeof reg.has, "function", "has is a function");
  assert.equal(typeof reg.get, "function", "get is a function");
  assert.equal(typeof reg.lookup, "function", "lookup is a function");

  // happy paths
  assert.equal(reg.has("task.create"), true);
  assert.equal(reg.has("not.an.op"), false);
  assert.equal(reg.get("task.create").kind, "task");
  const looked = reg.lookup("task.create");
  // Verify the registry exposes the same provider we passed in.
  // We pass *one* provider object up front and assert reference
  // equality so accidental cloning surfaces as a regression.
  assert.ok(looked, "lookup returns entry");
  assert.equal(looked.id, "task.create");
  assert.equal(looked.kind, "task");
  assert.equal(looked.provider.prepare, reg.providers.get("task.create").prepare);

  // byKind grouping
  const tasks = reg.byKind.get("task");
  assert.ok(Array.isArray(tasks), "byKind.get(task) is an array");
  assert.deepEqual(
    [...tasks].sort(),
    ["task.create", "task.take"],
  );
  assert.equal(reg.byKind.get("knowledge").length, 1);

  // ops
  assert.deepEqual([...reg.ops].sort(), [
    "gate.create",
    "knowledge.create",
    "task.create",
    "task.take",
  ]);
});

test("buildRegistry: rejects duplicate operation ids deterministically with structured error", async () => {
  const mod = await importRegistry();
  let firstThrew = null;
  try {
    mod.buildRegistry([
      makeEntry("task.create", "task", "first"),
      makeEntry("task.take", "task", "other"),
      makeEntry("task.create", "task", "second"),
    ]);
  } catch (err) {
    firstThrew = err;
  }
  assert.ok(firstThrew, "expected duplicate id to throw");

  // shape of the structured error — must be deterministic.
  const err = firstThrew;
  assert.equal(typeof err, "object", "error is an object");
  assert.ok(err && typeof err === "object", "error is an object");
  assert.equal(err.code, "REGISTRY_DUPLICATE_ID");
  assert.equal(typeof err.message, "string");
  assert.ok(err.message.includes("task.create"), "message mentions duplicate id");
  assert.ok(err.details, "error carries details");
  assert.equal(err.details.id, "task.create");
  assert.equal(err.details.first_index, 0);
  assert.equal(err.details.second_index, 2);

  // Determinism: a second call with the same colliding input throws an
  // error with the same shape and indices — the builder must not
  // depend on insertion order of the underlying Map.
  let secondThrew = null;
  try {
    mod.buildRegistry([
      makeEntry("a.b", "task", "x"),
      makeEntry("a.b", "task", "y"),
    ]);
  } catch (err2) {
    secondThrew = err2;
  }
  assert.ok(secondThrew, "second duplicate id throws");
  assert.equal(secondThrew.code, "REGISTRY_DUPLICATE_ID");
  assert.equal(secondThrew.details.first_index, 0);
  assert.equal(secondThrew.details.second_index, 1);
});

test("buildRegistry: rejects empty / non-string ids", async () => {
  const mod = await importRegistry();

  const cases = [
    [{ id: "", kind: "task", provider: makeProvider() }, "empty"],
    [{ id: 42, kind: "task", provider: makeProvider() }, "number"],
    [{ id: null, kind: "task", provider: makeProvider() }, "null"],
    [{ id: undefined, kind: "task", provider: makeProvider() }, "undefined"],
    [{}, "missing"],
  ];
  for (const [entry, label] of cases) {
    let thrown = null;
    try {
      mod.buildRegistry([entry]);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, `${label}: should throw`);
    assert.equal(thrown.code, "REGISTRY_INVALID_ID", `${label}: code`);
    assert.equal(typeof thrown.message, "string");
    assert.ok(thrown.details, `${label}: carries details`);
  }
});

test("buildRegistry: rejects unknown kinds", async () => {
  const mod = await importRegistry();
  let thrown = null;
  try {
    mod.buildRegistry([makeEntry("note.add", "note")]);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, "should throw");
  assert.equal(thrown.code, "REGISTRY_INVALID_KIND");
  assert.equal(thrown.details.id, "note.add");
  assert.equal(thrown.details.kind, "note");
});

test("buildRegistry: rejects providers missing prepare or apply", async () => {
  const mod = await importRegistry();

  const cases = [
    [{ id: "task.create", kind: "task", provider: {} }, "empty provider"],
    [
      { id: "task.create", kind: "task", provider: { prepare: () => ({}) } },
      "missing apply",
    ],
    [
      { id: "task.create", kind: "task", provider: { apply: () => ({}) } },
      "missing prepare",
    ],
    [
      { id: "task.create", kind: "task", provider: { prepare: "no", apply: "no" } },
      "non-function prepare/apply",
    ],
    [{ id: "task.create", kind: "task" }, "missing provider"],
  ];
  for (const [entry, label] of cases) {
    let thrown = null;
    try {
      mod.buildRegistry([entry]);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, `${label}: should throw`);
    assert.equal(thrown.code, "REGISTRY_INVALID_PROVIDER", `${label}: code`);
  }
});

test("buildRegistry: rejects non-iterable providers", async () => {
  const mod = await importRegistry();

  for (const bad of [null, undefined, 42, "x", {}, true]) {
    let thrown = null;
    try {
      mod.buildRegistry(bad);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, `non-iterable (${typeof bad}) should throw`);
    assert.equal(thrown.code, "REGISTRY_INVALID_INPUT");
  }
});

test("buildRegistry: rejects non-object entries", async () => {
  const mod = await importRegistry();
  let thrown = null;
  try {
    mod.buildRegistry([null, makeEntry("task.take", "task")]);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, "null entry should throw");
  assert.equal(thrown.code, "REGISTRY_INVALID_ENTRY");
});

test("bootstrapBuiltins: includes all ADR-012 task / gate / knowledge operation ids, frozen, no persistence", async () => {
  const mod = await importRegistry();
  const reg = mod.bootstrapBuiltins();

  // ADR-012 §2 operation IDs that the built-in core covers.
  const expectedIds = [
    "task.create",
    "task.update",
    "task.take",
    "task.resolve",
    "task.release",
    "task.reopen",
    "task.cancel",
    "gate.create",
    "gate.resolve",
    "gate.reopen",
    "gate.cancel",
    "knowledge.create",
    "knowledge.update",
    "knowledge.deprecate",
  ];
  for (const id of expectedIds) {
    assert.ok(reg.has(id), `bootstrapBuiltins registers ${id}`);
  }
  assert.ok(Object.isFrozen(reg), "bootstrap registry is frozen");
  assert.equal(reg.ops.length, expectedIds.length, "all 14 expected ids present, no extras");

  // bootstrap must NOT expose plan-derived actions that are not part
  // of the public core surface (task.takeover, state.restore, etc.).
  for (const forbidden of [
    "task.takeover",
    "state.restore",
    "state.init_force",
    "note.add",
    "edge.add",
    "initiative.create",
  ]) {
    assert.equal(reg.has(forbidden), false, `bootstrap does not expose ${forbidden}`);
  }

  // Each entry exposes `{ id, kind, provider: { prepare, apply } }`
  // pointing to a real provider (no handlers/argv).
  for (const id of expectedIds) {
    const entry = reg.get(id);
    assert.equal(entry.id, id);
    assert.ok(["task", "gate", "knowledge"].includes(entry.kind), `${id} kind ∈ ADR-012 kinds`);
    assert.equal(typeof entry.provider, "object");
    assert.equal(typeof entry.provider.prepare, "function", `${id} provider.prepare is fn`);
    assert.equal(typeof entry.provider.apply, "function", `${id} provider.apply is fn`);
  }

  // byKind grouping matches the 7-4-3 split from ADR-012 / B4.
  assert.equal(reg.byKind.get("task").length, 7, "task has 7 ops");
  assert.equal(reg.byKind.get("gate").length, 4, "gate has 4 ops");
  assert.equal(reg.byKind.get("knowledge").length, 3, "knowledge has 3 ops");

  // bootstrap is callable any number of times and is deterministic.
  const reg2 = mod.bootstrapBuiltins();
  assert.deepEqual([...reg.ops].sort(), [...reg2.ops].sort(), "bootstrap is deterministic");
});

test("bootstrapBuiltins: provider references are the frozen built-in objects (no argv, no handlers)", async () => {
  const mod = await importRegistry();
  const reg = mod.bootstrapBuiltins();

  // Spot-check that built-in providers are non-argy: their signatures
  // do not take a position/argv array and are exactly `{ prepare,
  // apply }` frozen pairs. We rely on the canonical module exports
  // being frozen plain objects by construction; this test prevents
  // future regressions where a bootstrap step accidentally clones.
  for (const id of reg.ops) {
    const provider = reg.get(id).provider;
    assert.ok(Object.isFrozen(provider), `${id} provider is frozen`);
    // The provider's prepare takes a *named* argument shape (`{ snapshot,
    // input, request }`); it does NOT take `(argv)` like a legacy
    // `handler`. Assert the function has 0 declared parameters (only
    // destructured args) by checking `prepare.length <= 1`.
    assert.ok(provider.prepare.length <= 1, `${id} provider.prepare is not argv-style`);
    assert.ok(provider.apply.length <= 1, `${id} provider.apply is not argv-style`);
  }
});

test("bootstrapBuiltins: never touches filesystem / lock / state / log / adapter / CLI / UI", async () => {
  // Static assertion: the registry module must not import any of
  // those surfaces for its buildRegistry/bootstrapBuiltins path. We
  // probe the source string after import to keep this test fast and
  // pure. (Legacy ADR-006 compat shims still depend on commands/*
  // for the V2 adapter; B6B / B3 will replace those. The B6A core
  // builder path remains command-free.)
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const url = await import("node:url");
  const fileUrl = new url.URL(REGISTRY_MODULE, import.meta.url);
  const srcPath = fileUrl.fileURLToPath
    ? fileUrl.fileURLToPath()
    : fileUrl.pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const repoRoot = path.resolve(path.dirname(srcPath), "..");
  const registrySrc = await fs.readFile(
    path.resolve(repoRoot, "src/plugin-core-registry.mjs"),
    "utf8",
  );

  // 1. The new builder/bootstrap path must NOT import mutating
  // surfaces. We search only BEFORE the LEGACY EXPORTS marker so
  // that the transitional V2 compat shim stays allowed.
  const legacyIdx = registrySrc.indexOf("LEGACY EXPORTS");
  const builderSrc =
    legacyIdx >= 0 ? registrySrc.slice(0, legacyIdx) : registrySrc;
  const forbiddenInBuilder = [
    "../commands/",
    "./commands/",
    "../../commands/",
    "../plugin-core-adapter",
    "./plugin-core-adapter",
    "../bin/climier",
    "./bin/climier",
    "../../bin/climier",
    "../../lock.mjs",
    "../lock.mjs",
    "../../state.mjs",
    "../state.mjs",
    "../../log.mjs",
    "../log.mjs",
    "../../plugin-api.mjs",
    "../plugin-api.mjs",
    "../../plugin-dispatch.mjs",
    "../plugin-dispatch.mjs",
  ];
  for (const token of forbiddenInBuilder) {
    assert.ok(
      !builderSrc.includes(token),
      `buildRegistry/bootstrap path does not import ${token}`,
    );
  }

  // 2. The module exposes the canonical builder/bootstrap.
  assert.ok(registrySrc.includes("export function buildRegistry"));
  assert.ok(registrySrc.includes("export function bootstrapBuiltins"));
});
