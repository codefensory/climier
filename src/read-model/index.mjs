
// This layer composes pure projections; object-shaped arguments are the
// canonical API and positional forms remain available for compatibility.

import { derive, statusOf, blockingForNode, knowledgeForNode, informingForNode, deriveV2, isSatisfiedV2, gateProjection, isCurrent, supersededBy } from "./core.mjs";
import { projectStatusView } from "./status.mjs";
import { projectInitiativesView } from "./initiatives.mjs";
import { projectSearchView } from "./search.mjs";
import { projectContextView } from "./context.mjs";
import { projectSnapshot } from "./snapshot.mjs";

function filterLogEntries(entries, filters) {
  let current = entries;
  for (const key of ["action", "agent", "node"]) {
    if (filters[key]) {
      current = current.filter((entry) => entry[key] === filters[key]);
    }
  }
  return current;
}

function limitLogEntries(entries, limitValue) {
  if (!limitValue) {
    return entries;
  }
  const limit = Number.parseInt(limitValue, 10);
  return Number.isFinite(limit) && limit > 0 ? entries.slice(-limit) : entries;
}

/** Project a snapshot's append-only log without changing its order or shape. */
export function projectLogView({ snapshot, filters = {} } = {}) {
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
  deriveV2,
  isSatisfiedV2,
  gateProjection,
  isCurrent,
  supersededBy,
};
