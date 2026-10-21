
import { sqliteStateExists, stateFile } from "../../storage/state.ts";
import { readSqliteEdgesOf, readSqliteNode, readSqliteNodeMetadata, readSqliteNodesByIds, withSqliteReadTransaction } from "../../storage/sqlite/store.ts";
import { knowledgeForNode, projectContextView } from "../../read-model/index.ts";
import { throwV2 } from "../../contracts/errors.ts";
import type { CommandContext } from "./contracts.ts";
import type { ReadModelEdge, ReadModelNode, ReadModelSnapshot } from "../../read-model/types.ts";

export const knownFlags = ["as", "staleMs"];

const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

function parseStaleMs(flags) {
  if (flags.staleMs === undefined || flags.staleMs === true) {return DEFAULT_STALE_MS;}
  const n = Number(flags.staleMs);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`context: --staleMs must be a non-negative number (got '${flags.staleMs}')`);
  }
  return n;
}

function contextAgent(flags) {
  return flags.as && flags.as !== true ? String(flags.as) : undefined;
}

async function readRemoteContext(id, flags, backendClient) {
  return backendClient.readContext({ id, as: contextAgent(flags), staleMs: parseStaleMs(flags) });
}

async function supersedingEdges(file: string, ids: Set<string>): Promise<ReadModelEdge[]> {
  const edges: ReadModelEdge[] = [];
  const visited = new Set<string>();
  let pending = [...ids];
  while (pending.length > 0) {
    const batch = pending.filter((id) => !visited.has(id));
    if (batch.length === 0) {break;}
    for (const id of batch) {visited.add(id);}
    const batchIds = new Set(batch);
    const found = await readSqliteEdgesOf(file, batch, { type: "SUPERSEDES" }) as ReadModelEdge[];
    const incoming = found.filter((edge) => batchIds.has(edge.to));
    edges.push(...incoming);
    pending = incoming.map((edge) => edge.from);
  }
  return edges;
}

function contextRelatedIds(edges: ReadModelEdge[], id: string): Set<string> {
  const ids = new Set<string>();
  for (const edge of edges) {
    if (edge.type === "BLOCKS" && edge.to === id) {ids.add(edge.from);}
    if (edge.type === "INFORMS" && edge.from === id) {ids.add(edge.to);}
  }
  return ids;
}

async function contextSnapshot(file: string, id: string, node: ReadModelNode): Promise<ReadModelSnapshot> {
  const knowledgeNodes = await readSqliteNodeMetadata(file, {
    kind: "knowledge",
    fields: ["id", "kind", "domain", "tags", "initiative", "scope"],
  }) as Record<string, ReadModelNode>;
  const knowledgeView: ReadModelSnapshot = { nodes: { ...knowledgeNodes, [id]: node } };
  const knowledgeIds = knowledgeForNode({ snapshot: knowledgeView, id }).map((item) => item.id);
  const candidateNodes = await readSqliteNodesByIds(file, knowledgeIds) as Record<string, ReadModelNode>;
  const targetEdges = await readSqliteEdgesOf(file, [id]) as ReadModelEdge[];
  const relatedIds = contextRelatedIds(targetEdges, id);
  const supersedes = await supersedingEdges(file, relatedIds);
  const relatedNodes = await readSqliteNodesByIds(file, [...relatedIds, ...supersedes.map((edge) => edge.from)]) as Record<string, ReadModelNode>;
  const nodes = { ...knowledgeNodes, ...candidateNodes, ...relatedNodes, [id]: node };
  const edgeMap = new Map<string, ReadModelEdge>();
  for (const edge of [...targetEdges, ...supersedes]) {
    edgeMap.set(`${edge.from}\u0000${edge.to}\u0000${edge.type}`, edge);
  }
  return { nodes, edges: [...edgeMap.values()] };
}

async function readLocalContext(statePath, id, flags) {
  const file = stateFile(statePath);
  const view = await withSqliteReadTransaction(file, async () => {
    const node = await readSqliteNode(file, id) as ReadModelNode | null;
    if (!node) {return null;}
    return projectContextView({
      snapshot: await contextSnapshot(file, id, node),
      id,
      agent: contextAgent(flags),
      staleMs: parseStaleMs(flags),
      now: Date.now(),
    });
  });
  if (!view) {
    if (!(await sqliteStateExists(statePath))) {throw new Error("context: state file missing");}
    throwV2("NODE_NOT_FOUND", `context: node ${id} not found`, { id });
  }
  return view;
}

async function readContext({ statePath, id, flags, backendClient }) {
  if (backendClient?.type === "remote") {return readRemoteContext(id, flags, backendClient);}
  return readLocalContext(statePath, id, flags);
}

export default async function context({ statePath, positional, flags, backendClient }: CommandContext) {
  const [id] = positional;
  if (!id) {throwV2("MISSING_FIELD", "context: node id required", { field: "id" });}
  return readContext({ statePath, id, flags, backendClient });
}
