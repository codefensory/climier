// T-plugin-core-foundation + T-plugin-core-parity —
// `src/plugin-core-registry.mjs` table for the full core V2 plugin
// surface.
//
// ADR-006 §"Registry y adaptación" defines sixteen operations:
//
// First slice (T-plugin-core-foundation):
//   task.create, edge.add, task.take, task.resolve, note.add.
//
// Parity slice (T-plugin-core-parity):
//   initiative.create, task.update, task.release, task.reopen,
//   task.cancel, gate.create, gate.resolve, gate.reopen,
//   gate.cancel, knowledge.create, knowledge.deprecate.
//
// Each entry must expose: handler, positional, required, snakeToFlag,
// expose.as = false. The tests below are table-driven to keep the
// mapping explicit and to survive future additions without rewriting
// per-op expectations.
//
// The registry MUST be pure: only references to handlers, no argv
// parsing, no I/O. The tests assert that `handler` is a function
// per slice, and they never call those handlers — they only verify
// the metadata that the adapter consumes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { importFresh } from "./helpers.mjs";

const REGISTRY_MODULE = "../src/plugin-core-registry.mjs";

// Canonical surface that the registry must enumerate, in the order
// it is exposed. The two slices share a single SUPPORTED_OPS list.
const FIRST_SLICE = ["task.create", "edge.add", "task.take", "task.resolve", "note.add"];
const PARITY_SLICE = [
  "initiative.create",
  "task.update",
  "task.release",
  "task.reopen",
  "task.cancel",
  "gate.create",
  "gate.resolve",
  "gate.reopen",
  "gate.cancel",
  "knowledge.create",
  "knowledge.deprecate",
];
const FULL_SURFACE = [...FIRST_SLICE, ...PARITY_SLICE];

// ---- Module surface ------------------------------------------------

test("plugin-core-registry: exports CORE_REGISTRY, SUPPORTED_OPS, and entry keys for the full ADR-006 surface", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  assert.equal(typeof mod.CORE_REGISTRY, "object");
  assert.ok(mod.CORE_REGISTRY !== null, "CORE_REGISTRY must not be null");
  assert.ok(Array.isArray(mod.SUPPORTED_OPS));
  for (const op of FULL_SURFACE) {
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

// ---- Entry shape (all 16) ----------------------------------------

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

// ---- Per-op contracts: first slice --------------------------------

test("plugin-core-registry: table — task.create maps to add-task with snake→flag + expose.as=false", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["task.create"];
  assert.equal(typeof e.handler, "function");
  assert.deepEqual(e.positional, ["id"]);
  assert.deepEqual(e.required, ["initiative", "title", "body", "acceptance", "blocked-by"]);
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
  assert.equal(e.expose.allow_unregistered_initiative, false);
});

test("plugin-core-registry: table — edge.add maps to add-edge with positional [from,to] and --type required", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["edge.add"];
  assert.equal(typeof e.handler, "function");
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
  assert.deepEqual(e.required, ["note"]);
  assert.equal(e.snakeToFlag.note, "note");
  assert.equal(e.expose.as, false);
});

test("plugin-core-registry: table — note.add maps to add-note with positional [id,text] and text required", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["note.add"];
  assert.equal(typeof e.handler, "function");
  assert.deepEqual(e.positional, ["id", "text"]);
  assert.deepEqual(e.required, ["text"]);
  assert.deepEqual(e.snakeToFlag, {});
  assert.equal(e.expose.as, false);
});

// ---- Per-op contracts: parity slice -------------------------------

test("plugin-core-registry: table — initiative.create maps to add-initiative with positional [name] and name required", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["initiative.create"];
  assert.equal(typeof e.handler, "function");
  // `name` lives in the first positional slot; missing → adapter rejects with PLUGIN_CORE_INVALID_OPERATION.
  assert.deepEqual(e.positional, ["name"]);
  assert.deepEqual(e.required, ["name"]);
  assert.equal(e.snakeToFlag.desc, "desc");
  assert.equal(e.expose.as, false);
});

