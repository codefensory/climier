
import { readState } from "../../storage/state.ts";
import { projectStatusView } from "../../read-model/index.ts";

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

function parseStaleMs(flags) {
  if (flags["stale-ms"] === undefined || flags["stale-ms"] === true) {return DEFAULT_STALE_MS;}
  const n = parseInt(flags["stale-ms"], 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`status: --stale-ms must be a non-negative integer (got '${flags["stale-ms"]}')`);
  }
  return n;
}

function parseLimit(flags) {
  if (flags.limit === undefined || flags.limit === true) {return null;}
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
    status: flags.status || undefined,
    domain: flags.domain || undefined,
    claimedBy: flags["claimed-by"] || undefined,
    ...remoteStatusOptions(flags),
  };
}

async function readRemoteStatus(flags, backendClient) {
  return backendClient.readStatus(remoteStatusFilters(flags));
}

async function readLocalStatus(statePath, flags) {
  const snapshot = await readState(statePath);
  if (!snapshot) {return emptyResult();}
  const filters = {
    initiative: flags.initiative || undefined,
    kind: flags.kind || undefined,
    status: flags.status || undefined,
    domain: flags.domain || undefined,
    "claimed-by": flags["claimed-by"] || undefined,
    "stale-ms": parseStaleMs(flags),
    limit: parseLimit(flags),
    all: flags.all === true,
  };
  return projectStatusView({ snapshot, filters, now: Date.now() });
}

export default async function statusV2({ statePath, flags, backendClient }) {
  if (backendClient?.type === "remote") {return readRemoteStatus(flags, backendClient);}
  return readLocalStatus(statePath, flags);
}
