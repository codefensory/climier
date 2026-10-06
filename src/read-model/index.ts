
// This layer composes pure projections; object-shaped arguments are the
// canonical API and positional forms remain available for compatibility.

import { derive, statusOf, blockingForNode, knowledgeForNode, informingForNode, deriveV2, isSatisfiedV2, gateProjection, isCurrent, supersededBy } from "./core.ts";
import { projectStatusView } from "./status.ts";
import { projectInitiativesView } from "./initiatives.ts";
import { projectSearchView } from "./search.ts";
import { projectContextView } from "./context.ts";
import { projectSnapshot } from "./snapshot.ts";
import { projectUiActivity, projectUiNode, projectUiSnapshot } from "./ui.ts";
import type { ReadModelLogEntry, ReadModelSnapshot } from "./types.ts";

interface LogFilters {
  action?: string;
  agent?: string;
  node?: string;
  limit?: string | number;
}

interface ProjectLogArgs {
  snapshot?: ReadModelSnapshot;
  filters?: LogFilters;
}

function filterLogEntries(entries: ReadModelLogEntry[], filters: LogFilters): ReadModelLogEntry[] {
  let current = entries;
  for (const key of ["action", "agent", "node"]) {
    if (filters[key]) {
      current = current.filter((entry) => entry[key] === filters[key]);
    }
  }
  return current;
}

function limitLogEntries(entries: ReadModelLogEntry[], limitValue: string | number | undefined): ReadModelLogEntry[] {
  if (!limitValue) {
    return entries;
  }
  const limit = Number.parseInt(String(limitValue), 10);
  return Number.isFinite(limit) && limit > 0 ? entries.slice(-limit) : entries;
}

/** Project a snapshot's append-only log without changing its order or shape. */
export function projectLogView({ snapshot, filters = {} }: ProjectLogArgs = {}) {
  const entries = snapshot?.log || [];
  return limitLogEntries(filterLogEntries(entries, filters), filters.limit);
}

export function deriveReadModel(args) {
  return derive(args);
}
export const statusOfV2 = statusOf;
export const projectStatus = statusOf;
export const projectInitiatives = projectInitiativesView;
export const projectLog = projectLogView;
export const projectBlocking = blockingForNode;
export const projectKnowledge = knowledgeForNode;
export const projectInforming = informingForNode;

export {
  derive,
  statusOf,
  blockingForNode,
  knowledgeForNode,
  informingForNode,
  projectStatusView,
  projectInitiativesView,
  projectSearchView,
  projectContextView,
  projectSnapshot,
  projectUiSnapshot,
  projectUiNode,
  projectUiActivity,
  deriveV2,
  isSatisfiedV2,
  gateProjection,
  isCurrent,
  supersededBy,
};
