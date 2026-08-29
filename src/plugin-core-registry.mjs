// src/plugin-core-registry.mjs — registry builder for the graph kernel
// core providers (ADR-011 + ADR-012 §§1–3 + plan §B6A).
//
// This module is the **canonical** registry for built-in core
// providers. It exposes:
//
//   - `buildRegistry(providers)` — pure function. Accepts an iterable
//     of `{ id, kind, provider: { prepare, apply } }` entries, validates
//     each entry, detects duplicate operation IDs deterministically
//     and returns an immutable registry object shaped
//     `{ entries, providers, byKind, ops, has, get, lookup }`.
//
//   - `bootstrapBuiltins()` — explicit built-in bootstrap that wires
//     the provider indexes `src/providers/task/index.mjs`,
//     `src/providers/gate/index.mjs` and
//     `src/providers/knowledge/index.mjs` into the registry shape. It
//     does NOT depend on filesystem, lock, state, log, policy, the
//     adapter, the CLI bin, the dispatch, the plugin API, the plugin
//     commands or the UI. The providers themselves are already
//     validated by the §B1+B2+B4 pipeline (this slice depends on the
//     PASS validation of each of those tasks — T-graph-kernel-*).
//
// Hard rules (B6A allow-list):
//
//   - The registry is **process configuration**, not project state
//     (ADR-012 §5). It is reconstructed at every CLI startup from
//     versioned code; there is no `plugin register` command and no
//     operations manifest file.
//
//   - Entries point to providers through `{ prepare, apply }`. They
//     NEVER resolve to a legacy `handler` field, never reach for argv
//     and never call `withLock`, `updateState` or
//     `appendWithContext`. The mutation frontier is `kernel.mutate`
//     (B1+B2); the registry only knows how to find the provider for a
//     given operation ID.
//
//   - The provider kinds live in `ADMITTED_KINDS`. They correspond to
//     the three resolvable subdomains of the core (task / gate /
//     knowledge) and never include state-policy seams like
//     `note.add`, `edge.add`, `initiative.create`,
//     `state.restore`, `state.init_force` or `task.takeover` — those
//     are internal to other slices (B6B / B7) and are not exposed as
//     public operation IDs at this stage.

import {
  taskCreateProvider,
  taskUpdateProvider,
  taskTakeProvider,
  taskResolveProvider,
  taskReleaseProvider,
  taskReopenProvider,
  taskCancelProvider,
} from "./providers/task/index.mjs";
import {
  GATE_PROVIDER_KIND,
  gateProviders,
} from "./providers/gate/index.mjs";
import {
  createProvider as knowledgeCreateProviderFactory,
  updateProvider as knowledgeUpdateProviderFactory,
  deprecateProvider as knowledgeDeprecateProviderFactory,
} from "./providers/knowledge/index.mjs";
import { edgeAddProvider } from "./providers/core/edge.mjs";
import { noteAddProvider } from "./providers/core/note.mjs";
import { initiativeCreateProvider } from "./providers/core/initiative.mjs";

// ADMITTED_KINDS — whitelist of supported kinds for built-in entries.
// Knowledge scopes/ranking helpers are not part of the registry
// because they are not operation IDs; the registry only stores
// operation-shaped providers. `core` covers the kernel-resident
// operations that mutate the graph itself (`edge.add`,
// `note.add`); it is a registry-internal kind and never appears as a
// persisted node kind in v2 state.
const ADMITTED_KINDS = Object.freeze(["task", "gate", "knowledge", "core"]);

