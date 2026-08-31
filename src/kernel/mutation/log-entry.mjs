// Pure mutation log construction boundary.
//
// The kernel owns the audit identity and structural metadata. Providers may
// contribute only the allow-listed operation-specific fields. This module
// performs no state I/O; prepareLogEntry only adds the canonical timestamp
// and optional plugin identity to the constructed entry.

import { prepareLogEntry } from "../../storage/log.mjs";
import { normalizeLogFields } from "./validation.mjs";

export function buildLogEntry(
  request,
  plan,
  diffCreated,
  diffUpdated,
  edgesAdded,
  edgesRemoved,
  removedNodes,
  targetNextRevision,
  pluginId,
  initiativeDiff,
) {
  const base = {
    // Legacy/core adapters choose the request action explicitly. Plugin-data
    // plans additionally carry their stable redacted audit action, so a
    // canonical `plugin-data.*` request still records `plugin-data-set`
    // without changing existing CLI/API log names.
    action: plan.pluginId && typeof plan.logAction === "string" ? plan.logAction : request.action,
    agent: request.actor,
    node: plan.target.id,
  };
  if (targetNextRevision !== null && targetNextRevision !== undefined) base.revision = targetNextRevision;
  if (removedNodes.length > 0) base.removed_nodes = removedNodes.slice().sort();
  if (edgesAdded.length > 0 || edgesRemoved.length > 0) {
    base.edges = {
      added: edgesAdded.slice(),
      removed: edgesRemoved.slice(),
    };
  }
  if (initiativeDiff && (initiativeDiff.created.length > 0 || initiativeDiff.updated.length > 0)) {
    base.initiatives = {
      created: initiativeDiff.created.map((c) => c.name).sort(),
      updated: initiativeDiff.updated.map((u) => u.name).sort(),
    };
  }
  // Plugin providers carry their host identity in the typed plan. Prefer the
  // explicit kernel argument when present, but retain the plan identity for
  // direct provider use (the plan never contains the data value in its log
  // fields).
  const auditPluginId = pluginId || (typeof plan.pluginId === "string" ? plan.pluginId : null);
  return prepareLogEntry({ ...base, ...normalizeLogFields(plan.logFields, request.action) }, { pluginId: auditPluginId });
}
