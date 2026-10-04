
import { readState, assertReadableState } from "../storage/state.mjs";
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
  if (!options || typeof options !== "object") {
    return flags;
  }
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key)) {
      const sorted = [...allowed].toSorted();
      throw new Error(`query: unknown option '${key}' (allowed: ${sorted.join(", ")})`);
    }
    flags[key] = value;
  }
  return flags;
}

function parseStaleMs(value) {
  if (value === undefined || value === true) {
    return DEFAULT_STALE_MS;
  }
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`status: --stale-ms must be a non-negative integer (got '${value}')`);
  }
  return n;
}

function parseLimit(value) {
  if (value === undefined || value === true) {
    return null;
  }
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
  if (at === null || at === undefined) {
    return null;
  }
  if (typeof at === "number") {
    return at;
  }
  if (typeof at === "string") {
    const ms = Date.parse(at);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function claimValue(node) {
  if (node.claim && typeof node.claim === "object" && node.claim.by) {
    return { by: node.claim.by, at: node.claim.at };
  }
  if (node.claimed_by && node.claimed_at !== undefined) {
    return { by: node.claimed_by, at: node.claimed_at };
  }
  return null;
}

function claimFor(node, staleMs) {
  const claim = claimValue(node);
  if (!claim) {
    return null;
  }
  const atMs = parseAtMs(claim.at);
  return {
    by: claim.by,
    at: claim.at ?? null,
    stale: atMs !== null && Date.now() - atMs > staleMs,
  };
}

function readyTaskActions(anonymous) {
  return [...(anonymous ? [] : ["claim"]), "update", "add-note", "cancel"];
}

function inProgressTaskActions(anonymous) {
  return anonymous ? ["add-note"] : ["submit", "release", "add-note", "update"];
}

function submittedTaskActions(anonymous) {
  return anonymous ? ["add-note"] : ["accept", "reject", "add-note"];
}

function doneTaskActions(anonymous) {
  return ["add-note", ...(anonymous ? [] : ["reopen"])];
}

const TASK_ACTIONS = {
  ready: readyTaskActions,
  in_progress: inProgressTaskActions,
  submitted: submittedTaskActions,
  done: doneTaskActions,
  canceled: () => ["add-note", "update"],
};

function taskActions(derivedStatus, anonymous) {
  return Object.hasOwn(TASK_ACTIONS, derivedStatus)
    ? TASK_ACTIONS[derivedStatus](anonymous)
    : [];
}

function openGateActions(anonymous) {
  return ["resolve --choice <X> --rationale <Y>", "add-note", "supersede", ...(anonymous ? [] : ["cancel"] )];
}

const GATE_ACTIONS = {
  open: openGateActions,
  resolved: () => ["reopen", "supersede"],
  superseded: () => ["add-note"],
};

function gateActions(derivedStatus, anonymous) {
  return Object.hasOwn(GATE_ACTIONS, derivedStatus)
    ? GATE_ACTIONS[derivedStatus](anonymous)
    : [];
}

function allowedActions(node, derivedStatus, agent) {
  if (!node) {
    return [];
  }
  const anonymous = !agent;
  if (node.kind === "resolvable") {
    return node.subkind === "task"
      ? taskActions(derivedStatus, anonymous)
      : gateActions(derivedStatus, anonymous);
  }
  if (node.kind === "knowledge") {
    return (node.status || "active") === "active"
      ? ["update", "add-note", "deprecate-knowledge"]
      : ["update", "add-note"];
  }
  return [];
}

function staleClaimAlert(id, claim) {
  if (!claim || !claim.stale) {
    return null;
  }
  return {
    kind: "STALE_CLAIM",
    node_id: id,
    claimed_by: claim.by,
    message: `${id} claimed by ${claim.by} is stale`,
  };
}

function supersededBlockerAlert(id, blocker) {
  if (!blocker.node || blocker.node.status !== "superseded") {
    return null;
  }
  return {
    kind: "SUPERSEDED_BLOCKER",
    node_id: id,
    blocker_id: blocker.node.id,
    superseded_by: blocker.node.superseded_by || null,
    message: `blocker ${blocker.node.id} is superseded${blocker.node.superseded_by ? ` by ${blocker.node.superseded_by}` : ""}`,
  };
}

function deprecatedKnowledgeAlert(id, item) {
  if (item.status !== "deprecated") {
    return null;
  }
  return {
    kind: "KNOWLEDGE_DEPRECATED_SOON",
    node_id: id,
    knowledge_id: item.id,
    message: `matching knowledge ${item.id} is deprecated`,
  };
}

function contextAlerts(id, claim, blocking, knowledge) {
  return [
    staleClaimAlert(id, claim),
    ...blocking.map((blocker) => supersededBlockerAlert(id, blocker)),
    ...knowledge.map((item) => deprecatedKnowledgeAlert(id, item)),
  ].filter(Boolean);
}

function contextView(snapshot, id, agent) {
  const node = snapshot.nodes[id];
  if (!node) {
    throwV2("NODE_NOT_FOUND", `query.context: node ${id} not found`, { id });
  }
  const claim = claimFor(node, DEFAULT_STALE_MS);
  const blocking = blockingForNode({ snapshot, id });
  const knowledge = knowledgeForNode({ snapshot, id });
  const derivedStatus = statusOf({ snapshot, id });
  return {
    node,
    derived_status: derivedStatus,
    can_claim: derivedStatus === "ready" && node.kind === "resolvable" && node.subkind === "task",
    revision: node.revision || 1,
    claim,
    blocking,
    knowledge,
    informing: informingForNode({ snapshot, id }),
    alerts: contextAlerts(id, claim, blocking, knowledge),
    allowed_actions: allowedActions(node, derivedStatus, agent),
  };
}

function entryReferencesId(entry, id) {
  return Boolean(entry) && Boolean(id) && (
    entry.node === id ||
    (typeof entry.note === "string" && entry.note.split(/\s+/).includes(id))
  );
}

async function readSnapshot(projectDir) {
  return readState(projectDir);
}

function nodeById(snapshot, id) {
  const node = snapshot.nodes[id];
  if (!node) {
    throwV2("NODE_NOT_FOUND", `show: ${id} not found`, { id });
  }
  return { type: node.subkind || node.kind, node };
}

async function queryNode(projectDir, id) {
  if (typeof id !== "string" || !id) {
    throw new Error("query.node: id required");
  }
  const snapshot = await readSnapshot(projectDir);
  if (!snapshot) {
    throw new Error("show: state file missing");
  }
  return nodeById(snapshot, id);
}

async function queryContext(projectDir, id, agent) {
  if (typeof id !== "string" || !id) {
    throw new Error("query.context: id required");
  }
  const snapshot = await readSnapshot(projectDir);
  if (!snapshot) {
    throw new Error("context: state file missing");
  }
  assertReadableState(snapshot, "context");
  return contextView(snapshot, id, typeof agent === "string" && agent ? agent : null);
}

async function queryStatus(projectDir, options) {
  const flags = asFlags(options || {}, STATUS_FLAGS);
  const snapshot = await readSnapshot(projectDir);
  if (!snapshot) {
    return emptyStatus();
  }
  return statusView(snapshot, flags);
}

function parseHistoryLimit(value) {
  if (value === undefined || value === true) {
    return null;
  }
  const limit = Number.parseInt(value, 10);
  if (Number.isNaN(limit) || limit < 0) {
    throw new Error(`history: --limit must be a non-negative integer (got '${value}')`);
  }
  return limit;
}

async function queryHistory(projectDir, id, options) {
  if (typeof id !== "string" || !id) {
    throw new Error("query.history: id required");
  }
  const flags = asFlags(options || {}, HISTORY_FLAGS);
  const snapshot = await readSnapshot(projectDir);
  if (!snapshot) {
    return { id, entries: [] };
  }
  let entries = (snapshot.log || []).filter((entry) => entryReferencesId(entry, id));
  const limit = parseHistoryLimit(flags.limit);
  if (limit > 0) {
    entries = entries.slice(-limit);
  }
  return { id, entries };
}

export function createQuery({ projectDir, agent, pluginId, backendClient }) {
  assertLocalBackend(backendClient, "createQuery");
  return {
    async snapshot() {
      const snapshot = await readSnapshot(projectDir);
      return projectSnapshot({ snapshot, pluginId });
    },
    node(id) {
      return queryNode(projectDir, id);
    },
    context(id) {
      return queryContext(projectDir, id, agent);
    },
    status(options) {
      return queryStatus(projectDir, options);
    },
    history(id, options) {
      return queryHistory(projectDir, id, options);
    },
  };
}
