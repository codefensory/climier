// test/plugin-core-registry.test.mjs — pure unit tests for the
// `buildRegistry(providers)` compatibility facade and the built-in
// bootstrap owned by `src/application/operations/builtins.ts`.
//

// shape `{ id, kind, provider: { prepare, apply } }`. The builder
// detects operation-id collisions deterministically and returns an
// immutable registry object; Application Operations bootstraps the

//
// Pure: no filesystem, no lock, no state, no log, no policy, no
// command, no adapter, no CLI, no UI. The tests build literal
// provider stubs and pass them to `buildRegistry`; they never reach
// outside the module surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { OperationEntry } from "../src/contracts/operations.ts";

import { importFresh } from "./helpers.ts";

const REGISTRY_MODULE = "../src/plugins/core-registry.ts";
const BUILTINS_MODULE = "../src/application/operations/builtins.ts";

// makeProvider — minimal `{ prepare, apply }` stub. Tests use the
// returned references to verify the registry exposes the same
// provider object by-reference (not a copy).
function makeProvider(tag = "test") {
  const prepare = async () => ({ tag });
  const apply = async () => ({ result: { tag }, effects: null });
  return Object.freeze({ prepare, apply });
}

// makeEntry — convenience builder for entry stubs.
function makeEntry(id: string, kind: string, tag = id): OperationEntry | Record<string, unknown> {
  return { id, kind, provider: makeProvider(tag) };
}

type RegistryError = { code: string; message: string; details: Record<string, unknown> };

function asRegistryError(error: unknown): RegistryError {
  if (!error || typeof error !== "object") {
    throw new TypeError("expected registry error");
  }
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  if (
    typeof candidate.code !== "string" ||
    typeof candidate.message !== "string" ||
    !candidate.details ||
    typeof candidate.details !== "object" ||
    Array.isArray(candidate.details)
  ) {
    throw new TypeError("expected structured registry error");
  }
  return {
    code: candidate.code,
    message: candidate.message,
    details: candidate.details as Record<string, unknown>,
  };
}

async function importRegistry() {
  return importFresh(REGISTRY_MODULE);
}

function assertRegistryMaps(reg) {
  const maps = [reg.entries, reg.providers, reg.byKind];
  assert.ok(maps.every((map) => map instanceof Map));
  assert.ok(Array.isArray(reg.ops) && Object.isFrozen(reg.ops));
  assert.throws(() => reg.entries.set("x", 1), /read only/i);
  assert.throws(() => reg.entries.delete("task.create"), /read only/i);
  assert.throws(() => reg.entries.clear(), /read only/i);
  assert.throws(() => reg.providers.set("x", 1), /read only/i);
  assert.throws(() => reg.byKind.set("x", 1), /read only/i);
  assert.equal(reg.entries.size, 4);
  assert.equal(reg.providers.get("task.create"), reg.lookup("task.create").provider);
}

function assertRegistryLookups(reg) {
  assert.equal(typeof reg.has, "function");
  assert.equal(typeof reg.get, "function");
  assert.equal(typeof reg.lookup, "function");
  assert.equal(reg.has("task.create"), true);
  assert.equal(reg.has("not.an.op"), false);
  assert.equal(reg.get("task.create").kind, "task");
  const looked = reg.lookup("task.create");
  assert.ok(looked, "lookup returns entry");
  assert.equal(looked.id, "task.create");
  assert.equal(looked.kind, "task");
  assert.equal(looked.provider.prepare, reg.providers.get("task.create").prepare);
}

function assertRegistryGroups(reg) {
  const tasks = reg.byKind.get("task");
  assert.ok(Array.isArray(tasks));
  assert.deepEqual([...tasks].toSorted(), ["task.create", "task.take"]);
  assert.equal(reg.byKind.get("knowledge").length, 1);
  assert.deepEqual([...reg.ops].toSorted(), ["gate.create", "knowledge.create", "task.create", "task.take"]);
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
  assertRegistryMaps(reg);
  assertRegistryLookups(reg);
  assertRegistryGroups(reg);
});

function assertDuplicateRegistryError(error: unknown, { id, firstIndex, secondIndex }: {
  id: string;
  firstIndex: number;
  secondIndex: number;
}) {
  const typed = asRegistryError(error);
  assert.equal(typeof typed.code, "string");
  assert.equal(typed.code, "REGISTRY_DUPLICATE_ID");
  assert.equal(typeof typed.message, "string");
  assert.ok(typed.message.includes(id), "message mentions duplicate id");
  assert.ok(typed.details, "error carries details");
  assert.equal(typeof typed.details, "object");
  assert.deepEqual(Object.keys(typed.details).toSorted(), ["first_index", "id", "second_index"]);
  assert.equal(typed.details.id, id);
  assert.equal(typed.details.first_index, firstIndex);
  assert.equal(typed.details.second_index, secondIndex);
}

