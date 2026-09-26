import { blockingForNode, informingForNode, knowledgeForNode, statusOf } from "./core.mjs";

function rawClaim(node) {
  if (node.claim && typeof node.claim === "object" && node.claim.by) {
    return { by: node.claim.by, at: node.claim.at ?? null };
  }
  if (node.claimed_by && node.claimed_at !== undefined) {
    return { by: node.claimed_by, at: node.claimed_at ?? null };
  }
  return null;
}

function claimTimestamp(at) {
  if (typeof at === "number") {
    return at;
  }
  if (typeof at === "string") {
    return Date.parse(at);
  }
  return NaN;
}

function contextClaim(node, staleMs, now) {
  const raw = rawClaim(node);
  if (!raw) {
    return null;
  }
  const at = claimTimestamp(raw.at);
  return { ...raw, stale: Number.isFinite(at) && now - at > staleMs };
}

function isIdentified(agent) {
  return typeof agent === "string" && agent.length > 0;
}

function hasTaskStatus(derivedStatus, status) {
  return derivedStatus === status;
}

function taskActionsByStatus(derivedStatus, identified) {
  const actions = {
    ready: [...(identified ? ["claim"] : []), "update", "add-note", "cancel"],
    in_progress: identified ? ["submit", "release", "add-note", "update"] : ["add-note"],
    submitted: [...(identified ? ["accept", "reject"] : []), "add-note"],
    done: ["add-note", ...(identified ? ["reopen"] : [])],
    canceled: ["add-note", "update"],
  };
  return actions[derivedStatus] || [];
}

function projectContextNode(node, derivedStatus, agent) {
  return {
    node: structuredClone(node),
    derived_status: derivedStatus,
    can_claim: hasTaskStatus(derivedStatus, "ready") && node.kind === "resolvable" && node.subkind === "task",
    revision: node.revision || 1,
    allowed_actions: contextAllowedActions(node, derivedStatus, isIdentified(agent)),
  };
}

function taskAllowedActions(derivedStatus, identified) {
  return taskActionsByStatus(derivedStatus, identified);
}

function gateAllowedActions(derivedStatus, identified) {
  if (derivedStatus === "open") {
    return [
      "resolve --choice <X> --rationale <Y>",
      "add-note",
      "supersede",
      ...(identified ? ["cancel"] : []),
    ];
  }
  if (derivedStatus === "resolved") {
    return ["reopen", "supersede"];
  }
  if (derivedStatus === "superseded") {
    return ["add-note"];
  }
  return [];
}

function knowledgeAllowedActions(node) {
  if ((node.status || "active") === "active") {
    return ["update", "add-note", "deprecate-knowledge"];
  }
  if (node.status === "deprecated") {
    return ["update", "add-note"];
  }
  return [];
}

function contextAllowedActions(node, derivedStatus, identified) {
  if (node.kind === "resolvable" && node.subkind === "task") {
    return taskAllowedActions(derivedStatus, identified);
  }
  if (node.kind === "resolvable" && node.subkind === "gate") {
    return gateAllowedActions(derivedStatus, identified);
  }
  if (node.kind === "knowledge") {
    return knowledgeAllowedActions(node);
  }
  return [];
}

function appendBlockerAlerts(alerts, blocking, id) {
  for (const blocker of blocking) {
    const node = blocker.node;
    if (!node || node.status !== "superseded") {
      continue;
    }
    const supersededBy = node.superseded_by || null;
    alerts.push({
      kind: "SUPERSEDED_BLOCKER",
      node_id: id,
      blocker_id: node.id,
      superseded_by: supersededBy,
      message: `blocker ${node.id} is superseded${supersededBy ? ` by ${supersededBy}` : ""}`,
    });
  }
}

function appendKnowledgeAlerts(alerts, knowledge, id) {
  for (const item of knowledge) {
    if (item.status !== "deprecated") {
      continue;
    }
    alerts.push({
      kind: "KNOWLEDGE_DEPRECATED_SOON",
      node_id: id,
      knowledge_id: item.id,
      message: `matching knowledge ${item.id} is deprecated`,
    });
  }
}

function createContextAlerts(claim, blocking, knowledge, id) {
  const alerts = [];
  if (claim?.stale) {
    alerts.push({ kind: "STALE_CLAIM", node_id: id, claimed_by: claim.by, message: `${id} claimed by ${claim.by} is stale` });
  }
  appendBlockerAlerts(alerts, blocking, id);
  appendKnowledgeAlerts(alerts, knowledge, id);
  return alerts;
}

/** Project node context, returning null for absence so adapters own errors. */
export function projectContextView({ snapshot, id, agent, staleMs = 2 * 60 * 60 * 1000, now } = {}) {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError("read-model: now epoch-ms is required");
  }
  const node = snapshot?.nodes?.[id];
  if (!node) {
    return null;
  }
  const claim = contextClaim(node, staleMs, now);
  const blocking = blockingForNode(snapshot, id);
  const knowledge = knowledgeForNode(snapshot, id);
  const informing = informingForNode(snapshot, id);
  const alerts = createContextAlerts(claim, blocking, knowledge, id);
  const derivedStatus = statusOf({ snapshot, id });
  return {
    ...projectContextNode(node, derivedStatus, agent),
    claim,
    blocking,
    knowledge,
    informing,
    alerts,
  };
}