test("plugin-core-registry: table — task.update maps to update with positional [id] and broad snake→flag coverage", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["task.update"];
  assert.equal(typeof e.handler, "function");
  assert.deepEqual(e.positional, ["id"]);
  // The handler enforces "at least one field" internally; the adapter
  // cannot model "any-of" with the current `required` check, so the
  // patch-empty case is left to the handler and surfaces as
  // PLUGIN_CORE_ACTION_FAILED (the ADR contract).
  assert.deepEqual(e.required, []);
  // Every patchable scalar/CSV field that update.mjs accepts.
  for (const [snake, kebab] of Object.entries({
    title: "title",
    body: "body",
    initiative: "initiative",
    domain: "domain",
    tags: "tags",
    refs: "refs",
    meta: "meta",
    definition: "definition",
    acceptance: "acceptance",
    backlog: "backlog",
    purpose: "purpose",
    resolution_mode: "resolution-mode",
    knowledge_type: "knowledge-type",
    mitigation: "mitigation",
    if_revision: "if-revision",
    scope_domains: "scope-domains",
    scope_initiatives: "scope-initiatives",
    scope_tags: "scope-tags",
    scope_node_ids: "scope-node-ids",
  })) {
    assert.equal(e.snakeToFlag[snake], kebab, `task.update must map ${snake} to ${kebab}`);
  }
  assert.equal(e.expose.as, false);
});

test("plugin-core-registry: table — task.release maps to release with positional [id] and no required flags", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["task.release"];
  assert.equal(typeof e.handler, "function");
  assert.deepEqual(e.positional, ["id"]);
  assert.deepEqual(e.required, []);
  assert.deepEqual(e.snakeToFlag, {});
  assert.equal(e.expose.as, false);
});

test("plugin-core-registry: table — task.reopen maps to reopen with positional [id] and --reason required", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["task.reopen"];
  assert.equal(typeof e.handler, "function");
  assert.deepEqual(e.positional, ["id"]);
  assert.deepEqual(e.required, ["reason"]);
  assert.equal(e.snakeToFlag.reason, "reason");
  assert.equal(e.expose.as, false);
});

test("plugin-core-registry: table — task.cancel maps to cancel with positional [id] and --reason required", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["task.cancel"];
  assert.equal(typeof e.handler, "function");
  assert.deepEqual(e.positional, ["id"]);
  assert.deepEqual(e.required, ["reason"]);
  assert.equal(e.snakeToFlag.reason, "reason");
  assert.equal(e.expose.as, false);
});

test("plugin-core-registry: table — gate.create maps to add-gate with positional [id] and --initiative/--title/--body/--purpose required", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["gate.create"];
  assert.equal(typeof e.handler, "function");
  assert.deepEqual(e.positional, ["id"]);
  // The required set mirrors the flags that add-gate (via requireFields) rejects.
  assert.deepEqual(e.required, ["initiative", "title", "body", "purpose"]);
  // Edge-related flags are forwarded through add-node.mjs's edge builder.
  for (const [snake, kebab] of Object.entries({
    initiative: "initiative",
    title: "title",
    body: "body",
    purpose: "purpose",
    resolution_mode: "resolution-mode",
    blocked_by: "blocked-by",
    supersedes: "supersedes",
    derived_from: "derived-from",
    domain: "domain",
    tags: "tags",
    refs: "refs",
    meta: "meta",
  })) {
    assert.equal(e.snakeToFlag[snake], kebab, `gate.create must map ${snake} to ${kebab}`);
  }
  assert.equal(e.expose.as, false);
});

test("plugin-core-registry: table — gate.resolve maps to resolve with positional [id] and --choice/--rationale required", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["gate.resolve"];
  assert.equal(typeof e.handler, "function");
  assert.deepEqual(e.positional, ["id"]);
  // ADR §"Registry y adaptación": --choice and --rationale are flags
  // obligatory for gate resolves.
  assert.deepEqual(e.required, ["choice", "rationale"]);
  assert.equal(e.snakeToFlag.choice, "choice");
  assert.equal(e.snakeToFlag.rationale, "rationale");
  assert.equal(e.expose.as, false);
});

test("plugin-core-registry: table — gate.reopen maps to reopen with positional [id] and --reason required", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["gate.reopen"];
  assert.equal(typeof e.handler, "function");
  // Same handler as task.reopen (the handler decides whether the
  // current status was `done` or `resolved`); the adapter still
  // enforces id + reason.
  assert.deepEqual(e.positional, ["id"]);
  assert.deepEqual(e.required, ["reason"]);
  assert.equal(e.snakeToFlag.reason, "reason");
  assert.equal(e.expose.as, false);
});