// PUBLIC_OPERATION_IDS — the operation IDs ADR-012 §2 commits to
// publishing through the registry. The list is used by the bootstrap
// to assert determinism over the built-in core surface (the registry
// may be extended in future slices by passing additional providers to
// `buildRegistry`).
const TASK_OPERATION_IDS = Object.freeze([
  "task.create",
  "task.update",
  "task.take",
  "task.resolve",
  "task.release",
  "task.reopen",
  "task.cancel",
]);
const GATE_OPERATION_IDS = Object.freeze([
  "gate.create",
  "gate.resolve",
  "gate.reopen",
  "gate.cancel",
]);
const KNOWLEDGE_OPERATION_IDS = Object.freeze([
  "knowledge.create",
  "knowledge.update",
  "knowledge.deprecate",
]);
// CORE_OPERATION_IDS — kernel-resident operations that mutate the
// graph itself (edges, notes, initiatives). They are not resolvable /
// gate / knowledge entries because they don't target a single node
// kind; they sit on their own kind so consumers can branch on the
// operation domain. This list is the contract §B6B exposes via
// bootstrapBuiltins: edge.add, note.add and initiative.create.
const CORE_OPERATION_IDS = Object.freeze(["edge.add", "note.add", "initiative.create"]);

// asError — shaped error factory; mirrors `throwV2` from `errors.mjs`
// but stays self-contained so the registry is a leaf module that does
// not pull in the v2 error stack.
function asError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.message = message;
  if (details && typeof details === "object") {
    err.details = Object.freeze({ ...details });
  }
  return err;
}

function requireIterable(providers) {
  if (
    providers === null ||
    providers === undefined
  ) {
    throw asError(
      "REGISTRY_INVALID_INPUT",
      "buildRegistry: providers must be an iterable of entries",
      { type: providers === null ? "null" : typeof providers },
    );
  }
  const t = typeof providers;
  if (t !== "object" && t !== "string") {
    throw asError(
      "REGISTRY_INVALID_INPUT",
      "buildRegistry: providers must be an iterable of entries",
      { type: t },
    );
  }
  // Reject strings explicitly: they are iterable but not the
  // intended surface (an array/Set/Map of entries is the contract).
  if (t === "string") {
    throw asError(
      "REGISTRY_INVALID_INPUT",
      "buildRegistry: providers must be a non-string iterable of entries",
      { type: t },
    );
  }
  if (typeof providers[Symbol.iterator] !== "function") {
    throw asError(
      "REGISTRY_INVALID_INPUT",
      "buildRegistry: providers must be an iterable of entries (no Symbol.iterator)",
      { type: t },
    );
  }
}

function assertValidId(id, entryIndex) {
  if (typeof id !== "string" || id.length === 0) {
    throw asError(
      "REGISTRY_INVALID_ID",
      `buildRegistry: entry[${entryIndex}].id must be a non-empty string`,
      { index: entryIndex, value: id === undefined ? undefined : typeof id },
    );
  }
}

function assertValidKind(id, kind, entryIndex) {
  if (typeof kind !== "string" || !ADMITTED_KINDS.includes(kind)) {
    throw asError(
      "REGISTRY_INVALID_KIND",
      `buildRegistry: entry[${entryIndex}].kind is not admitted (allowed: ${ADMITTED_KINDS.join(", ")})`,
      { index: entryIndex, id, kind },
    );
  }
}

function assertValidProvider(id, provider, entryIndex) {
  if (!provider || typeof provider !== "object") {
    throw asError(
      "REGISTRY_INVALID_PROVIDER",
      `buildRegistry: entry[${entryIndex}].provider must be an object with prepare/apply functions`,
      { index: entryIndex, id },
    );
  }
  const { prepare, apply } = provider;
  if (typeof prepare !== "function" || typeof apply !== "function") {
    throw asError(
      "REGISTRY_INVALID_PROVIDER",
      `buildRegistry: entry[${entryIndex}].provider.prepare and provider.apply must be functions`,
      {
        index: entryIndex,
        id,
        has_prepare: typeof prepare === "function",
        has_apply: typeof apply === "function",
      },
    );
  }
}

function asProvidersIterable(input) {
  // We accept arrays and any iterable. Generator/iterator consumers
  // are walked once; we never mutate the iterable.
  if (Array.isArray(input)) return input;
  if (typeof input[Symbol.iterator] === "function") return [...input];
  return [];
}

