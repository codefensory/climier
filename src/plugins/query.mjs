// Read-only query adapters for the plugin host.
//
// Query methods deliberately read the latest serialized snapshot without a
// lock. They use the canonical read-model for graph/domain projections and do
// not depend on CLI command adapters or the transitional v2 facade.

import { readState, isFencedState, isV2State, assertStateVersion } from "../storage/state.mjs";
import { assertLocalBackend } from "./remote-guard.mjs";
import { throwV2 } from "../contracts/errors.mjs";
import {
  statusOf,
  blockingForNode,
  knowledgeForNode,
  informingForNode,
  projectSnapshot,
  projectStatusView,
} from "../read-model/index.mjs";

const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;
const STATUS_FLAGS = new Set([
  "initiative", "kind", "status", "domain", "claimed-by", "stale-ms", "limit", "all", "as",
]);
const HISTORY_FLAGS = new Set(["limit"]);

function asFlags(options, allowed) {
  const flags = {};
  if (!options || typeof options !== "object") return flags;
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key)) {
      const sorted = [...allowed].sort();
      throw new Error(`query: unknown option '${key}' (allowed: ${sorted.join(", ")})`);
    }
    flags[key] = value;
  }
  return flags;
}

function parseStaleMs(value) {
  if (value === undefined || value === true) return DEFAULT_STALE_MS;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`status: --stale-ms must be a non-negative integer (got '${value}')`);
  }
  return n;
}

function parseLimit(value) {
  if (value === undefined || value === true) return null;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`query.status: --limit must be a non-negative integer (got '${value}')`);
  }
  return n;
}

function emptyStatus() {
  return {
    summary: { ready: 0, in_progress: 0, submitted: 0, blocked: 0, backlog: 0, open_gates: 0, active_knowledge: 0 },
    tasks: { ready: [], in_progress: [], submitted: [], blocked: [], backlog: [] },
    gates: { open: [] },
    knowledge_count: 0,
    alerts: [],
  };
}

function statusView(snapshot, flags) {
  const staleMs = parseStaleMs(flags["stale-ms"]);
  const limit = parseLimit(flags.limit);
  return projectStatusView({
    snapshot,
    filters: { ...flags, "stale-ms": staleMs, limit },
    now: Date.now(),
  });
}

