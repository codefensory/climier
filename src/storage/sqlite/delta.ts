import crypto from "node:crypto";
import { structurallyEqual } from "../../contracts/structural-equality.ts";

type DeltaState = Record<string, unknown> & {
  revision: number;
  nodes: Record<string, unknown>;
  edges: unknown[];
  initiatives: Record<string, unknown>;
  log: unknown[];
};

export function bodyHash(body: string): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}

export function nodeWithoutBodyText(node: Record<string, unknown>) {
  // Keep the key in place so hydrated schema-1 JSON retains its property order.
  return { ...node, body: null };
}

export function isStateLogPrefix(previous: unknown[], next: unknown[]): boolean {
  return previous.length <= next.length && previous.every((entry, index) => structurallyEqual(entry, next[index]));
}

function changedMap(previous: Record<string, unknown>, next: Record<string, unknown>) {
  const upsert: Record<string, unknown> = {};
  const remove = Object.keys(previous).filter((key) => !Object.hasOwn(next, key));
  for (const [key, value] of Object.entries(next)) {
    if (!Object.hasOwn(previous, key) || !structurallyEqual(previous[key], value)) { upsert[key] = value; }
  }
  return { upsert, remove };
}

function nodeUnchanged(previous: unknown, next: unknown, storedBodyHash: string | null | undefined): boolean {
  if (!storedBodyHash) { return structurallyEqual(previous, next); }
  const node = next as Record<string, unknown>;
  if (typeof node?.body !== "string" || bodyHash(node.body) !== storedBodyHash) { return false; }
  const oldComparable = nodeWithoutBodyText(previous as Record<string, unknown> || {});
  return structurallyEqual(oldComparable, nodeWithoutBodyText(node));
}

function changedNodes(previous: Record<string, unknown>, next: Record<string, unknown>, previousBodyHashes: Map<string, string | null>) {
  const upsert: Record<string, unknown> = {};
  const remove = Object.keys(previous).filter((key) => !Object.hasOwn(next, key));
  for (const [id, value] of Object.entries(next)) {
    if (!Object.hasOwn(previous, id) || !nodeUnchanged(previous[id], value, previousBodyHashes.get(id))) { upsert[id] = value; }
  }
  return { upsert, remove };
}

export function createStateDelta(previous: DeltaState, next: DeltaState, previousBodyHashes: Map<string, string | null>) {
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  const coreFields = new Set(["revision", "nodes", "edges", "initiatives", "log"]);
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (coreFields.has(key)) { continue; }
    if (!Object.hasOwn(next, key)) { remove.push(key); }
    else if (!Object.hasOwn(previous, key) || (previous[key] !== next[key] && !structurallyEqual(previous[key], next[key]))) { set[key] = next[key]; }
  }
  const delta: Record<string, unknown> = {
    from_revision: previous.revision,
    revision: next.revision,
    set,
    remove,
    nodes: changedNodes(previous.nodes, next.nodes, previousBodyHashes),
    initiatives: changedMap(previous.initiatives, next.initiatives),
    log: isStateLogPrefix(previous.log, next.log)
      ? { append: next.log.slice(previous.log.length) }
      : { replace: next.log },
  };
  if (!structurallyEqual(previous.edges, next.edges)) { delta.edges = next.edges; }
  return delta;
}

export function readDeltaFloor(database): number | null {
  const row = database.query("SELECT value FROM sync_state WHERE key = 'delta_floor'").get();
  return Number.isSafeInteger(row?.value) ? row.value : null;
}