// buildRegistry — main entry point. Validates each entry, builds
// deterministic Maps and arrays, and returns an immutable registry
// wrapper.
export function buildRegistry(providers) {
  requireIterable(providers);
  const list = asProvidersIterable(providers);

  // First pass: validate shape and build a stable id → entry index
  // map for collision detection. The collision checks are
  // deterministic: they always use the **first** seen index and the
  // **second** (subsequent) seen index, regardless of iteration order.
  const seenIds = new Map();
  const validatedEntries = [];

  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw asError(
        "REGISTRY_INVALID_ENTRY",
        `buildRegistry: entry at index ${index} is not an object`,
        { index },
      );
    }
    const { id, kind, provider } = raw;

    assertValidId(id, index);
    assertValidKind(id, kind, index);
    assertValidProvider(id, provider, index);

    if (seenIds.has(id)) {
      const firstIndex = seenIds.get(id);
      throw asError(
        "REGISTRY_DUPLICATE_ID",
        `buildRegistry: duplicate operation id '${id}' (first at index ${firstIndex}, second at index ${index})`,
        { id, first_index: firstIndex, second_index: index },
      );
    }
    seenIds.set(id, index);

    validatedEntries.push(
      Object.freeze({
        id,
        kind,
        provider: Object.freeze({
          prepare: provider.prepare,
          apply: provider.apply,
        }),
      }),
    );
  }

  // Build Maps/arrays. The Maps preserve insertion order, so
  // `entries()` is the deterministic iteration order.
  const entries = new Map();
  const providersMap = new Map();
  const byKind = new Map();
  const ops = [];

  for (const entry of validatedEntries) {
    entries.set(entry.id, entry);
    providersMap.set(entry.id, entry.provider);
    if (!byKind.has(entry.kind)) byKind.set(entry.kind, []);
    byKind.get(entry.kind).push(entry.id);
    ops.push(entry.id);
  }

  function has(id) {
    return entries.has(id);
  }
  function get(id) {
    return entries.get(id);
  }
  function lookup(id) {
    const entry = entries.get(id);
    if (!entry) return null;
    return entry;
  }

  // The registry itself is frozen, and the three exposed Maps are
  // wrapped in read-only proxies so consumers cannot mutate them.
  // Tests pin this contract by attempting set/delete and asserting
  // the thrown error.
  const registry = Object.freeze({
    entries: proxyFrozenMap(entries),
    providers: proxyFrozenMap(providersMap),
    byKind: proxyFrozenMap(byKind),
    ops: Object.freeze(ops),
    has,
    get,
    lookup,
  });

  return registry;
}

function proxyFrozenMap(map) {
  return new Proxy(map, {
    get(target, prop, receiver) {
      if (prop === "set" || prop === "delete" || prop === "clear") {
        return () => {
          throw new TypeError("registry map is read only");
        };
      }
      const value = Reflect.get(target, prop, target);
      // Bind non-mutating functions to the underlying Map so
      // internal slots (like `[[MapData]]` for `size`) resolve
      // correctly.
      return typeof value === "function" ? value.bind(target) : value;
    },
    set() {
      throw new TypeError("registry map is read only");
    },
    deleteProperty() {
      throw new TypeError("registry map is read only");
    },
  });
}