test("plugin-core-registry: table — gate.cancel maps to cancel with positional [id] and --reason required", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["gate.cancel"];
  assert.equal(typeof e.handler, "function");
  // Same handler as task.cancel; the adapter still enforces id + reason.
  assert.deepEqual(e.positional, ["id"]);
  assert.deepEqual(e.required, ["reason"]);
  assert.equal(e.snakeToFlag.reason, "reason");
  assert.equal(e.expose.as, false);
});

test("plugin-core-registry: table — knowledge.create maps to add-knowledge with positional [id] and --initiative/--title/--body required", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["knowledge.create"];
  assert.equal(typeof e.handler, "function");
  assert.deepEqual(e.positional, ["id"]);
  // add-knowledge (via requireFields + the any-of-scope check) refuses
  // a missing --initiative/--title/--body before any scope check. The
  // any-of-scope rule is delegated to the handler.
  assert.deepEqual(e.required, ["initiative", "title", "body"]);
  for (const [snake, kebab] of Object.entries({
    initiative: "initiative",
    title: "title",
    body: "body",
    scope_domains: "scope-domains",
    scope_initiatives: "scope-initiatives",
    scope_tags: "scope-tags",
    scope_node_ids: "scope-node-ids",
    domain: "domain",
    tags: "tags",
    refs: "refs",
    meta: "meta",
    knowledge_type: "knowledge-type",
    mitigation: "mitigation",
    supersedes: "supersedes",
    derived_from: "derived-from",
  })) {
    assert.equal(e.snakeToFlag[snake], kebab, `knowledge.create must map ${snake} to ${kebab}`);
  }
  assert.equal(e.expose.as, false);
});

test("plugin-core-registry: table — knowledge.deprecate maps to deprecate-knowledge with positional [id] and --reason required", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  const e = mod.CORE_REGISTRY["knowledge.deprecate"];
  assert.equal(typeof e.handler, "function");
  assert.deepEqual(e.positional, ["id"]);
  assert.deepEqual(e.required, ["reason"]);
  assert.equal(e.snakeToFlag.reason, "reason");
  assert.equal(e.expose.as, false);
});

// ---- Cross-entry invariants (full surface) ------------------------

test("plugin-core-registry: required fields live in positional, in snakeToFlag values, or both", async () => {
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

test("plugin-core-registry: 16 ops of the full V2 surface — first slice 5 + parity slice 11, nothing else", async () => {
  const mod = await importFresh(REGISTRY_MODULE);
  assert.equal(
    Object.keys(mod.CORE_REGISTRY).length,
    FULL_SURFACE.length,
    "registry must contain exactly the 16 ADR-006 ops",
  );
  assert.deepEqual(
    [...mod.SUPPORTED_OPS].sort(),
    [...FULL_SURFACE].sort(),
  );
});

test("plugin-core-registry: handler .name matches the canonical core command module (all 16)", async () => {
  // ESM module instances are not reference-stable across `importFresh`
  // calls; we instead verify each handler's display name to make sure
  // the registry imported the default export of the right module and
  // did not inline a stub. Importing must not execute argv or mutate
  // state: the handler is opaque from here on.
  const mod = await importFresh(REGISTRY_MODULE);
  const expectedNames = {
    // first slice
    "task.create": "addTask",
    "edge.add": "addEdge",
    "task.take": "take",
    "task.resolve": "resolveV2",
    "note.add": "addNote",
    // parity slice
    "initiative.create": "addInitiative",
    "task.update": "updateV2",
    "task.release": "releaseV2",
    "task.reopen": "reopenV2",
    "task.cancel": "cancelV2",
    "gate.create": "addGate",
    "gate.resolve": "resolveV2",
    "gate.reopen": "reopenV2",
    "gate.cancel": "cancelV2",
    "knowledge.create": "addKnowledge",
    "knowledge.deprecate": "deprecateKnowledge",
  };
  for (const [op, name] of Object.entries(expectedNames)) {
    const handler = mod.CORE_REGISTRY[op].handler;
    assert.equal(typeof handler, "function", `${op}.handler must be a function`);
    assert.equal(handler.name, name, `${op}.handler.name must be ${name} (default export of commands/${name}.mjs)`);
  }
});