test("buildRegistry: rejects duplicate operation ids deterministically with structured error", async () => {
  const mod = await importRegistry();
  let firstThrew: unknown;
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
  assertDuplicateRegistryError(firstThrew, {
    id: "task.create",
    firstIndex: 0,
    secondIndex: 2,
  });

  // Determinism: a second call with the same colliding input throws an
  // error with the same shape and indices — the builder must not
  // depend on insertion order of the underlying Map.
  let secondThrew: unknown;
  try {
    mod.buildRegistry([
      makeEntry("a.b", "task", "x"),
      makeEntry("a.b", "task", "y"),
    ]);
  } catch (err2) {
    secondThrew = err2;
  }
  assert.ok(secondThrew, "second duplicate id throws");
  assertDuplicateRegistryError(secondThrew, {
    id: "a.b",
    firstIndex: 0,
    secondIndex: 1,
  });
  const firstError = asRegistryError(firstThrew);
  const secondError = asRegistryError(secondThrew);
  assert.equal(secondError.code, firstError.code);
  assert.ok(secondError.details);
  assert.equal(secondError.details.id, "a.b");
  assert.equal(secondError.details.first_index, 0);
  assert.equal(secondError.details.second_index, 1);
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
    let thrown: unknown;
    try {
      mod.buildRegistry([entry]);
    } catch (err) {
      thrown = err;
    }
    const typed = asRegistryError(thrown);
    assert.equal(typed.code, "REGISTRY_INVALID_ID", `${label}: code`);
    assert.equal(typeof typed.message, "string");
    assert.ok(typed.details, `${label}: carries details`);
  }
});

test("buildRegistry: rejects unknown kinds", async () => {
  const mod = await importRegistry();
  let thrown: unknown;
  try {
    mod.buildRegistry([makeEntry("note.add", "note")]);
  } catch (err) {
    thrown = err;
  }
  const typed = asRegistryError(thrown);
  assert.equal(typed.code, "REGISTRY_INVALID_KIND");
  assert.equal(typed.details.id, "note.add");
  assert.equal(typed.details.kind, "note");
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
    let thrown: unknown;
    try {
      mod.buildRegistry([entry]);
    } catch (err) {
      thrown = err;
    }
    const typed = asRegistryError(thrown);
    assert.equal(typed.code, "REGISTRY_INVALID_PROVIDER", `${label}: code`);
  }
});

test("buildRegistry: rejects non-iterable providers", async () => {
  const mod = await importRegistry();

  for (const bad of [null, undefined, 42, "x", {}, true]) {
    let thrown: unknown;
    try {
      mod.buildRegistry(bad);
    } catch (err) {
      thrown = err;
    }
    const typed = asRegistryError(thrown);
    assert.equal(typed.code, "REGISTRY_INVALID_INPUT");
  }
});

test("buildRegistry: rejects non-object entries", async () => {
  const mod = await importRegistry();
  let thrown: unknown;
  try {
    mod.buildRegistry([null, makeEntry("task.take", "task")]);
  } catch (err) {
    thrown = err;
  }
  const typed = asRegistryError(thrown);
  assert.equal(typed.code, "REGISTRY_INVALID_ENTRY");
});

function assertBuiltinIds(reg, expectedIds) {
  for (const id of expectedIds) {
    assert.ok(reg.has(id), `bootstrapBuiltins registers ${id}`);
  }
  assert.ok(Object.isFrozen(reg), "bootstrap registry is frozen");
  assert.equal(reg.ops.length, expectedIds.length, "all expected ids present, no extras");
  assert.equal(new Set(reg.ops).size, expectedIds.length, "operation ids are unique");
}

function assertBuiltinEntryShape(reg, expectedIds) {
  for (const id of expectedIds) {
    const entry = reg.get(id);
    assert.deepEqual(Object.keys(entry).toSorted(), ["id", "kind", "provider"], `${id} has only canonical entry fields`);
    assert.equal(entry.id, id);
    assert.ok(["task", "gate", "knowledge", "core"].includes(entry.kind), `${id} kind ∈ ADR-012 + core kinds`);
    assert.deepEqual(Object.keys(entry.provider).toSorted(), ["apply", "prepare"], `${id} provider has only prepare/apply`);
    assert.equal(typeof entry.provider, "object");
    assert.equal(typeof entry.provider.prepare, "function", `${id} provider.prepare is fn`);
    assert.equal(typeof entry.provider.apply, "function", `${id} provider.apply is fn`);
  }
}

function assertBuiltinKinds(reg) {
  assert.equal(reg.byKind.get("task").length, 9, "task has 9 ops");
  assert.equal(reg.byKind.get("gate").length, 5, "gate has 5 ops");
  assert.equal(reg.byKind.get("knowledge").length, 3, "knowledge has 3 ops");
  assert.equal(reg.byKind.get("core").length, 4, "core has 4 ops");
}

