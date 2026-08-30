// Read-only query adapters for the plugin host.
//
// Query methods deliberately read the latest serialized snapshot without a
// lock. They use the canonical read-model for graph/domain projections and do
// not depend on CLI command adapters or the transitional v2 facade.

import { readState, isV2State, assertStateVersion } from "../storage/state.mjs";
import { throwV2 } from "../contracts/errors.mjs";
import {
  derive,
  statusOf,
  blockingForNode,
  knowledgeForNode,
  informingForNode,
  isCurrent,
  supersededBy,
} from "../read-model/index.mjs";
import {
  detectOwnershipConflicts,
  executionContractFor,
} from "../contracts/execution-contract.mjs";

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

function claimBy(node) {
  if (!node) return null;
  if (node.claim && typeof node.claim === "object" && node.claim.by) return node.claim.by;
  return node.claimed_by || null;
}

function claimAtMs(node) {
  if (!node) return null;
  const at = (node.claim && node.claim.at) || node.claimed_at;
  if (at == null) return null;
  if (typeof at === "number") return at;
  if (typeof at === "string") {
    const ms = Date.parse(at);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function nodeSummary(node) {
  return {
    id: node.id,
    kind: node.kind,
    subkind: node.subkind,
    title: node.title || "",
    status: node.status || "open",
    initiative: node.initiative,
    domain: node.domain,
    claimed_by: claimBy(node),
  };
}

function staleClaims(snapshot, staleMs, initiative) {
  const now = Date.now();
  return Object.values(snapshot.nodes || {})
    .filter((node) => node.kind === "resolvable" && node.subkind === "task")
    .filter((node) => !initiative || node.initiative === initiative)
    .filter((node) => (node.status || "open") === "in_progress")
    .map((node) => ({ node, at: claimAtMs(node), by: claimBy(node) }))
    .filter(({ at, by }) => at !== null && !!by && now - at > staleMs)
    .map(({ node, at, by }) => ({
      id: node.id,
      claimed_by: by,
      age_ms: now - at,
      title: node.title || "",
    }));
}

function emptyStatus() {
  return {
    summary: { ready: 0, in_progress: 0, blocked: 0, backlog: 0, open_gates: 0, active_knowledge: 0 },
    tasks: { ready: [], in_progress: [], blocked: [], backlog: [] },
    gates: { open: [] },
    knowledge_count: 0,
    alerts: [],
  };
}

function statusView(snapshot, flags) {
  const nodes = snapshot.nodes || {};
  const derived = derive({ snapshot });
  const all = flags.all === true;
  const initiative = flags.initiative || null;
  const domain = flags.domain || null;
  const kind = flags.kind || null;
  const status = flags.status || null;
  const claimedBy = flags["claimed-by"] || null;
  const staleMs = parseStaleMs(flags["stale-ms"]);
  const limit = parseLimit(flags.limit);
  const matches = (id) => {
    const node = nodes[id];
    if (!node) return false;
    if (initiative && node.initiative !== initiative) return false;
    if (domain && node.domain !== domain) return false;
    if (kind && node.kind !== kind) return false;
    if (status && (node.status || "open") !== status && statusOf({ snapshot, id }) !== status) return false;
    return true;
  };
  const ready = derived.ready.filter(matches);
  const blocked = derived.blocked.filter(matches);
  const backlog = derived.backlog.filter(matches);
  const inProgress = Object.values(nodes)
    .filter((node) => node.kind === "resolvable" && node.subkind === "task" && (node.status || "open") === "in_progress")
    .filter((node) => !initiative || node.initiative === initiative)
    .filter((node) => !domain || node.domain === domain)
    .filter((node) => !kind || node.kind === kind)
    .map((node) => node.id);
  let scopedInProgress;
  if (status) scopedInProgress = status === "in_progress" ? inProgress : [];
  else if (claimedBy) scopedInProgress = inProgress.filter((id) => claimBy(nodes[id]) === claimedBy);
  else scopedInProgress = inProgress;
  const openGatesAll = (derived.openGates || []).filter((id) => {
    const node = nodes[id];
    return node && (!initiative || node.initiative === initiative) && (!kind || kind === "resolvable");
  });
  const openGates = status ? openGatesAll.filter(() => status === "open") : openGatesAll;
  const knowledge = Object.values(nodes).filter((node) => node.kind === "knowledge")
    .filter((node) => !initiative || node.initiative === initiative)
    .filter((node) => !kind || kind === "knowledge");
  const activeKnowledge = knowledge.filter((node) => (node.status || "active") === "active").length;
  const cap = (items) => limit === null ? items : items.slice(0, limit);
  const result = {
    summary: {
      ready: ready.length,
      in_progress: scopedInProgress.length,
      blocked: blocked.length,
      backlog: backlog.length,
      open_gates: openGates.length,
      active_knowledge: activeKnowledge,
    },
    tasks: {
      ready: cap(ready).map((id) => nodeSummary(nodes[id])),
      in_progress: cap(scopedInProgress).map((id) => nodeSummary(nodes[id])),
      blocked: cap(blocked).map((id) => ({
        ...nodeSummary(nodes[id]),
        unsatisfied_blockers: blockingForNode({ snapshot, id })
          .filter((blocker) => blocker.satisfied === false)
          .map((blocker) => blocker.node && blocker.node.id)
          .filter(Boolean),
      })),
      backlog: cap(backlog).map((id) => nodeSummary(nodes[id])),
    },
    gates: { open: cap(openGates).map((id) => nodeSummary(nodes[id])) },
    knowledge_count: knowledge.length,
    alerts: [],
  };
  if (all) {
    result.knowledge = knowledge.map((node) => ({
      id: node.id,
      title: node.title || "",
      status: node.status || "active",
      initiative: node.initiative,
      scope: node.scope || {},
      knowledge_type: node.knowledge_type,
      deprecation_reason: node.deprecation_reason,
      deprecated_at: node.deprecated_at,
      deprecated_by: node.deprecated_by,
    }));
  }
  for (const stale of staleClaims(snapshot, staleMs, initiative)) {
    if (claimedBy && stale.claimed_by !== claimedBy) continue;
    result.alerts.push({
      kind: "stale-claim",
      severity: "warning",
      task_id: stale.id,
      claimed_by: stale.claimed_by,
      age_ms: stale.age_ms,
      message: `${stale.id} claimed by ${stale.claimed_by} is stale (${Math.round(stale.age_ms / 60000)}m old)`,
    });
  }
  if (all) {
    const inScope = (node) => !initiative || node.initiative === initiative;
    result.done = { tasks: Object.values(nodes).filter((n) => n.kind === "resolvable" && n.subkind === "task" && n.status === "done" && inScope(n)).map(nodeSummary) };
    result.canceled = { tasks: Object.values(nodes).filter((n) => n.kind === "resolvable" && n.subkind === "task" && n.status === "canceled" && inScope(n)).map(nodeSummary) };
    result.resolved = { gates: Object.values(nodes).filter((n) => n.kind === "resolvable" && n.subkind === "gate" && n.status === "resolved" && inScope(n)).map(nodeSummary) };
    result.superseded = { nodes: Object.values(nodes).filter((n) => n.status === "superseded" && inScope(n)).map(nodeSummary) };
    result.deprecated = { knowledge: knowledge.filter((n) => n.status === "deprecated").map((n) => ({
      id: n.id, title: n.title || "", deprecation_reason: n.deprecation_reason,
      deprecated_at: n.deprecated_at, deprecated_by: n.deprecated_by,
    })) };
  }
  return result;
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
    if (derivedStatus === "in_progress") return anonymous ? ["add-note"] : ["resolve", "release", "add-note", "update"];
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
  const conflicts = node.kind === "resolvable" && node.subkind === "task" ? detectOwnershipConflicts(snapshot, id) : [];
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
  if (conflicts.length) alerts.push({ kind: "OWNERSHIP_CONFLICT", node_id: id, count: conflicts.length, message: `${id} has ${conflicts.length} ownership conflict(s) with other open tasks` });
  return {
    node,
    derived_status: derivedStatus,
    can_claim: derivedStatus === "ready" && node.kind === "resolvable" && node.subkind === "task",
    revision: node.revision || 1,
    claim,
    blocking,
    knowledge,
    informing: informingForNode({ snapshot, id }),
    execution_contract: executionContractFor(snapshot, id),
    ownership_conflicts: conflicts,
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

export function createQuery({ projectDir, agent }) {
  return {
    async node(id) {
      if (typeof id !== "string" || !id) throw new Error("query.node: id required");
      const snapshot = await readSnapshot(projectDir);
      if (!snapshot) throw new Error("show: state file missing");
      if (isV2State(snapshot)) {
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
      assertStateVersion(snapshot, 2, "context");
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