// collectBuiltins — internal helper that materializes the static
// provider list for the explicit built-in bootstrap. The kind
// grouping is hard-coded so the bootstrap cannot accidentally drop
// an entry by relying on `gateProviders` iteration semantics; both
// approaches must converge on the same set of operation IDs.
function collectBuiltins() {
  const taskEntries = TASK_OPERATION_IDS.map((id, opIndex) => {
    const map = {
      "task.create": taskCreateProvider,
      "task.update": taskUpdateProvider,
      "task.take": taskTakeProvider,
      "task.resolve": taskResolveProvider,
      "task.release": taskReleaseProvider,
      "task.reopen": taskReopenProvider,
      "task.cancel": taskCancelProvider,
    };
    const provider = map[id];
    if (!provider) {
      throw asError(
        "REGISTRY_BUILTIN_PROVIDER_MISSING",
        `bootstrapBuiltins: missing task provider for ${id} (opIndex ${opIndex})`,
        { id, opIndex },
      );
    }
    return { id, kind: "task", provider };
  });

  // Gate providers are exposed through `gateProviders` as a frozen
  // map. We pin every operation ID individually so a future
  // `gateProviders` rename or extra entry cannot inflate or
  // deplete the bootstrap surface.
  const gateEntries = GATE_OPERATION_IDS.map((id) => {
    const provider = gateProviders[id];
    if (!provider) {
      throw asError(
        "REGISTRY_BUILTIN_PROVIDER_MISSING",
        `bootstrapBuiltins: gateProviders has no entry for ${id}`,
        { id },
      );
    }
    return { id, kind: GATE_PROVIDER_KIND, provider };
  });

  // Knowledge providers are factory functions; we materialize them
  // once per bootstrap call so the registry holds the canonical
  // plan-shape instance.
  const knowledgeFactories = {
    "knowledge.create": knowledgeCreateProviderFactory,
    "knowledge.update": knowledgeUpdateProviderFactory,
    "knowledge.deprecate": knowledgeDeprecateProviderFactory,
  };
  const knowledgeEntries = KNOWLEDGE_OPERATION_IDS.map((id) => {
    const factory = knowledgeFactories[id];
    if (typeof factory !== "function") {
      throw asError(
        "REGISTRY_BUILTIN_PROVIDER_MISSING",
        `bootstrapBuiltins: missing knowledge factory for ${id}`,
        { id },
      );
    }
    const provider = factory();
    if (
      !provider ||
      typeof provider !== "object" ||
      typeof provider.prepare !== "function" ||
      typeof provider.apply !== "function"
    ) {
      throw asError(
        "REGISTRY_BUILTIN_PROVIDER_INVALID",
        `bootstrapBuiltins: knowledge factory for ${id} did not return { prepare, apply }`,
        { id },
      );
    }
    return { id, kind: "knowledge", provider };
  });

  // Core providers are frozen plain objects (not factories); they are
  // pinned by operation id so the bootstrap cannot drop an entry
  // silently.
  const coreProviders = {
    "edge.add": edgeAddProvider,
    "note.add": noteAddProvider,
    "initiative.create": initiativeCreateProvider,
  };
  const coreEntries = CORE_OPERATION_IDS.map((id) => {
    const provider = coreProviders[id];
    if (
      !provider ||
      typeof provider !== "object" ||
      typeof provider.prepare !== "function" ||
      typeof provider.apply !== "function"
    ) {
      throw asError(
        "REGISTRY_BUILTIN_PROVIDER_MISSING",
        `bootstrapBuiltins: core provider for ${id} is not { prepare, apply }`,
        { id },
      );
    }
    return { id, kind: "core", provider };
  });

  return [...taskEntries, ...gateEntries, ...knowledgeEntries, ...coreEntries];
}

// bootstrapBuiltins — explicit built-in bootstrap. Reconstructs the
// registry of public operation IDs ADR-012 §2 commits to. The
// function is pure and has no side effects; it does not persist any
// state to disk, does not hold locks, does not depend on
// `~/.climier` or on `CLIMIER_HOME`, and can be safely called from
// unit tests or from CLI startup.
export function bootstrapBuiltins() {
  return buildRegistry(collectBuiltins());
}

// Exported constants for tests and for downstream consumers that
// need to enumerate the public surface without reaching into private
// helpers.
export const ADMITTED_PROVIDER_KINDS = ADMITTED_KINDS;
export const PUBLIC_TASK_OPS = TASK_OPERATION_IDS;
export const PUBLIC_GATE_OPS = GATE_OPERATION_IDS;
export const PUBLIC_KNOWLEDGE_OPS = KNOWLEDGE_OPERATION_IDS;
export const PUBLIC_CORE_OPS = CORE_OPERATION_IDS;

// ---------------------------------------------------------------------------
// LEGACY EXPORTS — transitional compatibility shims for the ADR-006 V2
// registry (`CORE_REGISTRY`, `SUPPORTED_OPS`) consumed by the existing
// plugin-core-adapter (`src/plugin-core-adapter.mjs`) and by the
// parity/concurrency suites under `test/plugin-policy-*.test.mjs`.
//
// B6A (this slice) does NOT change those consumers; future slices
// (B6B / B3) will replace the adapter with a kernel-driven path that
// consumes `bootstrapBuiltins()`. Until those slices land, the legacy
// entry shape (with `handler` references to commands/*) is preserved
// here so that `npm test` from main keeps green and downstream
// validators do not see a regression caused solely by removing the
// legacy exports. These imports are restricted to the compat shim
// below; the new `buildRegistry` / `bootstrapBuiltins` paths never
// reach into `commands/`.
// ---------------------------------------------------------------------------

