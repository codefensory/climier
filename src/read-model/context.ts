import { blockingForNode, informingForNode, knowledgeForNode, statusOf } from "./core.ts";
import type { ReadModelClaim, ReadModelNode, ReadModelSnapshot } from "./types.ts";

interface ContextClaim {
  by: string | null;
  at: string | number | null;
  stale?: boolean;
}

interface ContextAlert {
  kind: string;
  node_id: string;
  message: string;
  [key: string]: unknown;
}

function rawClaim(node: ReadModelNode): ContextClaim | null {
  if (node.claim && typeof node.claim === "object" && node.claim.by) {
    return { by: node.claim.by, at: node.claim.at ?? null };
  }
  if (node.claimed_by && node.claimed_at !== undefined) {
    return { by: node.claimed_by, at: node.claimed_at ?? null };
  }
  return null;
}

function claimTimestamp(at: ReadModelClaim["at"]): number {
  if (typeof at === "number") {
    return at;
  }
  if (typeof at === "string") {
    return Date.parse(at);
  }
  return NaN;
}

function contextClaim(node: ReadModelNode, staleMs: number, now: number): ContextClaim | null {
  const raw = rawClaim(node);
  if (!raw) {
    return null;
  }
  const at = claimTimestamp(raw.at);
  return { ...raw, stale: Number.isFinite(at) && now - at > staleMs };
}

function isIdentified(agent: unknown): agent is string {
  return typeof agent === "string" && agent.length > 0;
}

function hasTaskStatus(derivedStatus: string, status: string): boolean {
  return derivedStatus === status;
}

function taskActionsByStatus(derivedStatus: string, identified: boolean): string[] {
  const actions = {
    ready: [...(identified ? ["claim"] : []), "update", "add-note", "cancel"],
    in_progress: identified ? ["submit", "release", "add-note", "update"] : ["add-note"],
    submitted: [...(identified ? ["accept", "reject"] : []), "add-note"],
    done: ["add-note", ...(identified ? ["reopen"] : [])],
    canceled: ["add-note", "update"],
  };
  return actions[derivedStatus] || [];
}

function projectContextNode(node: ReadModelNode, derivedStatus: string, agent: unknown) {
  return {
    node: structuredClone(node),
    derived_status: derivedStatus,
    can_claim: hasTaskStatus(derivedStatus, "ready") && node.kind === "resolvable" && node.subkind === "task",
    revision: node.revision || 1,
    allowed_actions: contextAllowedActions(node, derivedStatus, isIdentified(agent)),
  };
}

function taskAllowedActions(derivedStatus: string, identified: boolean): string[] {
  return taskActionsByStatus(derivedStatus, identified);
}

function gateAllowedActions(derivedStatus: string, identified: boolean): string[] {
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

function knowledgeAllowedActions(node: ReadModelNode): string[] {
  if ((node.status || "active") === "active") {
    return ["update", "add-note", "deprecate-knowledge"];
  }
  if (node.status === "deprecated") {
    return ["update", "add-note"];
  }
  return [];
}

function contextAllowedActions(node: ReadModelNode, derivedStatus: string, identified: boolean): string[] {
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

function appendBlockerAlerts(alerts: ContextAlert[], blocking: Array<{ node?: ReadModelNode }>, id: string): void {
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

function appendKnowledgeAlerts(alerts: ContextAlert[], knowledge: ReadModelNode[], id: string): void {
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

function createContextAlerts(
  claim: ContextClaim | null,
  blocking: Array<{ node?: ReadModelNode }>,
  knowledge: ReadModelNode[],
  id: string,
): ContextAlert[] {
  const alerts: ContextAlert[] = [];
  if (claim?.stale) {
    alerts.push({ kind: "STALE_CLAIM", node_id: id, claimed_by: claim.by, message: `${id} claimed by ${claim.by} is stale` });
  }
  appendBlockerAlerts(alerts, blocking, id);
  appendKnowledgeAlerts(alerts, knowledge, id);
  return alerts;
}


interface ProjectContextArgs {
  snapshot?: ReadModelSnapshot;
  id?: string;
  agent?: unknown;
  staleMs?: number;
  now?: number;
}

export function projectContextView({ snapshot, id, agent, staleMs = 2 * 60 * 60 * 1000, now }: ProjectContextArgs = {}) {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError("read-model: now epoch-ms is required");
  }
  const node = snapshot?.nodes?.[id as string];
  if (!node) {
    return null;
  }
  const claim = contextClaim(node, staleMs, now);
  const blocking = blockingForNode(snapshot, id as string);
  const knowledge = knowledgeForNode(snapshot, id as string);
  const informing = informingForNode(snapshot, id as string);
  const alerts = createContextAlerts(claim, blocking, knowledge, id as string);
  const derivedStatus = statusOf({ snapshot, id: id as string });
  return {
    ...projectContextNode(node, derivedStatus, agent),
    claim,
    blocking,
    knowledge,
    informing,
    alerts,
  };
}
