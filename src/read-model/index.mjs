// Canonical read-only projections over a v2 snapshot.
//
// This layer is the only place that composes graph semantics with domain
// providers. It has no filesystem, argv, mutation, or logging concerns. The
// object-shaped arguments are the canonical API; the positional form is kept
// solely so read consumers can use a stable object-shaped API.

import { incoming } from "../kernel/graph.mjs";
import {
  deriveV2,
  statusOfV2 as taskStatusOfV2,
  isSatisfiedV2,
} from "../providers/task/derivation.mjs";
import {
  gateProjection,
  isCurrent,
  supersededBy,
} from "../providers/gate/semantics.mjs";
import {
  knowledgeForNode as providerKnowledgeForNode,
  informingForNode as providerInformingForNode,
} from "../providers/knowledge/index.mjs";

function projectionArgs(input, id) {
  if (input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, "snapshot")) {
    return { snapshot: input.snapshot, id: input.id };
  }
  return { snapshot: input, id };
}

/**
 * Derive the read-model task and gate pools from an explicit snapshot.
 *
 * @param {{snapshot: object}} args
 */
export function derive({ snapshot } = {}) {
  return deriveV2(snapshot);
}

/**
 * Return the externally visible status for a node.
 *
 * Open gates are a read-model status, rather than task readiness. The task
 * provider intentionally only derives task lifecycle and readiness.
 */
export function statusOf(input, id) {
  const args = projectionArgs(input, id);
  const { snapshot } = args;
  const node = snapshot && snapshot.nodes ? snapshot.nodes[args.id] : null;
  if (node && node.kind === "resolvable" && node.subkind === "gate" && (node.status || "open") === "open") {
    return "open";
  }
  return taskStatusOfV2(snapshot, args.id);
}

/**
 * Project BLOCKS dependencies, combining kernel traversal, gate projection,
 * and task satisfaction into one read-model result.
 */
export function blockingForNode(input, id) {
  const { snapshot, id: targetId } = projectionArgs(input, id);
  return incoming(snapshot, targetId, "BLOCKS").map((edge) => ({
    edge_type: edge.type,
    node: gateProjection(snapshot, edge.from),
    satisfied: isSatisfiedV2(snapshot, edge.from),
  }));
}

/** Project knowledge matching the target node's explicit scopes. */
export function knowledgeForNode(input, id) {
  const { snapshot, id: targetId } = projectionArgs(input, id);
  return providerKnowledgeForNode({ snapshot, id: targetId });
}

/** Project INFORMS relations as inline nodes. */
export function informingForNode(input, id) {
  const { snapshot, id: targetId } = projectionArgs(input, id);
  return providerInformingForNode({ snapshot, id: targetId });
}

// Descriptive aliases for new consumers. The V2 names are retained only as
// compatibility aliases for callers that use the versioned state vocabulary.
export const deriveReadModel = derive;
export const statusOfV2 = statusOf;
export const projectStatus = statusOf;
export const projectBlocking = blockingForNode;
export const projectKnowledge = knowledgeForNode;
export const projectInforming = informingForNode;

function claimBy(node) {
  if (node?.claim && typeof node.claim === "object" && node.claim.by) return node.claim.by;
  return node?.claimed_by || null;
}

function claimAtMs(node) {
  const at = (node?.claim && node.claim.at) || node?.claimed_at;
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

function requireNow(now) {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError("read-model: now epoch-ms is required");
  }
}

