import { sqliteStateFile } from "../../../storage/state.ts";
import { validateStateInvariants } from "../../../contracts/state-invariants.ts";
import {
  readSqliteInitiativeNames,
  readSqliteInitiativesByNames,
  readSqliteKnowledgeCandidates,
  readSqliteMutationEdges,
  readSqliteMutationIncidentEdges,
  readSqliteMutationMetadata,
  readSqliteNodesByIds,
  withSqliteReadTransaction,
} from "../../../storage/sqlite/store.ts";
import type { SnapshotClosure } from "../../../contracts/operations.ts";

const SQL_ID_BATCH = 500;
const TASK_CLOSURE_ACTIONS = new Set([
  "task.update", "task.take", "task.submit", "task.reject", "task.release", "task.reopen", "task.cancel", "note.add",
]);

type EdgeRow = { position: number; edge: Record<string, unknown> };
type MutationInput = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inputIds(value: unknown): string[] {
  const values = typeof value === "string"
    ? value.split(",")
    : Array.isArray(value) ? value : [];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function batches<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += SQL_ID_BATCH) {
    result.push(items.slice(index, index + SQL_ID_BATCH));
  }
  return result;
}

function snapshotInStoredOrder(metadata: Record<string, unknown>, values: Record<string, unknown>) {
  const rootOrder = Array.isArray(metadata.rootOrder) ? metadata.rootOrder as string[] : Object.keys(values);
  return Object.fromEntries(rootOrder.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
}

function knowledgeTargets(operation: SnapshotClosure, input: MutationInput, nodes: Record<string, Record<string, unknown>>) {
  const id = typeof input.id === "string" ? input.id : "";
  const target = nodes[id] || {};
  if (operation === "task.create") {
    const rawTags = input.tags;
    const tags = typeof rawTags === "string"
      ? rawTags.split(",").map((tag) => tag.trim()).filter(Boolean)
      : Array.isArray(rawTags) ? rawTags.map((tag) => String(tag).trim()).filter(Boolean) : rawTags;
    return [{ id, initiative: input.initiative, domain: input.domain, tags }];
  }
  const targets = [{ id, initiative: target.initiative, domain: target.domain, tags: target.tags }];
  if (operation === "task" && isRecord(input.changes)) {
    targets.push({
      id,
      initiative: input.changes.initiative ?? target.initiative,
      domain: input.changes.domain ?? target.domain,
      tags: input.changes.tags ?? target.tags,
    });
  }
  return targets.filter((candidate, index) =>
    !targets.slice(0, index).some((previous) => JSON.stringify(previous) === JSON.stringify(candidate)));
}

async function readDeclaredMutationSnapshotContents(projectDir: string, closure: SnapshotClosure, request: Record<string, unknown>) {
  const input = isRecord(request.input) ? request.input : {};
  const id = typeof input.id === "string" && input.id.length > 0 ? input.id : null;
  const actionMatchesClosure = closure === "task.create"
    ? request.action === "task.create"
    : closure === "task.accept"
      ? request.action === "task.accept"
      : closure === "task" && TASK_CLOSURE_ACTIONS.has(String(request.action));
  if (!id || !actionMatchesClosure) { return undefined; }

  const file = sqliteStateFile(projectDir);
  const metadata = await readSqliteMutationMetadata(file);
  if (!metadata) { return { state: null, raw: null, closure: null }; }
  if (metadata.closureSafe === false) { return undefined; }
  const nodes: Record<string, Record<string, unknown>> = {};
  const edgeRows = new Map<number, Record<string, unknown>>();
  const knownIds = new Set<string>();

  async function addNodes(ids: string[]) {
    const missing = [...new Set(ids.filter((nodeId) => nodeId && !knownIds.has(nodeId)))];
    for (const nodeId of missing) { knownIds.add(nodeId); }
    for (const group of batches(missing)) {
      Object.assign(nodes, await readSqliteNodesByIds(file, group));
    }
  }

  async function addEdges(rows: EdgeRow[]) {
    const endpoints: string[] = [];
    for (const { position, edge } of rows) {
      edgeRows.set(position, edge);
      if (typeof edge.from === "string") { endpoints.push(edge.from); }
      if (typeof edge.to === "string") { endpoints.push(edge.to); }
    }
    await addNodes(endpoints);
  }

  async function incident(ids: string[]) {
    for (const group of batches([...new Set(ids)])) {
      await addEdges(await readSqliteMutationIncidentEdges(file, group) as EdgeRow[]);
    }
  }

  async function directional(ids: string[], direction: "from" | "to", type: string) {
    const rows: EdgeRow[] = [];
    for (const group of batches([...new Set(ids)])) {
      rows.push(...await readSqliteMutationEdges(file, group, direction, type) as EdgeRow[]);
    }
    await addEdges(rows);
    return rows;
  }

  const operation = closure;
  const relatedIds = operation === "task.create"
    ? [...inputIds(input.blocked_by), ...inputIds(input.derived_from)]
    : [id];
  await addNodes([id, ...relatedIds]);
  if (operation !== "task.create") { await incident([id]); }

  if (operation === "task.accept") {
    const affectedBlockers = new Set([id]);
    const pending = [id];
    while (pending.length > 0) {
      const frontier = pending.splice(0, SQL_ID_BATCH);
      const rows = await directional(frontier, "from", "SUPERSEDES");
      for (const row of rows) {
        const next = row.edge.to;
        if (typeof next === "string" && !affectedBlockers.has(next)) {
          affectedBlockers.add(next);
          pending.push(next);
        }
      }
    }
    const dependents = await directional([...affectedBlockers], "from", "BLOCKS");
    const dependentIds = [...new Set(dependents.map(({ edge }) => edge.to).filter((to): to is string => typeof to === "string"))];
    await directional(dependentIds, "to", "BLOCKS");
  } else if (operation === "task" && request.action === "task.update" && isRecord(input.changes) && Object.hasOwn(input.changes, "blocked_by")) {
    const visited = new Set<string>();
    const pending = [id];
    while (pending.length > 0) {
      const frontier = pending.splice(0, SQL_ID_BATCH).filter((nodeId) => !visited.has(nodeId));
      if (frontier.length === 0) { continue; }
      for (const nodeId of frontier) { visited.add(nodeId); }
      const rows = await directional(frontier, "from", "BLOCKS");
      for (const row of rows) {
        if (typeof row.edge.to === "string" && !visited.has(row.edge.to)) { pending.push(row.edge.to); }
      }
    }
    await addNodes(inputIds(input.changes.blocked_by));
  }

  const supersedesVisited = new Set<string>();
  const supersedesPending = [...knownIds];
  while (supersedesPending.length > 0) {
    const frontier = supersedesPending.splice(0, SQL_ID_BATCH).filter((nodeId) => !supersedesVisited.has(nodeId));
    if (frontier.length === 0) { continue; }
    for (const nodeId of frontier) { supersedesVisited.add(nodeId); }
    const rows = await directional(frontier, "to", "SUPERSEDES");
    for (const row of rows) {
      if (typeof row.edge.from === "string" && !supersedesVisited.has(row.edge.from)) { supersedesPending.push(row.edge.from); }
    }
  }

  for (const target of knowledgeTargets(operation, input, nodes)) {
    const candidates = await readSqliteKnowledgeCandidates(file, target);
    await addNodes(Object.keys(candidates || {}));
  }

  let initiatives: Record<string, Record<string, unknown>> = {};
  if (operation === "task.create") {
    const names = await readSqliteInitiativeNames(file);
    const selected = await readSqliteInitiativesByNames(file, [String(input.initiative || "")]);
    initiatives = Object.fromEntries(names.map((name) => [name, selected[name] || {}]));
  } else {
    const initiativeNames = [nodes[id]?.initiative, isRecord(input.changes) ? input.changes.initiative : undefined]
      .filter((name): name is string => typeof name === "string" && name.length > 0);
    initiatives = await readSqliteInitiativesByNames(file, initiativeNames);
  }

  const values = {
    version: metadata.version,
    revision: metadata.revision,
    nodes,
    edges: [...edgeRows.entries()].toSorted(([left], [right]) => left - right).map(([, edge]) => edge),
    initiatives,
    log: [],
  };
  const state = snapshotInStoredOrder(metadata, values);
  validateStateInvariants(state, "readState");
  return {
    state,
    raw: null,
    closure: { previousRevision: metadata.revision, maximumNodeRevision: metadata.maximumNodeRevision },
  };
}

export async function readDeclaredMutationSnapshot(projectDir: string, closure: SnapshotClosure, request: Record<string, unknown>) {
  const input = isRecord(request.input) ? request.input : {};
  const id = typeof input.id === "string" && input.id.length > 0 ? input.id : null;
  const actionMatchesClosure = closure === "task.create"
    ? request.action === "task.create"
    : closure === "task.accept"
      ? request.action === "task.accept"
      : closure === "task" && TASK_CLOSURE_ACTIONS.has(String(request.action));
  if (!id || !actionMatchesClosure) { return undefined; }

  const file = sqliteStateFile(projectDir);
  const snapshot = await withSqliteReadTransaction(file, () =>
    readDeclaredMutationSnapshotContents(projectDir, closure, request));
  return snapshot === null ? { state: null, raw: null, closure: null } : snapshot;
}
