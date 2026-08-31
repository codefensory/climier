// Generic, process-local registry for application operations.
//
// The registry only validates and indexes provider entries. It has no
// knowledge of adapters, persistence, locks, or the built-in catalog.

const ADMITTED_KINDS = Object.freeze(["task", "gate", "knowledge", "core"]);

function asError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.message = message;
  if (details && typeof details === "object") {
    error.details = Object.freeze({ ...details });
  }
  return error;
}

function requireIterable(providers) {
  if (providers === null || providers === undefined) {
    throw asError(
      "REGISTRY_INVALID_INPUT",
      "buildRegistry: providers must be an iterable of entries",
      { type: providers === null ? "null" : typeof providers },
    );
  }
  const type = typeof providers;
  if (type !== "object" && type !== "string") {
    throw asError(
      "REGISTRY_INVALID_INPUT",
      "buildRegistry: providers must be an iterable of entries",
      { type },
    );
  }
  if (type === "string") {
    throw asError(
      "REGISTRY_INVALID_INPUT",
      "buildRegistry: providers must be a non-string iterable of entries",
      { type },
    );
  }
  if (typeof providers[Symbol.iterator] !== "function") {
    throw asError(
      "REGISTRY_INVALID_INPUT",
      "buildRegistry: providers must be an iterable of entries (no Symbol.iterator)",
      { type },
    );
  }
}

function assertValidId(id, index) {
  if (typeof id !== "string" || id.length === 0) {
    throw asError(
      "REGISTRY_INVALID_ID",
      `buildRegistry: entry[${index}].id must be a non-empty string`,
      { index, value: id === undefined ? undefined : typeof id },
    );
  }
}

function assertValidKind(id, kind, index) {
  if (typeof kind !== "string" || !ADMITTED_KINDS.includes(kind)) {
    throw asError(
      "REGISTRY_INVALID_KIND",
      `buildRegistry: entry[${index}].kind is not admitted (allowed: ${ADMITTED_KINDS.join(", ")})`,
      { index, id, kind },
    );
  }
}

function assertValidProvider(id, provider, index) {
  if (!provider || typeof provider !== "object") {
    throw asError(
      "REGISTRY_INVALID_PROVIDER",
      `buildRegistry: entry[${index}].provider must be an object with prepare/apply functions`,
      { index, id },
    );
  }
  if (typeof provider.prepare !== "function" || typeof provider.apply !== "function") {
    throw asError(
      "REGISTRY_INVALID_PROVIDER",
      `buildRegistry: entry[${index}].provider.prepare and provider.apply must be functions`,
      {
        index,
        id,
        has_prepare: typeof provider.prepare === "function",
        has_apply: typeof provider.apply === "function",
      },
    );
  }
}

function readOnlyMap(map) {
  return new Proxy(map, {
    get(target, property) {
      if (property === "set" || property === "delete" || property === "clear") {
        return () => {
          throw new TypeError("registry map is read only");
        };
      }
      const value = Reflect.get(target, property, target);
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

/**
 * Build an immutable index of operation providers.
 *
 * Entries are validated in iteration order. Duplicate IDs report the first
 * and second indexes, making failures deterministic for every iterable.
 */
export function buildRegistry(providers) {
  requireIterable(providers);
  const entries = [];
  const seen = new Map();
  let index = 0;

  for (const raw of providers) {
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

    if (seen.has(id)) {
      const firstIndex = seen.get(id);
      throw asError(
        "REGISTRY_DUPLICATE_ID",
        `buildRegistry: duplicate operation id '${id}' (first at index ${firstIndex}, second at index ${index})`,
        { id, first_index: firstIndex, second_index: index },
      );
    }
    seen.set(id, index);
    entries.push(Object.freeze({
      id,
      kind,
      provider: Object.freeze({
        prepare: provider.prepare,
        apply: provider.apply,
      }),
    }));
    index += 1;
  }

  const entriesById = new Map();
  const providersById = new Map();
  const byKind = new Map();
  const ops = [];
  for (const entry of entries) {
    entriesById.set(entry.id, entry);
    providersById.set(entry.id, entry.provider);
    if (!byKind.has(entry.kind)) byKind.set(entry.kind, []);
    byKind.get(entry.kind).push(entry.id);
    ops.push(entry.id);
  }

  const has = (id) => entriesById.has(id);
  const get = (id) => entriesById.get(id);
  const lookup = (id) => entriesById.get(id) || null;
  const list = (kind) => {
    if (kind === undefined) return ops.slice();
    return (byKind.get(kind) || []).slice();
  };

  return Object.freeze({
    entries: readOnlyMap(entriesById),
    providers: readOnlyMap(providersById),
    byKind: readOnlyMap(byKind),
    ops: Object.freeze(ops),
    has,
    get,
    list,
    lookup,
  });
}

export const ADMITTED_PROVIDER_KINDS = ADMITTED_KINDS;