import addTask from "./commands/add-task.mjs";
import addEdge from "./commands/add-edge.mjs";
import take from "./commands/take.mjs";
import resolve from "./commands/resolve.mjs";
import addNote from "./commands/add-note.mjs";
import addInitiative from "./commands/add-initiative.mjs";
import updateV2 from "./commands/update.mjs";
import releaseV2 from "./commands/release.mjs";
import reopenV2 from "./commands/reopen.mjs";
import cancelV2 from "./commands/cancel.mjs";
import addGate from "./commands/add-gate.mjs";
import addKnowledge from "./commands/add-knowledge.mjs";
import deprecateKnowledge from "./commands/deprecate-knowledge.mjs";

const LEGACY_TASK_CREATE_ENTRY = Object.freeze({
  handler: addTask,
  positional: Object.freeze(["id"]),
  required: Object.freeze([
    "initiative",
    "title",
    "body",
    "acceptance",
    "blocked-by",
  ]),
  snakeToFlag: Object.freeze({
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
  }),
  expose: Object.freeze({
    as: false,
    allow_unregistered_initiative: false,
  }),
});

const LEGACY_EDGE_ADD_ENTRY = Object.freeze({
  handler: addEdge,
  positional: Object.freeze(["from", "to"]),
  required: Object.freeze(["type"]),
  snakeToFlag: Object.freeze({ type: "type" }),
  expose: Object.freeze({ as: false }),
});

const LEGACY_TASK_TAKE_ENTRY = Object.freeze({
  handler: take,
  positional: Object.freeze(["id"]),
  required: Object.freeze([]),
  snakeToFlag: Object.freeze({}),
  expose: Object.freeze({ as: false }),
});

const LEGACY_TASK_RESOLVE_ENTRY = Object.freeze({
  handler: resolve,
  positional: Object.freeze(["id"]),
  required: Object.freeze(["note"]),
  snakeToFlag: Object.freeze({ note: "note" }),
  expose: Object.freeze({ as: false }),
});

const LEGACY_NOTE_ADD_ENTRY = Object.freeze({
  handler: addNote,
  positional: Object.freeze(["id", "text"]),
  required: Object.freeze(["text"]),
  snakeToFlag: Object.freeze({}),
  expose: Object.freeze({ as: false }),
});

const LEGACY_INITIATIVE_CREATE_ENTRY = Object.freeze({
  handler: addInitiative,
  positional: Object.freeze(["name"]),
  required: Object.freeze(["name"]),
  snakeToFlag: Object.freeze({
    name: "name",
    desc: "desc",
  }),
  expose: Object.freeze({ as: false }),
});

const LEGACY_TASK_UPDATE_ENTRY = Object.freeze({
  handler: updateV2,
  positional: Object.freeze(["id"]),
  required: Object.freeze([]),
  snakeToFlag: Object.freeze({
    title: "title",
    body: "body",
    acceptance: "acceptance",
    initiative: "initiative",
    domain: "domain",
    tags: "tags",
    if_revision: "if-revision",
    backlog: "backlog",
    definition: "definition",
  }),
  expose: Object.freeze({ as: false }),
});

const LEGACY_TASK_RELEASE_ENTRY = Object.freeze({
  handler: releaseV2,
  positional: Object.freeze(["id"]),
  required: Object.freeze([]),
  snakeToFlag: Object.freeze({ as: "as" }),
  expose: Object.freeze({ as: false }),
});

const LEGACY_TASK_REOPEN_ENTRY = Object.freeze({
  handler: reopenV2,
  positional: Object.freeze(["id"]),
  required: Object.freeze(["reason"]),
  snakeToFlag: Object.freeze({ reason: "reason" }),
  expose: Object.freeze({ as: false }),
});

