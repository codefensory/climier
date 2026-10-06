// Pure mutation log construction boundary.
// The kernel owns the audit identity and structural metadata. Providers may
// contribute only the allow-listed operation-specific fields. This module
// performs no state I/O; prepareLogEntry only adds the canonical timestamp
// and optional plugin identity to the constructed entry.

import { prepareLogEntry } from "../../storage/log.ts";
import { normalizeLogFields } from "./validation.ts";

function logIdentity(request, plan) {
  return {
    action: plan.pluginId && typeof plan.logAction === "string" ? plan.logAction : request.action,
    agent: request.actor,
    node: plan.target.id,
  };
}

function addRevision(base, revision) {
  if (revision !== null && revision !== undefined) {base.revision = revision;}
}

function addEdgeChanges(base, added, removed) {
  if (added.length > 0 || removed.length > 0) {
    base.edges = { added: added.slice(), removed: removed.slice() };
  }
}

function addInitiativeChanges(base, initiativeDiff) {
  if (!initiativeDiff || (initiativeDiff.created.length === 0 && initiativeDiff.updated.length === 0)) {return;}
  base.initiatives = {
    created: initiativeDiff.created.map((entry) => entry.name).toSorted(),
    updated: initiativeDiff.updated.map((entry) => entry.name).toSorted(),
  };
}

function logPluginId(pluginId, plan) {
  return pluginId || (typeof plan.pluginId === "string" ? plan.pluginId : null);
}

export function buildLogEntry(...args) {
  const [request, plan, , , edgesAdded, edgesRemoved, removedNodes, targetNextRevision, pluginId, initiativeDiff] = args;
  const base: Record<string, unknown> = logIdentity(request, plan);
  addRevision(base, targetNextRevision);
  if (removedNodes.length > 0) {base.removed_nodes = removedNodes.toSorted();}
  addEdgeChanges(base, edgesAdded, edgesRemoved);
  addInitiativeChanges(base, initiativeDiff);
  return prepareLogEntry(
    { ...base, ...normalizeLogFields(plan.logFields, request.action) },
    { pluginId: logPluginId(pluginId, plan) },
  );
}
