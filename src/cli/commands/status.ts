
import { sqliteStateExists, stateFile } from "../../storage/state.ts";
import { readSqliteCounts, readSqliteEdges, readSqliteNodeMetadata, withSqliteReadTransaction } from "../../storage/sqlite/store.ts";
import { projectStatusView } from "../../read-model/status.ts";
import type { CommandContext } from "./contracts.ts";
import type { ReadModelEdge, ReadModelNode, ReadModelSnapshot } from "../../read-model/types.ts";

export const knownFlags = [
  "initiative",
  "kind",
  "status",
  "domain",
  "claimed-by",
  "stale-ms",
  "limit",
  "all",
  "as",
];

const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

// Status filters are documented as case-insensitive; compare in one case.
function statusFilter(flags) {
  return typeof flags.status === "string" ? flags.status.toLowerCase() : undefined;
}

function parseStaleMs(flags) {
  if (flags["stale-ms"] === undefined || flags["stale-ms"] === true) {return DEFAULT_STALE_MS;}
  const n = parseInt(flags["stale-ms"], 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`status: --stale-ms must be a non-negative integer (got '${flags["stale-ms"]}')`);
  }
  return n;
}

function parseLimit(flags): number | undefined {
  if (flags.limit === undefined || flags.limit === true) {return undefined;}
  const n = parseInt(flags.limit, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`status: --limit must be a non-negative integer (got '${flags.limit}')`);
  }
  return n;
}

function emptyResult() {
  return {
    summary: {
      ready: 0,
      in_progress: 0,
      submitted: 0,
      blocked: 0,
      backlog: 0,
      open_gates: 0,
      active_knowledge: 0,
    },
    tasks: { ready: [], in_progress: [], submitted: [], blocked: [], backlog: [] },
    gates: { open: [] },
    knowledge_count: 0,
    alerts: [],
  };
}

function remoteStatusOptions(flags) {
  return {
    staleMs: flags["stale-ms"] === undefined || flags["stale-ms"] === true
      ? undefined
      : parseStaleMs(flags),
    limit: parseLimit(flags) ?? undefined,
    all: flags.all === true || flags.all === "true",
    as: flags.as && flags.as !== true ? String(flags.as) : undefined,
  };
}

function remoteStatusFilters(flags) {
  return {
    initiative: flags.initiative || undefined,
    kind: flags.kind || undefined,
    status: statusFilter(flags),
    domain: flags.domain || undefined,
    claimedBy: flags["claimed-by"] || undefined,
    ...remoteStatusOptions(flags),
  };
}

async function readRemoteStatus(flags, backendClient) {
  return backendClient.readStatus(remoteStatusFilters(flags));
}

async function readLocalStatus(statePath, flags) {
  const file = stateFile(statePath);
  const result = await withSqliteReadTransaction(file, async () => {
    const nodes = await readSqliteNodeMetadata(file, {
      omit: ["body", "notes", "note", "acceptance"],
    }) as Record<string, ReadModelNode> | null;
    if (!nodes) {return null;}
    const edges = await readSqliteEdges(file) as ReadModelEdge[];
    const filters = {
      initiative: flags.initiative || undefined,
      kind: flags.kind || undefined,
      status: statusFilter(flags),
      domain: flags.domain || undefined,
      "claimed-by": flags["claimed-by"] || undefined,
      "stale-ms": parseStaleMs(flags),
      limit: parseLimit(flags),
      all: flags.all === true,
    };
    const countScope = {
      initiative: filters.initiative,
      domain: filters.domain,
    };
    const taskKind = !filters.kind || filters.kind === "resolvable";
    const knowledgeKind = !filters.kind || filters.kind === "knowledge";
    const count = async (query) => (await readSqliteCounts(file, query)).total;
    const [inProgress, submitted, openGates, activeKnowledge, knowledgeCount] = await Promise.all([
      taskKind && (!filters.status || filters.status === "in_progress")
        ? count({ ...countScope, kind: "resolvable", subkind: "task", status: "in_progress", claimedBy: !filters.status ? filters["claimed-by"] : undefined })
        : 0,
      taskKind && (!filters.status || filters.status === "submitted")
        ? count({ ...countScope, kind: "resolvable", subkind: "task", status: "submitted" })
        : 0,
      taskKind && (!filters.status || filters.status === "open")
        ? count({ initiative: filters.initiative, kind: "resolvable", subkind: "gate", status: "open", statusDefault: "open" })
        : 0,
      knowledgeKind
        ? count({ initiative: filters.initiative, kind: "knowledge", status: "active", statusDefault: "active" })
        : 0,
      knowledgeKind
        ? count({ initiative: filters.initiative, kind: "knowledge" })
        : 0,
    ]);
    const snapshot: ReadModelSnapshot = { nodes, edges };
    return projectStatusView({
      snapshot,
      filters,
      now: Date.now(),
      summaryCounts: { in_progress: inProgress, submitted, open_gates: openGates, active_knowledge: activeKnowledge, knowledge_count: knowledgeCount },
    });
  });
  if (!result) {
    await sqliteStateExists(statePath);
    return emptyResult();
  }
  return result;
}

export default async function statusV2({ statePath, flags, backendClient }: CommandContext) {
  if (backendClient?.type === "remote") {return readRemoteStatus(flags, backendClient);}
  return readLocalStatus(statePath, flags);
}