function parseAtMs(at) {
  if (at == null) return null;
  if (typeof at === "number") return at;
  if (typeof at === "string") {
    const ms = Date.parse(at);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function claimFor(node, staleMs) {
  if (node.claim && typeof node.claim === "object" && node.claim.by) {
    const atMs = parseAtMs(node.claim.at);
    return { by: node.claim.by, at: node.claim.at ?? null, stale: atMs !== null && Date.now() - atMs > staleMs };
  }
  if (node.claimed_by && node.claimed_at !== undefined) {
    const atMs = parseAtMs(node.claimed_at);
    return { by: node.claimed_by, at: node.claimed_at ?? null, stale: atMs !== null && Date.now() - atMs > staleMs };
  }
  return null;
}

function allowedActions(node, derivedStatus, agent) {
  if (!node) return [];
  const anonymous = !agent;
  if (node.kind === "resolvable" && node.subkind === "task") {
    if (derivedStatus === "ready") return [...(anonymous ? [] : ["claim"]), "update", "add-note", "cancel"];
    if (derivedStatus === "in_progress") return anonymous ? ["add-note"] : ["submit", "release", "add-note", "update"];
    if (derivedStatus === "submitted") return anonymous ? ["add-note"] : ["accept", "reject", "add-note"];
    if (derivedStatus === "done") return ["add-note", ...(anonymous ? [] : ["reopen"] )];
    if (derivedStatus === "canceled") return ["add-note", "update"];
  }
  if (node.kind === "resolvable" && node.subkind === "gate") {
    if (derivedStatus === "open") return ["resolve --choice <X> --rationale <Y>", "add-note", "supersede", ...(anonymous ? [] : ["cancel"] )];
    if (derivedStatus === "resolved") return ["reopen", "supersede"];
    if (derivedStatus === "superseded") return ["add-note"];
  }
  if (node.kind === "knowledge") {
    return (node.status || "active") === "active"
      ? ["update", "add-note", "deprecate-knowledge"]
      : ["update", "add-note"];
  }
  return [];
}

function contextView(snapshot, id, agent) {
  const node = snapshot.nodes[id];
  if (!node) throwV2("NODE_NOT_FOUND", `query.context: node ${id} not found`, { id });
  const claim = claimFor(node, DEFAULT_STALE_MS);
  const blocking = blockingForNode({ snapshot, id });
  const knowledge = knowledgeForNode({ snapshot, id });
  const derivedStatus = statusOf({ snapshot, id });
  const alerts = [];
  if (claim && claim.stale) alerts.push({ kind: "STALE_CLAIM", node_id: id, claimed_by: claim.by, message: `${id} claimed by ${claim.by} is stale` });
  for (const blocker of blocking) {
    if (blocker.node && blocker.node.status === "superseded") {
      alerts.push({ kind: "SUPERSEDED_BLOCKER", node_id: id, blocker_id: blocker.node.id, superseded_by: blocker.node.superseded_by || null,
        message: `blocker ${blocker.node.id} is superseded${blocker.node.superseded_by ? ` by ${blocker.node.superseded_by}` : ""}` });
    }
  }
  for (const item of knowledge) {
    if (item.status === "deprecated") alerts.push({ kind: "KNOWLEDGE_DEPRECATED_SOON", node_id: id, knowledge_id: item.id, message: `matching knowledge ${item.id} is deprecated` });
  }
  return {
    node,
    derived_status: derivedStatus,
    can_claim: derivedStatus === "ready" && node.kind === "resolvable" && node.subkind === "task",
    revision: node.revision || 1,
    claim,
    blocking,
    knowledge,
    informing: informingForNode({ snapshot, id }),
    alerts,
    allowed_actions: allowedActions(node, derivedStatus, agent),
  };
}

function entryReferencesId(entry, id) {
  return !!entry && !!id && (
    entry.node === id || entry.task === id || entry.decision === id || entry.gotcha === id ||
    (typeof entry.note === "string" && entry.note.split(/\s+/).includes(id))
  );
}

async function readSnapshot(projectDir) {
  return readState(projectDir);
}

export function createQuery({ projectDir, agent, pluginId, backendClient }) {
  assertLocalBackend(backendClient, "createQuery");
  return {
    async snapshot() {
      const snapshot = await readSnapshot(projectDir);
      return projectSnapshot({ snapshot, pluginId });
    },
    async node(id) {
      if (typeof id !== "string" || !id) throw new Error("query.node: id required");
      const snapshot = await readSnapshot(projectDir);
      if (!snapshot) throw new Error("show: state file missing");
      if (isV2State(snapshot) || isFencedState(snapshot)) {
        const node = snapshot.nodes[id];
        if (!node) throwV2("NODE_NOT_FOUND", `show: ${id} not found`, { id });
        return { type: node.subkind || node.kind, node };
      }
      if (snapshot.tasks && snapshot.tasks[id]) return { type: "task", node: snapshot.tasks[id] };
      if (snapshot.decisions && snapshot.decisions[id]) return { type: "decision", node: { status: "open", ...snapshot.decisions[id] } };
      if (snapshot.gotchas && snapshot.gotchas[id]) return { type: "gotcha", node: { status: "active", ...snapshot.gotchas[id] } };
      throw new Error(`show: ${id} not found (no task, decision, or gotcha with that id)`);
    },
    async context(id) {
      if (typeof id !== "string" || !id) throw new Error("query.context: id required");
      const snapshot = await readSnapshot(projectDir);
      if (!snapshot) throw new Error("context: state file missing");
      assertStateVersion(snapshot, isFencedState(snapshot) ? 5 : 2, "context");
      return contextView(snapshot, id, typeof agent === "string" && agent ? agent : null);
    },
    async status(options) {
      const flags = asFlags(options || {}, STATUS_FLAGS);
      const snapshot = await readSnapshot(projectDir);
      if (!snapshot) return emptyStatus();
      return statusView(snapshot, flags);
    },
    async history(id, options) {
      if (typeof id !== "string" || !id) throw new Error("query.history: id required");
      const flags = asFlags(options || {}, HISTORY_FLAGS);
      const snapshot = await readSnapshot(projectDir);
      if (!snapshot) return { id, entries: [] };
      let entries = (snapshot.log || []).filter((entry) => entryReferencesId(entry, id));
      if (flags.limit !== undefined && flags.limit !== true) {
        const limit = Number.parseInt(flags.limit, 10);
        if (Number.isNaN(limit) || limit < 0) throw new Error(`history: --limit must be a non-negative integer (got '${flags.limit}')`);
        if (limit > 0) entries = entries.slice(-limit);
      }
      return { id, entries };
    },
  };
}