const LEGACY_TASK_CANCEL_ENTRY = Object.freeze({
  handler: cancelV2,
  positional: Object.freeze(["id"]),
  required: Object.freeze(["reason"]),
  snakeToFlag: Object.freeze({ reason: "reason" }),
  expose: Object.freeze({ as: false }),
});

const LEGACY_GATE_CREATE_ENTRY = Object.freeze({
  handler: addGate,
  positional: Object.freeze(["id"]),
  required: Object.freeze([
    "initiative",
    "title",
    "body",
    "purpose",
  ]),
  snakeToFlag: Object.freeze({
    initiative: "initiative",
    title: "title",
    body: "body",
    purpose: "purpose",
    blocked_by: "blocked-by",
    supersedes: "supersedes",
    domain: "domain",
    tags: "tags",
    refs: "refs",
    meta: "meta",
  }),
  expose: Object.freeze({ as: false }),
});

const LEGACY_GATE_RESOLVE_ENTRY = Object.freeze({
  handler: resolve,
  positional: Object.freeze(["id"]),
  required: Object.freeze(["choice", "rationale"]),
  snakeToFlag: Object.freeze({
    choice: "choice",
    rationale: "rationale",
  }),
  expose: Object.freeze({ as: false }),
});

const LEGACY_GATE_REOPEN_ENTRY = Object.freeze({
  handler: reopenV2,
  positional: Object.freeze(["id"]),
  required: Object.freeze(["reason"]),
  snakeToFlag: Object.freeze({ reason: "reason" }),
  expose: Object.freeze({ as: false }),
});

const LEGACY_GATE_CANCEL_ENTRY = Object.freeze({
  handler: cancelV2,
  positional: Object.freeze(["id"]),
  required: Object.freeze(["reason"]),
  snakeToFlag: Object.freeze({ reason: "reason" }),
  expose: Object.freeze({ as: false }),
});

const LEGACY_KNOWLEDGE_CREATE_ENTRY = Object.freeze({
  handler: addKnowledge,
  positional: Object.freeze(["id"]),
  required: Object.freeze(["initiative", "title", "body"]),
  snakeToFlag: Object.freeze({
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
  }),
  expose: Object.freeze({ as: false }),
});

const LEGACY_KNOWLEDGE_DEPRECATE_ENTRY = Object.freeze({
  handler: deprecateKnowledge,
  positional: Object.freeze(["id"]),
  required: Object.freeze(["reason"]),
  snakeToFlag: Object.freeze({ reason: "reason" }),
  expose: Object.freeze({ as: false }),
});

export const CORE_REGISTRY = Object.freeze({
  "task.create": LEGACY_TASK_CREATE_ENTRY,
  "edge.add": LEGACY_EDGE_ADD_ENTRY,
  "task.take": LEGACY_TASK_TAKE_ENTRY,
  "task.resolve": LEGACY_TASK_RESOLVE_ENTRY,
  "note.add": LEGACY_NOTE_ADD_ENTRY,
  "initiative.create": LEGACY_INITIATIVE_CREATE_ENTRY,
  "task.update": LEGACY_TASK_UPDATE_ENTRY,
  "task.release": LEGACY_TASK_RELEASE_ENTRY,
  "task.reopen": LEGACY_TASK_REOPEN_ENTRY,
  "task.cancel": LEGACY_TASK_CANCEL_ENTRY,
  "gate.create": LEGACY_GATE_CREATE_ENTRY,
  "gate.resolve": LEGACY_GATE_RESOLVE_ENTRY,
  "gate.reopen": LEGACY_GATE_REOPEN_ENTRY,
  "gate.cancel": LEGACY_GATE_CANCEL_ENTRY,
  "knowledge.create": LEGACY_KNOWLEDGE_CREATE_ENTRY,
  "knowledge.deprecate": LEGACY_KNOWLEDGE_DEPRECATE_ENTRY,
});

export const SUPPORTED_OPS = Object.freeze(Object.keys(CORE_REGISTRY));
