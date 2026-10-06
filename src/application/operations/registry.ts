import type {
  OperationEntry,
  OperationId,
  OperationRegistry,
  Provider,
  ProviderKind,
} from "../../contracts/operations.ts";

const ADMITTED_KINDS = Object.freeze(["task", "gate", "knowledge", "core"] as const);
type RegistryEntry = OperationEntry;

function asError(code: string, message: string, details?: Record<string, unknown>): Error {
  const error = new Error(message);
  error.code = code;
  error.message = message;
  if (details && typeof details === "object") {error.details = Object.freeze({ ...details });}
  return error;
}

function requireIterable(providers: unknown): asserts providers is Iterable<unknown> {
  const type = typeof providers;
  if (providers === null || providers === undefined || (type !== "object" && type !== "string")) {
    throw asError("REGISTRY_INVALID_INPUT", "buildRegistry: providers must be an iterable of entries", {
      type: providers === null ? "null" : type,
    });
  }
  if (type === "string") {
    throw asError("REGISTRY_INVALID_INPUT", "buildRegistry: providers must be a non-string iterable of entries", { type });
  }
  if (!(Symbol.iterator in Object(providers)) || typeof (providers as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function") {
    throw asError("REGISTRY_INVALID_INPUT", "buildRegistry: providers must be an iterable of entries (no Symbol.iterator)", { type });
  }
}

function validateProviderEntry(raw: unknown, index: number): RegistryEntry {
  assertEntryObject(raw, index);
  const { id, kind, provider } = raw;
  assertEntryId(id, index);
  assertEntryKind(id, kind, index);
  assertEntryProvider(id, provider, index);
  return { id, kind, provider };
}

function assertEntryObject(raw: unknown, index: number): asserts raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw asError("REGISTRY_INVALID_ENTRY", `buildRegistry: entry at index ${index} is not an object`, { index });
  }
}

function assertEntryId(id: unknown, index: number): asserts id is OperationId {
  if (typeof id !== "string" || id.length === 0) {
    throw asError("REGISTRY_INVALID_ID", `buildRegistry: entry[${index}].id must be a non-empty string`, { index, value: id === undefined ? undefined : typeof id });
  }
}

function assertEntryKind(id: OperationId, kind: unknown, index: number): asserts kind is ProviderKind {
  if (typeof kind !== "string" || !ADMITTED_KINDS.includes(kind as ProviderKind)) {
    throw asError("REGISTRY_INVALID_KIND", `buildRegistry: entry[${index}].kind is not admitted (allowed: ${ADMITTED_KINDS.join(", ")})`, { index, id, kind });
  }
}

function assertEntryProvider(id: OperationId, provider: unknown, index: number): asserts provider is Provider {
  if (!provider || typeof provider !== "object") {
    throw asError("REGISTRY_INVALID_PROVIDER", `buildRegistry: entry[${index}].provider must be an object with prepare/apply functions`, { index, id });
  }
  const candidate = provider as Record<string, unknown>;
  if (typeof candidate.prepare !== "function" || typeof candidate.apply !== "function") {
    throw asError("REGISTRY_INVALID_PROVIDER", `buildRegistry: entry[${index}].provider.prepare and provider.apply must be functions`, {
      index, id, has_prepare: typeof candidate.prepare === "function", has_apply: typeof candidate.apply === "function",
    });
  }
}

function addValidatedEntry(raw: unknown, index: number, seen: Map<OperationId, number>, entries: RegistryEntry[]): void {
  const { id, kind, provider } = validateProviderEntry(raw, index);
  if (seen.has(id)) {
    const firstIndex = seen.get(id);
    throw asError("REGISTRY_DUPLICATE_ID", `buildRegistry: duplicate operation id '${id}' (first at index ${firstIndex}, second at index ${index})`, {
      id, first_index: firstIndex, second_index: index,
    });
  }
  seen.set(id, index);
  entries.push(Object.freeze({ id, kind, provider: Object.freeze({ prepare: provider.prepare, apply: provider.apply }) }));
}

function collectEntries(providers: Iterable<unknown>): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  const seen = new Map<OperationId, number>();
  let index = 0;
  for (const raw of providers) {addValidatedEntry(raw, index++, seen, entries);}
  return entries;
}

function indexEntries(entries: RegistryEntry[]): {
  entriesById: Map<OperationId, RegistryEntry>;
  providersById: Map<OperationId, Provider>;
  byKind: Map<ProviderKind, OperationId[]>;
  ops: OperationId[];
} {
  const entriesById = new Map<OperationId, RegistryEntry>();
  const providersById = new Map<OperationId, Provider>();
  const byKind = new Map<ProviderKind, OperationId[]>();
  const ops: OperationId[] = [];
  for (const entry of entries) {
    entriesById.set(entry.id, entry);
    providersById.set(entry.id, entry.provider);
    if (!byKind.has(entry.kind)) {byKind.set(entry.kind, []);}
    byKind.get(entry.kind)?.push(entry.id);
    ops.push(entry.id);
  }
  return { entriesById, providersById, byKind, ops };
}

function readOnlyMap<K, V>(map: Map<K, V>): ReadonlyMap<K, V> {
  return new Proxy(map, {
    get(target, property) {
      if (typeof property === "string" && ["set", "delete", "clear"].includes(property)) {
        return () => { throw new TypeError("registry map is read only"); };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set() { throw new TypeError("registry map is read only"); },
    deleteProperty() { throw new TypeError("registry map is read only"); },
  });
}

function registryView({ entriesById, providersById, byKind, ops }: ReturnType<typeof indexEntries>): OperationRegistry {
  const list = (kind?: ProviderKind): readonly OperationId[] => kind === undefined ? ops.slice() : (byKind.get(kind) || []).slice();
  return Object.freeze({
    entries: readOnlyMap(entriesById),
    providers: readOnlyMap(providersById),
    byKind: readOnlyMap(byKind),
    ops: Object.freeze(ops),
    has: (id: OperationId) => entriesById.has(id),
    get: (id: OperationId) => entriesById.get(id),
    list,
    lookup: (id: OperationId) => entriesById.get(id) || null,
  });
}

/**
 * Build an immutable index of operation providers. Duplicate IDs report the
 * first and second indexes for deterministic errors across iterable inputs.
 */
export function buildRegistry(providers: Iterable<unknown>): OperationRegistry {
  requireIterable(providers);
  return registryView(indexEntries(collectEntries(providers)));
}

export const ADMITTED_PROVIDER_KINDS = ADMITTED_KINDS;
