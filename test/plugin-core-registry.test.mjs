// T-plugin-core-foundation — `src/plugin-core-registry.mjs` table for
// the first slice of the core V2 plugin surface.
//
// ADR-006 §"Registry y adaptación" defines five operations for the
// first slice:
//   task.create, edge.add, task.take, task.resolve, note.add
// Each entry must expose: handler, positional, required, snakeToFlag,
// expose.as = false. The tests below are table-driven to keep the
// mapping explicit and to survive future additions (the parity slice
// in T-plugin-core-parity will add the remaining 11 ops).
//
// The registry MUST be pure: only references to handlers, no argv
// parsing, no I/O. The tests assert that `handler` is a function
// per slice, and they never call those handlers — they only verify
// the metadata that the adapter consumes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { importFresh } from "./helpers.mjs";

const REGISTRY_MODULE = "../src/plugin-core-registry.mjs";

// ---- Module surface ------------------------------------------------

test("plugin-core-registry: exports CORE_REGISTRY, SUPPORTED_OPS, and entry keys for the first slice", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  assert.equal(typeof mod.CORE_REGISTRY, "object");
  assert.ok(mod.CORE_REGISTRY !== null, "CORE_REGISTRY must not be null");
  assert.ok(Array.isArray(mod.SUPPORTED_OPS));
  for (const op of ["task.create", "edge.add", "task.take", "task.resolve", "note.add"]) {
    assert.ok(mod.SUPPORTED_OPS.includes(op), `SUPPORTED_OPS must contain ${op}`);
    assert.ok(op in mod.CORE_REGISTRY, `CORE_REGISTRY must contain ${op}`);
  }
});

test("plugin-core-registry: SUPPORTED_OPS exactly equals Object.keys(CORE_REGISTRY)", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  assert.deepEqual(
    [...mod.SUPPORTED_OPS].sort(),
    Object.keys(mod.CORE_REGISTRY).sort(),
  );
});

// ---- First-slice entry shape ---------------------------------------

test("plugin-core-registry: every entry exposes handler, positional, required, snakeToFlag, expose", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const requiredKeys = ["handler", "positional", "required", "snakeToFlag", "expose"];
  for (const op of Object.keys(mod.CORE_REGISTRY)) {
    const entry = mod.CORE_REGISTRY[op];
    for (const key of requiredKeys) {
      assert.ok(key in entry, `${op} entry must expose "${key}"`);
    }
    assert.equal(typeof entry.handler, "function", `${op}.handler must be a function`);
    assert.ok(Array.isArray(entry.positional), `${op}.positional must be an array`);
    assert.ok(Array.isArray(entry.required), `${op}.required must be an array`);
    assert.ok(entry.snakeToFlag && typeof entry.snakeToFlag === "object", `${op}.snakeToFlag must be an object`);
    assert.ok(entry.expose && typeof entry.expose === "object", `${op}.expose must be an object`);
  }
});

test("plugin-core-registry: every entry marks expose.as = false (input.as must be rejected by the adapter)", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  for (const op of Object.keys(mod.CORE_REGISTRY)) {
    assert.equal(mod.CORE_REGISTRY[op].expose.as, false, `${op}.expose.as must be false`);
  }
});

// ---- Table-driven: per-op contracts --------------------------------

test("plugin-core-registry: table — task.create maps to add-task with snake→flag + expose.as=false", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["task.create"];
  // Handler: add-task.mjs default export (the function itself).
  assert.equal(typeof e.handler, "function");
  // Positional: id is optional; the adapter should pass an array that
  // omits id if absent.
  assert.deepEqual(e.positional, ["id"]);
  // Required flags: the handler enforces --initiative, --title, --body,
  // --acceptance, --blocked-by. Without these, the core throws
  // MISSING_FIELD before any lock.
  assert.deepEqual(e.required, ["initiative", "title", "body", "acceptance", "blocked-by"]);
  // snake_case → kebab-case flag mapping (used by the adapter to
  // forward input fields as flags to the core handler).
  assert.deepEqual(e.snakeToFlag, {
    initiative: "initiative",
    title: "title",
    body: "body",
    acceptance: "acceptance",
    blocked_by: "blocked-by",
    supersedes: "supersedes",
    derived_from: "derived-from",
    domain: "domain",
    tags: "tags",
    refs: "refs",
    meta: "meta",
    backlog: "backlog",
  });
  assert.equal(e.expose.as, false);
  // allow_unregistered_initiative must NOT be exposed (ADR-006
  // §"Registry y adaptación" + identity invariant).
  assert.equal(e.expose.allow_unregistered_initiative, false);
});