export function writeDeltaFloor(database, revision: number) {
  database.query("INSERT INTO sync_state (key, value) VALUES ('delta_floor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(revision);
}

function updateDeltaFloorForRewrite(database, { previous, state, appendOnly, hasNewLogEntry, floor }) {
  if (previous && (!appendOnly || (state.revision > previous.revision && !hasNewLogEntry))) {
    writeDeltaFloor(database, Math.max(floor ?? previous.revision, previous.revision));
  }
}

function updateDeltaHistoryFloor(database, { previous, state, appendOnly, hasNewLogEntry }) {
  const floor = readDeltaFloor(database);
  if (floor === null) { writeDeltaFloor(database, previous?.revision ?? state.revision); }
  updateDeltaFloorForRewrite(database, { previous, state, appendOnly, hasNewLogEntry, floor });
}

function retainedLogMetadata(appendOnly: boolean, old, data: string) {
  if (!appendOnly || !old || old.data !== data) { return null; }
  return { from_revision: old.from_revision, state_revision: old.state_revision, delta: old.delta };
}

export function makeStoredLogAppendRows(database, state: DeltaState, previous: DeltaState, delta: Record<string, any>) {
  const hasNewLogEntry = state.log.length > previous.log.length;
  updateDeltaHistoryFloor(database, { previous, state, appendOnly: true, hasNewLogEntry });
  const markedPosition = state.revision > previous.revision && state.log.length > 0 ? state.log.length - 1 : -1;
  const rows: Array<{ position: number; data: string; from_revision: number | null; state_revision: number | null; delta: string | null; existing: boolean }> = state.log.slice(previous.log.length).map((entry, index) => {
    const position = previous.log.length + index;
    return {
      position,
      data: JSON.stringify(entry),
      from_revision: position === markedPosition ? previous.revision : null,
      state_revision: position === markedPosition ? state.revision : null,
      delta: position === markedPosition ? JSON.stringify(delta) : null,
      existing: false,
    };
  });
  if (markedPosition >= 0 && markedPosition < previous.log.length) {
    rows.push({
      position: markedPosition,
      data: "",
      from_revision: previous.revision,
      state_revision: state.revision,
      delta: JSON.stringify(delta),
      existing: true,
    });
  }
  return rows;
}

export function makeStoredLogRows(database, state: DeltaState, previous: DeltaState | null, previousBodyHashes: Map<string, string | null>) {
  const oldRows = database.query("SELECT position, data, from_revision, state_revision, delta FROM log ORDER BY position").all();
  const appendOnly = previous !== null && isStateLogPrefix(previous.log, state.log);
  const hasNewLogEntry = appendOnly && state.log.length > previous.log.length;
  updateDeltaHistoryFloor(database, { previous, state, appendOnly, hasNewLogEntry });
  const delta = previous && state.revision > previous.revision ? createStateDelta(previous, state, previousBodyHashes) : null;
  const markedPosition = delta && state.log.length > 0 ? state.log.length - 1 : -1;
  return state.log.map((entry, position) => {
    const data = JSON.stringify(entry);
    if (position === markedPosition) {
      return { position, data, from_revision: previous!.revision, state_revision: state.revision, delta: JSON.stringify(delta) };
    }
    const retained = retainedLogMetadata(appendOnly, oldRows[position], data);
    return { position, data, from_revision: retained?.from_revision ?? null, state_revision: retained?.state_revision ?? null, delta: retained?.delta ?? null };
  });
}

export function readSqliteChangesInTransaction(database, since: number) {
  const revisionRow = database.query("SELECT value FROM meta WHERE key = 'revision'").get();
  if (!revisionRow) { return null; }
  const revision = JSON.parse(revisionRow.value);
  const floor = readDeltaFloor(database) ?? revision;
  const rows = database.query(
    "SELECT data, from_revision, state_revision, delta FROM log WHERE from_revision >= ? AND delta IS NOT NULL ORDER BY from_revision",
  ).all(since);
  let expectedRevision = since;
  let resetRequired = since < floor;
  for (const row of rows) {
    if (row.from_revision !== expectedRevision) { resetRequired = true; break; }
    expectedRevision = row.state_revision;
  }
  if (expectedRevision !== revision) { resetRequired = true; }
  return {
    revision,
    reset_required: resetRequired,
    changes: resetRequired ? [] : rows.map((row) => ({
      from_revision: row.from_revision,
      revision: row.state_revision,
      entry: JSON.parse(row.data),
      delta: JSON.parse(row.delta),
    })),
  };
}