test("bootstrapBuiltins: includes all ADR-012 task / gate / knowledge operation ids, frozen, no persistence", async () => {
  const mod = await importRegistry();
  const reg = mod.bootstrapBuiltins();

  const expectedIds = [
    "task.create",
    "task.update",
    "task.take",
    "task.release",
    "task.reopen",
    "task.cancel",
    "task.submit",
    "task.accept",
    "task.reject",
    "gate.create",
    "gate.update",
    "gate.resolve",
    "gate.reopen",
    "gate.cancel",
    "knowledge.create",
    "knowledge.update",
    "knowledge.deprecate",
    "edge.add",
    "edge.remove",
    "note.add",
    "initiative.create",
  ];
  assertBuiltinIds(reg, expectedIds);

  // bootstrap must NOT expose plan-derived actions that are not part

  // edge.add, note.add and initiative.create ARE public surface since

  // not listed here.
  for (const forbidden of [
    "task.takeover",
    "state.restore",
    "state.init_force",
  ]) {
    assert.equal(reg.has(forbidden), false, `bootstrap does not expose ${forbidden}`);
  }

  // Each entry exposes its canonical typed provider pair.
  assertBuiltinEntryShape(reg, expectedIds);

  assertBuiltinKinds(reg);

  // bootstrap is callable any number of times and is deterministic.
  const reg2 = mod.bootstrapBuiltins();
  assert.deepEqual([...reg.ops].toSorted(), [...reg2.ops].toSorted(), "bootstrap is deterministic");
  assert.deepEqual(reg.ops, reg2.ops, "bootstrap preserves stable registration order");
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

    // `handler`. Assert the function has 0 declared parameters (only
    // destructured args) by checking `prepare.length <= 1`.
    assert.ok(provider.prepare.length <= 1, `${id} provider.prepare is not argv-style`);
    assert.ok(provider.apply.length <= 1, `${id} provider.apply is not argv-style`);
  }
});

async function assertCanonicalRegistryFacade() {
  const builtins = await importFresh(BUILTINS_MODULE);
  const facade = await importRegistry();
  assert.equal(typeof builtins.createBuiltinOperationRegistry, "function");
  assert.equal(typeof builtins.bootstrapBuiltins, "function");
  assert.deepEqual(
    builtins.createBuiltinOperationRegistry().ops,
    builtins.bootstrapBuiltins().ops,
  );
  assert.deepEqual(
    facade.bootstrapBuiltins().ops,
    builtins.bootstrapBuiltins().ops,
  );
  const fs = await import("node:fs/promises");
  const url = await import("node:url");
  const fileUrl = new url.URL(REGISTRY_MODULE, import.meta.url);
  const srcPath = url.fileURLToPath(fileUrl);
  const registrySrc = await fs.readFile(srcPath, "utf8");
  assert.doesNotMatch(registrySrc, /providers\//);
  assert.doesNotMatch(registrySrc, /TASK_OPERATION_IDS|collectBuiltins/);
  assert.match(registrySrc, /application\/operations\/builtins\.ts/);
}

test("application built-ins own the catalog while plugin registry remains a compatibility facade", async () => {
  await assertCanonicalRegistryFacade();
});

async function readRegistrySource() {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const url = await import("node:url");
  const fileUrl = new url.URL(REGISTRY_MODULE, import.meta.url);
  const srcPath = url.fileURLToPath
    ? url.fileURLToPath(fileUrl)
    : fileUrl.pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const repoRoot = path.resolve(path.dirname(srcPath), "../..");
  return fs.readFile(path.resolve(repoRoot, "src/plugins/core-registry.ts"), "utf8");
}

function assertRegistryImportsAreClean(registrySrc) {
  const forbiddenImports = [
    "../commands/", "./commands/", "../../commands/",
    "../plugin-core-adapter", "./plugin-core-adapter",
    "../bin/climier", "./bin/climier", "../../bin/climier",
    "../../lock.mjs", "../storage/lock.ts", "../../state.mjs",
    "../state.mjs", "../../log.mjs", "../storage/log.ts",
    "../../plugin-api.mjs", "../plugin-api.mjs",
    "../../plugin-dispatch.mjs", "../plugin-dispatch.mjs",
  ];
  for (const token of forbiddenImports) {
    assert.ok(!registrySrc.includes(token));
  }
  assert.equal(registrySrc.includes("export function buildRegistry"), false);
  assert.equal(registrySrc.includes("export function bootstrapBuiltins"), false);
  assert.equal(registrySrc.includes("handler:"), false);
  assert.equal(registrySrc.includes("LEGACY_"), false);
  assert.ok(registrySrc.includes("application/operations/registry.ts"));
  assert.ok(registrySrc.includes("application/operations/builtins.ts"));
  assert.equal(modHasRegistryArtifacts(registrySrc), false);
}

function modHasRegistryArtifacts(registrySrc) {
  return registrySrc.includes("handler:") || registrySrc.includes("LEGACY_");
}

test("bootstrapBuiltins: never touches filesystem / lock / state / log / adapter / CLI / UI", async () => {
  const mod = await importRegistry();
  const registrySrc = await readRegistrySource();
  assertRegistryImportsAreClean(registrySrc);
  assert.equal(mod.CORE_REGISTRY, undefined);
  assert.equal(mod.SUPPORTED_OPS, undefined);
});