test("plugin-core-registry: table — edge.add maps to add-edge with positional [from,to] and --type required", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["edge.add"];
  assert.equal(typeof e.handler, "function");
  // Positional: from, to are both required by the handler.
  assert.deepEqual(e.positional, ["from", "to"]);
  assert.deepEqual(e.required, ["type"]);
  assert.equal(e.snakeToFlag.type, "type");
  assert.equal(e.expose.as, false);
});

test("plugin-core-registry: table — task.take maps to take with positional [id] and no required flags", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["task.take"];
  assert.equal(typeof e.handler, "function");
  assert.deepEqual(e.positional, ["id"]);
  assert.deepEqual(e.required, []);
  assert.deepEqual(e.snakeToFlag, {});
  assert.equal(e.expose.as, false);
});

test("plugin-core-registry: table — task.resolve maps to resolve with positional [id] and --note required", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["task.resolve"];
  assert.equal(typeof e.handler, "function");
  assert.deepEqual(e.positional, ["id"]);
  // ADR: --note is flag-obligatory for tasks. The adapter must refuse
  // a task.resolve call without `note` in the input.
  assert.deepEqual(e.required, ["note"]);
  assert.equal(e.snakeToFlag.note, "note");
  assert.equal(e.expose.as, false);
});

test("plugin-core-registry: table — note.add maps to add-note with positional [id,text] and text required", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["note.add"];
  assert.equal(typeof e.handler, "function");
  // add-note reads `[id, ...rest]` and joins rest into the text. The
  // adapter passes `text` as the second positional slot.
  assert.deepEqual(e.positional, ["id", "text"]);
  // `text` is required because an empty note is invalid.
  assert.deepEqual(e.required, ["text"]);
  assert.deepEqual(e.snakeToFlag, {});
  assert.equal(e.expose.as, false);
});

// ---- Cross-entry invariants ----------------------------------------

test("plugin-core-registry: required fields live in positional, in snakeToFlag values, or both", async () => {
  // The adapter must know how to pull each required field out of the
  // input. Required fields are either:
  //   - positional (must appear in `positional`), so they pass as args;
  //   - a flag (must appear in snakeToFlag values), so they pass as flags.
  // Required fields may live in both buckets when they are ambiguous
  // (e.g. `note.add` requires `text`, which is positional only — not a flag).
  const mod = await importFresh(REGISTRY_MODULE);
  for (const op of Object.keys(mod.CORE_REGISTRY)) {
    const e = mod.CORE_REGISTRY[op];
    const positionalSet = new Set(e.positional);
    const flagValues = new Set(Object.values(e.snakeToFlag || {}));
    for (const req of e.required) {
      const inPositional = positionalSet.has(req);
      const inFlag = flagValues.has(req);
      assert.ok(
        inPositional || inFlag,
        `${op}: required field '${req}' must appear in positional OR in snakeToFlag values`,
      );
    }
  }
});

test("plugin-core-registry: five ops of the first slice, nothing else, no duplicates", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const firstSlice = ["task.create", "edge.add", "task.take", "task.resolve", "note.add"];
  assert.equal(
    Object.keys(mod.CORE_REGISTRY).length,
    firstSlice.length,
    "registry must contain exactly the first-slice ops; parity slice adds 11 more later",
  );
  assert.deepEqual(
    [...mod.SUPPORTED_OPS].sort(),
    [...firstSlice].sort(),
  );
});

test("plugin-core-registry: handler .name matches the canonical core command module", async () => {
  // ESM module instances are not reference-stable across `importFresh`
  // calls; we instead verify each handler's display name to make sure
  // the registry imported the default export of the right module and
  // did not inline a stub. Importing must not execute argv or mutate
  // state: the handler is opaque from here on.
  const mod = await importFresh(REGISTRY_MODULE);
  const expectedNames = {
    "task.create": "addTask",
    "edge.add": "addEdge",
    "task.take": "take",
    "task.resolve": "resolveV2",
    "note.add": "addNote",
  };
  for (const [op, name] of Object.entries(expectedNames)) {
    const handler = mod.CORE_REGISTRY[op].handler;
    assert.equal(typeof handler, "function", `${op}.handler must be a function`);
    assert.equal(handler.name, name, `${op}.handler.name must be ${name} (default export of commands/${name}.mjs)`);
  }
});
