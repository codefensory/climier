import { sqliteStateFile } from "../../../storage/state.ts";
import { validateStateInvariants } from "../../../contracts/state-invariants.ts";
import {
  readSqliteInitiativeNames,
  readSqliteInitiativesByNames,
  readSqliteKnowledgeCandidates,
  readSqliteMutationBlocksEdges,
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
const GATE_CLOSURE_ACTIONS = new Set(["gate.update", "gate.resolve", "gate.reopen", "gate.cancel"]);
const KNOWLEDGE_CLOSURE_ACTIONS = new Set(["knowledge.update", "knowledge.deprecate"]);

type EdgeRow = { position: number; edge: Record<string, unknown> };
type MutationInput = Record<string, unknown>;
type DeclaredSnapshot = {
  state: Record<string, unknown> | null;
  raw: null;
  closure: { previousRevision: number; maximumNodeRevision: number; edgePositions?: number[]; rootOrder?: string[] | null } | null;
};

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

function closureMatchesAction(closure: SnapshotClosure, action: unknown): boolean {
  if (closure === "task.create") { return action === "task.create"; }
  if (closure === "task.accept") { return action === "task.accept"; }
  if (closure === "task") { return TASK_CLOSURE_ACTIONS.has(String(action)); }
  if (closure === "gate.create") { return action === "gate.create"; }
  if (closure === "gate") { return GATE_CLOSURE_ACTIONS.has(String(action)); }
  if (closure === "knowledge.create") { return action === "knowledge.create"; }
  if (closure === "knowledge") { return KNOWLEDGE_CLOSURE_ACTIONS.has(String(action)); }
  if (closure === "edge") { return action === "edge.add" || action === "edge.remove"; }
  if (closure === "initiative") { return action === "initiative.create"; }
  if (closure === "plugin-data.node") { return action === "plugin-data.node.set" || action === "plugin-data.node.delete"; }
  return closure === "plugin-data.project" && (action === "plugin-data.project.set" || action === "plugin-data.project.delete");
}

function requestedNodeIds(closure: SnapshotClosure, input: MutationInput): string[] {
  if (closure === "initiative" || closure === "plugin-data.project") { return []; }
  if (closure === "edge") {
    return [input.from, input.to].filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  if (closure === "task.create") {
    return [input.id, ...inputIds(input.blocked_by), ...inputIds(input.derived_from)]
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  if (closure === "gate.create") {
    return [input.id, input.supersedes, ...inputIds(input.blocked_by), ...inputIds(input.derived_from)]
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  if (closure === "knowledge.create") {
    return [input.id, input.supersedes]
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  if (closure === "plugin-data.node") {
    return [input.id].filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  return [input.id].filter((id): id is string => typeof id === "string" && id.length > 0);
}

function knowledgeTargets(operation: SnapshotClosure, input: MutationInput, nodes: Record<string, Record<string, unknown>>) {
  if (!["task", "task.create", "task.accept", "gate", "gate.create", "knowledge", "knowledge.create"].includes(operation)) {
    return [];
  }
  const id = typeof input.id === "string" ? input.id : "";
  const target = nodes[id] || {};
  if (operation === "task.create" || operation === "gate.create" || operation === "knowledge.create") {
    const rawTags = input.tags;
    const tags = typeof rawTags === "string"
      ? rawTags.split(",").map((tag) => tag.trim()).filter(Boolean)
      : Array.isArray(rawTags) ? rawTags.map((tag) => String(tag).trim()).filter(Boolean) : rawTags;
    return [{ id, initiative: input.initiative, domain: input.domain, tags }];
  }
  const targets = [{ id, initiative: target.initiative, domain: target.domain, tags: target.tags }];
  if ((operation === "task" || operation === "gate" || operation === "knowledge") && isRecord(input.changes)) {
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

async function readDeclaredMutationSnapshotContents(projectDir: string, closure: SnapshotClosure, request: Record<string, unknown>): Promise<DeclaredSnapshot | undefined> {
  const input = isRecord(request.input) ? request.input : {};
  if (!closureMatchesAction(closure, request.action)) { return undefined; }
  if (closure !== "initiative" && closure !== "plugin-data.project" && requestedNodeIds(closure, input).length === 0) {
    return undefined;
  }

  const file = sqliteStateFile(projectDir);
  const metadata = await readSqliteMutationMetadata(file, { includeExtras: closure === "plugin-data.project" });
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
  const requestedIds = requestedNodeIds(operation, input);
  await addNodes(requestedIds);
  const createsNode = operation === "task.create" || operation === "gate.create" || operation === "knowledge.create";
  if (!createsNode && operation !== "initiative" && operation !== "plugin-data.project" && operation !== "plugin-data.node") {
    await incident(requestedIds);
  } else if (operation === "gate.create" || operation === "knowledge.create") {
    await incident(requestedIds.filter((id) => id !== input.id));
  }

  if (operation === "task.accept") {
    const affectedBlockers = new Set([String(input.id)]);
    const pending = [String(input.id)];
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
    const pending = [String(input.id)];
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
  } else if (operation === "edge" && request.action === "edge.add" && typeof input.type === "string" && input.type.toUpperCase() === "BLOCKS") {
    const target = typeof input.to === "string" ? input.to : "";
    const source = typeof input.from === "string" ? input.from : "";
    const visited = new Set<string>();
    async function visit(nodeId: string): Promise<boolean> {
      if (nodeId === source) { return true; }
      if (visited.has(nodeId)) { return false; }
      visited.add(nodeId);
      const rows = await directional([nodeId], "from", "BLOCKS");
      for (const row of rows) {
        if (typeof row.edge.to === "string" && await visit(row.edge.to)) { return true; }
      }
      return false;
    }
    await visit(target);
  } else if (operation === "gate" && ["gate.resolve", "gate.reopen", "gate.cancel"].includes(String(request.action))) {
    const dependents = await directional([String(input.id)], "from", "BLOCKS");
    const dependentIds = [...new Set(dependents.map(({ edge }) => edge.to).filter((to): to is string => typeof to === "string"))];
    await directional(dependentIds, "to", "BLOCKS");
  }

  for (const target of knowledgeTargets(operation, input, nodes)) {
    const candidates = await readSqliteKnowledgeCandidates(file, target);
    await addNodes(Object.keys(candidates || {}));
  }

  const supersedesVisited = new Set<string>();
  const supersedesPending = [...knownIds];
  while (supersedesPending.length > 0) {
    const frontier = supersedesPending.splice(0, SQL_ID_BATCH).filter((nodeId) => !supersedesVisited.has(nodeId));
    if (frontier.length === 0) { continue; }
    for (const nodeId of frontier) { supersedesVisited.add(nodeId); }
    const [incoming, outgoing] = await Promise.all([
      directional(frontier, "to", "SUPERSEDES"),
      directional(frontier, "from", "SUPERSEDES"),
    ]);
    for (const row of [...incoming, ...outgoing]) {
      for (const next of [row.edge.from, row.edge.to]) {
        if (typeof next === "string" && !supersedesVisited.has(next)) { supersedesPending.push(next); }
      }
    }
  }

  let initiatives: Record<string, Record<string, unknown>> = {};
  if (operation === "task.create" || operation === "gate.create" || operation === "initiative") {
    const names = await readSqliteInitiativeNames(file);
    const requestedName = operation === "initiative" ? input.name : input.initiative;
    const selected = await readSqliteInitiativesByNames(file, [String(requestedName || "")]);
    initiatives = Object.fromEntries(names.map((name) => [name, selected[name] || {}]));
  } else {
    const initiativeNames = [
      nodes[String(input.id)]?.initiative,
      isRecord(input.changes) ? input.changes.initiative : undefined,
      input.initiative,
    ].filter((name): name is string => typeof name === "string" && name.length > 0);
    initiatives = await readSqliteInitiativesByNames(file, initiativeNames);
  }

  const rootExtras = operation === "plugin-data.project" && isRecord(metadata.extras) ? metadata.extras : {};
  const values = {
    ...rootExtras,
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
    closure: {
      previousRevision: metadata.revision,
      maximumNodeRevision: metadata.maximumNodeRevision,
      edgePositions: [...edgeRows.keys()].toSorted((left, right) => left - right),
      rootOrder: metadata.rootOrder,
    },
  };
}

export async function readDeclaredMutationSnapshot(projectDir: string, closure: SnapshotClosure, request: Record<string, unknown>): Promise<DeclaredSnapshot | undefined> {
  if (!closureMatchesAction(closure, request.action)) { return undefined; }
  const input = isRecord(request.input) ? request.input : {};
  if (closure !== "initiative" && closure !== "plugin-data.project" && requestedNodeIds(closure, input).length === 0) {
    return undefined;
  }

  const file = sqliteStateFile(projectDir);
  const snapshot = await withSqliteReadTransaction(file, () =>
    readDeclaredMutationSnapshotContents(projectDir, closure, request));
  return snapshot === null ? { state: null, raw: null, closure: null } : snapshot;
}

function batchMayAddBlocks(operations: Array<{ op: string; input: Record<string, unknown> }>): boolean {
  return operations.some(({ op, input }) =>
    (op === "edge.add" && typeof input.type === "string" && input.type.toUpperCase() === "BLOCKS") ||
    (op === "task.create" && inputIds(input.blocked_by).length > 0) ||
    (op === "gate.create" && inputIds(input.blocked_by).length > 0) ||
    (op === "task.update" && isRecord(input.changes) && Object.hasOwn(input.changes, "blocked_by")));
}

export async function readDeclaredBatchMutationSnapshot(
  projectDir: string,
  operations: Array<{ op: string; input: Record<string, unknown> }>,
  registry: { lookup: (id: string) => { snapshotClosure?: SnapshotClosure } | null },
) {
  const snapshots: Array<{
    state: Record<string, unknown>;
    raw: null;
    closure: { previousRevision: number; maximumNodeRevision: number; edgePositions?: number[]; rootOrder?: string[] | null };
  }> = [];
  for (const operation of operations) {
    const entry = registry.lookup(operation.op);
    if (!entry?.snapshotClosure) { return undefined; }
    const snapshot = await readDeclaredMutationSnapshot(projectDir, entry.snapshotClosure, {
      action: operation.op,
      input: operation.input,
    });
    if (!snapshot?.state || !snapshot.closure) { return undefined; }
    snapshots.push({ state: snapshot.state, raw: null, closure: snapshot.closure });
  }
  if (snapshots.length === 0) { return undefined; }

  const first = snapshots[0];
  const nodes: Record<string, Record<string, unknown>> = {};
  const initiatives: Record<string, Record<string, unknown>> = {};
  const extras: Record<string, unknown> = {};
  const positionedEdges = new Map<number, Record<string, unknown>>();
  for (const snapshot of snapshots) {
    Object.assign(nodes, snapshot.state.nodes);
    Object.assign(initiatives, snapshot.state.initiatives);
    for (const [key, value] of Object.entries(snapshot.state)) {
      if (!["version", "revision", "nodes", "edges", "initiatives", "log"].includes(key)) { extras[key] = value; }
    }
    const positions = snapshot.closure.edgePositions || [];
    (snapshot.state.edges as Array<Record<string, unknown>>).forEach((edge, index) => positionedEdges.set(positions[index] ?? index, edge));
  }
  if (batchMayAddBlocks(operations)) {
    // Declared exception to the bounded closure: edge invariants are global, so a
    // batch that may add BLOCKS edges validates every stored BLOCKS edge and its
    // endpoints. Other batches stay within their declared closure.
    const file = sqliteStateFile(projectDir);
    const rows = await readSqliteMutationBlocksEdges(file) as EdgeRow[];
    const ids = rows.flatMap(({ position, edge }) => {
      positionedEdges.set(position, edge);
      return [edge.from, edge.to].filter((id): id is string => typeof id === "string");
    });
    for (const group of batches([...new Set(ids)])) {
      Object.assign(nodes, await readSqliteNodesByIds(file, group));
    }
  }
  const values = {
    ...extras,
    version: first.state.version,
    revision: first.state.revision,
    nodes,
    edges: [...positionedEdges.entries()].toSorted(([left], [right]) => left - right).map(([, edge]) => edge),
    initiatives,
    log: [],
  };
  const state = snapshotInStoredOrder({ rootOrder: first.closure.rootOrder }, values);
  validateStateInvariants(state, "readState");
  return {
    state,
    raw: null,
    closure: first.closure,
  };
}