/** Project the status view from one snapshot and a request-sampled epoch-ms. */
export function projectStatusView({ snapshot, filters = {}, now } = {}) {
  requireNow(now);
  const nodes = snapshot?.nodes || {};
  const derived = derive({ snapshot });
  const all = filters.all === true;
  const initiative = filters.initiative || null;
  const domain = filters.domain || null;
  const kind = filters.kind || null;
  const status = filters.status || null;
  const claimedBy = filters["claimed-by"] || null;
  const staleMs = filters["stale-ms"] === undefined ? 2 * 60 * 60 * 1000 : filters["stale-ms"];
  const limit = filters.limit === undefined ? null : filters.limit;
  const filterPool = (id) => {
    const node = nodes[id];
    if (!node) return false;
    if (initiative && node.initiative !== initiative) return false;
    if (domain && node.domain !== domain) return false;
    if (kind && node.kind !== kind) return false;
    if (status && (node.status || "open") !== status && statusOf({ snapshot, id }) !== status) return false;
    return true;
  };
  const ready = derived.ready.filter(filterPool);
  const blocked = derived.blocked.filter(filterPool);
  const backlog = derived.backlog.filter(filterPool);
  const selectTasks = (taskStatus) => Object.values(nodes)
    .filter((node) => node.kind === "resolvable" && node.subkind === "task" && (node.status || "open") === taskStatus)
    .filter((node) => !initiative || node.initiative === initiative)
    .filter((node) => !domain || node.domain === domain)
    .filter((node) => !kind || node.kind === kind)
    .map((node) => node.id);
  const submittedAll = selectTasks("submitted");
  const submitted = status ? (status === "submitted" ? submittedAll : []) : submittedAll;
  const inProgressAll = selectTasks("in_progress");
  const inProgress = status ? (status === "in_progress" ? inProgressAll : [])
    : claimedBy ? inProgressAll.filter((id) => claimBy(nodes[id]) === claimedBy) : inProgressAll;
  const openGatesAll = (derived.openGates || []).filter((id) => {
    const node = nodes[id];
    return !!node && (!initiative || node.initiative === initiative) && (!kind || node.kind === "resolvable");
  });
  const openGates = status ? openGatesAll.filter(() => status === "open") : openGatesAll;
  const knowledge = Object.values(nodes).filter((node) => node.kind === "knowledge")
    .filter((node) => (!initiative || node.initiative === initiative) && (!kind || node.kind === "knowledge"));
  const activeKnowledge = knowledge.filter((node) => (node.status || "active") === "active").length;
  const cap = (items) => limit === null ? items : items.slice(0, limit);
  const result = {
    summary: {
      ready: ready.length,
      in_progress: inProgress.length,
      submitted: submitted.length,
      blocked: blocked.length,
      backlog: backlog.length,
      open_gates: openGates.length,
      active_knowledge: activeKnowledge,
    },
    tasks: {
      ready: cap(ready).map((id) => nodeSummary(nodes[id])),
      in_progress: cap(inProgress).map((id) => nodeSummary(nodes[id])),
      submitted: cap(submitted).map((id) => nodeSummary(nodes[id])),
      blocked: cap(blocked).map((id) => ({
        ...nodeSummary(nodes[id]),
        unsatisfied_blockers: blockingForNode(snapshot, id).filter((blocker) => blocker.satisfied === false)
          .map((blocker) => blocker.node && blocker.node.id).filter(Boolean),
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
  for (const node of Object.values(nodes)) {
    if (node.kind !== "resolvable" || node.subkind !== "task" || (node.status || "open") !== "in_progress") continue;
    if (initiative && node.initiative !== initiative) continue;
    const at = claimAtMs(node);
    const by = claimBy(node);
    const age = at === null ? null : now - at;
    if (age === null || !by || age <= staleMs || (claimedBy && by !== claimedBy)) continue;
    result.alerts.push({
      kind: "stale-claim",
      severity: "warning",
      task_id: node.id,
      claimed_by: by,
      age_ms: age,
      message: `${node.id} claimed by ${by} is stale (${Math.round(age / 60000)}m old)`,
    });
  }
  if (all) {
    const onInitiative = (node) => !initiative || node.initiative === initiative;
    const done = Object.values(nodes).filter((node) => node.kind === "resolvable" && node.subkind === "task" && node.status === "done" && onInitiative(node));
    const canceled = Object.values(nodes).filter((node) => node.kind === "resolvable" && node.subkind === "task" && node.status === "canceled" && onInitiative(node));
    const resolved = Object.values(nodes).filter((node) => node.kind === "resolvable" && node.subkind === "gate" && node.status === "resolved" && onInitiative(node));
    const superseded = Object.values(nodes).filter((node) => node.status === "superseded" && onInitiative(node));
    const deprecated = knowledge.filter((node) => node.status === "deprecated");
    result.done = { tasks: done.map(nodeSummary) };
    result.canceled = { tasks: canceled.map(nodeSummary) };
    result.resolved = { gates: resolved.map(nodeSummary) };
    result.superseded = { nodes: superseded.map(nodeSummary) };
    result.deprecated = { knowledge: deprecated.map((node) => ({
      id: node.id,
      title: node.title || "",
      deprecation_reason: node.deprecation_reason,
      deprecated_at: node.deprecated_at,
      deprecated_by: node.deprecated_by,
    })) };
  }
  return result;
}

function contextClaim(node, staleMs, now) {
  const raw = node.claim && typeof node.claim === "object" && node.claim.by
    ? { by: node.claim.by, at: node.claim.at ?? null }
    : node.claimed_by && node.claimed_at !== undefined ? { by: node.claimed_by, at: node.claimed_at ?? null } : null;
  if (!raw) return null;
  const at = typeof raw.at === "number" ? raw.at : typeof raw.at === "string" ? Date.parse(raw.at) : NaN;
  return { ...raw, stale: Number.isFinite(at) && now - at > staleMs };
}

function contextAllowedActions(node, derivedStatus, identified) {
  const actions = [];
  if (node.kind === "resolvable" && node.subkind === "task") {
    if (derivedStatus === "ready") { if (identified) actions.push("claim"); actions.push("update", "add-note", "cancel"); }
    else if (derivedStatus === "in_progress") { if (identified) actions.push("submit", "release", "add-note", "update"); else actions.push("add-note"); }
    else if (derivedStatus === "submitted") { if (identified) actions.push("accept", "reject"); actions.push("add-note"); }
    else if (derivedStatus === "done") { actions.push("add-note"); if (identified) actions.push("reopen"); }
    else if (derivedStatus === "canceled") actions.push("add-note", "update");
  } else if (node.kind === "resolvable" && node.subkind === "gate") {
    if (derivedStatus === "open") { actions.push("resolve --choice <X> --rationale <Y>", "add-note", "supersede"); if (identified) actions.push("cancel"); }
    else if (derivedStatus === "resolved") actions.push("reopen", "supersede");
    else if (derivedStatus === "superseded") actions.push("add-note");
  } else if (node.kind === "knowledge") {
    if ((node.status || "active") === "active") actions.push("update", "add-note", "deprecate-knowledge");
    else if (node.status === "deprecated") actions.push("update", "add-note");
  }
  return actions;
}

/** Project a node context, returning null for absence so adapters own errors. */
export function projectContextView({ snapshot, id, agent, staleMs = 2 * 60 * 60 * 1000, now } = {}) {
  requireNow(now);
  const node = snapshot?.nodes?.[id];
  if (!node) return null;
  const claim = contextClaim(node, staleMs, now);
  const blocking = blockingForNode(snapshot, id);
  const knowledge = knowledgeForNode(snapshot, id);
  const informing = informingForNode(snapshot, id);
  const alerts = [];
  if (claim?.stale) alerts.push({ kind: "STALE_CLAIM", node_id: id, claimed_by: claim.by, message: `${id} claimed by ${claim.by} is stale` });
  for (const blocker of blocking) {
    const bn = blocker.node;
    if (bn && bn.status === "superseded") alerts.push({ kind: "SUPERSEDED_BLOCKER", node_id: id, blocker_id: bn.id, superseded_by: bn.superseded_by || null, message: `blocker ${bn.id} is superseded${bn.superseded_by ? ` by ${bn.superseded_by}` : ""}` });
  }
  for (const item of knowledge) if (item.status === "deprecated") alerts.push({ kind: "KNOWLEDGE_DEPRECATED_SOON", node_id: id, knowledge_id: item.id, message: `matching knowledge ${item.id} is deprecated` });
  const derivedStatus = statusOf({ snapshot, id });
  return {
    node: structuredClone(node),
    derived_status: derivedStatus,
    can_claim: derivedStatus === "ready" && node.kind === "resolvable" && node.subkind === "task",
    revision: node.revision || 1,
    claim,
    blocking,
    knowledge,
    informing,
    alerts,
    allowed_actions: contextAllowedActions(node, derivedStatus, typeof agent === "string" && agent.length > 0),
  };
}

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function clone(value) {
  return structuredClone(value);
}

/**
 * Project one serialized state read for a public plugin query.
 *
 * The state is deliberately passed in by the caller so all fields in the
 * result are derived from the same read. Core nodes are copied without other
 * plugins' node namespaces; the selected plugin namespace is exposed in the
 * root and on the nodes that contain it. Rebuilding records in sorted order
 * and sorting edge triples makes JSON output repeatable for the same state.
 */
export function projectSnapshot({ snapshot, pluginId } = {}) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  const sourceNodes = source.nodes && typeof source.nodes === "object" ? source.nodes : {};
  const nodes = {};
  const nodeIds = Object.keys(sourceNodes).sort(compareText);

  for (const id of nodeIds) {
    const sourceNode = sourceNodes[id];
    if (!sourceNode || typeof sourceNode !== "object" || Array.isArray(sourceNode)) continue;
    const node = clone(sourceNode);
    const nodePlugins = node.plugins;
    delete node.plugins;
    if (pluginId && nodePlugins && typeof nodePlugins === "object" &&
        Object.prototype.hasOwnProperty.call(nodePlugins, pluginId)) {
      node.plugins = { [pluginId]: clone(nodePlugins[pluginId]) };
    }
    nodes[id] = node;
  }

  const edges = (Array.isArray(source.edges) ? source.edges : [])
    .filter((edge) => edge && typeof edge === "object" && !Array.isArray(edge))
    .map(clone)
    .sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to) || compareText(a.type, b.type));

  const derived = {};
  for (const id of nodeIds) {
    if (Object.prototype.hasOwnProperty.call(nodes, id)) {
      derived[id] = statusOf({ snapshot: source, id });
    }
  }

  const plugins = {};
  const sourcePlugins = source.plugins && typeof source.plugins === "object" ? source.plugins : {};
  if (pluginId && Object.prototype.hasOwnProperty.call(sourcePlugins, pluginId)) {
    plugins[pluginId] = clone(sourcePlugins[pluginId]);
  }

  return {
    revision: Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
    nodes,
    edges,
    derived,
    plugins,
  };
}

export { deriveV2, isSatisfiedV2 };
export {
  gateProjection,
  isCurrent,
  supersededBy,
};
