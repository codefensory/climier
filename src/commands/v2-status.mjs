// F12 — v2 `status` view: agent-first picture of the v2 DAG.
//
// Output shape (per design doc):
//   {
//     summary: { ready, in_progress, blocked, backlog, open_gates, active_knowledge },
//     tasks: { ready: [...], in_progress: [...], blocked: [...], backlog: [...] },
//     gates: { open: [...] },
//     knowledge_count: number,            // default
//     knowledge: [...]   (only when --kind knowledge + --all, or just --all)
//     alerts: [...],
//     ... // --all adds done / canceled / resolved / superseded / deprecated groups
//   }
//
// Filters:
//   --initiative X          narrow to one initiative (matches the node's own field)
//   --kind task|gate|knowledge    restrict task buckets AND/OR scope knowledge
//   --status X              restrict the in_progress / blocked / ready buckets by
//                           exact status (rare; mainly 'in_progress' / 'ready' / 'blocked')
//   --domain X              narrow by node.domain
//   --claimed-by X          restrict in_progress to one agent (default: only caller's claims)
//   --stale-ms N            threshold for stale-claim alerts (default 2h)
//   --limit N               cap per-bucket list sizes
//   --all                   include done / canceled / resolved / superseded / deprecated
//                           groups; dump actual knowledge items instead of count only
//
// ponytail: simplest implementation filters post-derive; no per-bucket indexes.
// The expected state of a v2 project is a few dozen nodes; O(n) scans are fine.

import { readState, isV2State } from "../state.mjs";
import { deriveV2, statusOfV2, blockingForNode } from "../v2.mjs";

export const knownFlags = [
  "initiative",
  "kind",
  "status",
  "domain",
  "claimed-by",
  "stale-ms",
  "limit",
  "all",
  "as",
];

const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

function parseStaleMs(flags) {
  if (flags["stale-ms"] === undefined || flags["stale-ms"] === true) return DEFAULT_STALE_MS;
  const n = parseInt(flags["stale-ms"], 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`status: --stale-ms must be a non-negative integer (got '${flags["stale-ms"]}')`);
  }
  return n;
}

function parseLimit(flags) {
  if (flags.limit === undefined || flags.limit === true) return null;
  const n = parseInt(flags.limit, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`status: --limit must be a non-negative integer (got '${flags.limit}')`);
  }
  return n;
}

function claimBy(node) {
  if (!node) return null;
  if (node.claim && typeof node.claim === "object" && node.claim.by) return node.claim.by;
  if (node.claimed_by) return node.claimed_by;
  return null;
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

function taskMatchesFilters(node, filters) {
  if (filters.initiative && node.initiative !== filters.initiative) return false;
  if (filters.domain && node.domain !== filters.domain) return false;
  return true;
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

function enrichTasks(nodes, ids, kind) {
  return ids.map((id) => nodeSummary(nodes[id]));
}

function detectStaleClaims(state, staleMs, initiativeFilter) {
  const out = [];
  const now = Date.now();
  for (const node of Object.values(state.nodes || {})) {
    if (node.kind !== "resolvable" || node.subkind !== "task") continue;
    if (initiativeFilter && node.initiative !== initiativeFilter) continue;
    if ((node.status || "open") !== "in_progress") continue;
    const at = claimAtMs(node);
    if (at === null) continue;
    const by = claimBy(node);
    if (!by) continue;
    const age = now - at;
    if (age > staleMs) {
      out.push({ id: node.id, claimed_by: by, age_ms: age, title: node.title || "" });
    }
  }
  return out;
}

function emptyResult() {
  return {
    summary: {
      ready: 0,
      in_progress: 0,
      blocked: 0,
      backlog: 0,
      open_gates: 0,
      active_knowledge: 0,
    },
    tasks: { ready: [], in_progress: [], blocked: [], backlog: [] },
    gates: { open: [] },
    knowledge_count: 0,
    alerts: [],
  };
}

export default async function statusV2({ statePath, flags }) {
  const s = await readState(statePath);
  if (!s) return emptyResult();
  if (!isV2State(s)) {
    throw new Error("status: v1 state is not supported by the v2 status command");
  }
  const nodes = s.nodes || {};
  const derived = deriveV2(s);
  const all = flags.all === true;
  const initiativeFilter = flags.initiative || null;
  const domainFilter = flags.domain || null;
  const kindFilter = flags.kind || null; // task | gate | knowledge
  const statusFilter = flags.status || null; // rarely used; tests pass an exact match
  const claimedByFilter = flags["claimed-by"] || null;
  const asFilter = flags.as || null;
  const staleMs = parseStaleMs(flags);
  const limit = parseLimit(flags);

  // Filter pre-derived pools by the filter set so summary counts match lists.
  const filterByFlags = (id) => {
    const node = nodes[id];
    if (!node) return false;
    if (initiativeFilter && node.initiative !== initiativeFilter) return false;
    if (domainFilter && node.domain !== domainFilter) return false;
    if (kindFilter && node.kind !== kindFilter) return false;
    if (statusFilter && (node.status || "open") !== statusFilter && statusOfV2(s, id) !== statusFilter) return false;
    return true;
  };

  const readyAll = derived.ready.filter(filterByFlags);
  const blockedAll = derived.blocked.filter(filterByFlags);
  const backlogAll = derived.backlog.filter(filterByFlags);

  // in_progress comes from the persistent status, not the derived pool.
  const inProgressAll = Object.values(nodes)
    .filter((node) => node.kind === "resolvable" && node.subkind === "task" && (node.status || "open") === "in_progress")
    .filter((node) => !initiativeFilter || node.initiative === initiativeFilter)
    .filter((node) => !domainFilter || node.domain === domainFilter)
    .filter((node) => !kindFilter || node.kind === kindFilter)
    .map((node) => node.id);

  // ponytail: --status X takes precedence over the default who-claimed scoping,
  // because the user asked for a status view (e.g. `status --status in_progress`
  // should show every in_progress task regardless of claimer). Without --status,
  // the default scoping (caller's --as or --claimed-by) hides other agents' work.
  let inProgressScoped;
  if (statusFilter) {
    inProgressScoped = inProgressAll.filter(() => statusFilter === "in_progress");
  } else if (claimedByFilter) {
    inProgressScoped = inProgressAll.filter((id) => claimBy(nodes[id]) === claimedByFilter);
  } else if (asFilter) {
    inProgressScoped = inProgressAll.filter((id) => claimBy(nodes[id]) === asFilter);
  } else {
    inProgressScoped = [];
  }

  // open gates pool
  const openGatesAll = (derived.openGates || [])
    .filter((id) => {
      const node = nodes[id];
      if (!node) return false;
      if (initiativeFilter && node.initiative !== initiativeFilter) return false;
      if (kindFilter && node.kind !== "resolvable") return false;
      return true;
    });
  const openGates = statusFilter ? openGatesAll.filter(() => statusFilter === "open") : openGatesAll;

  // knowledge
  const knowledgeAll = Object.values(nodes).filter((n) => n.kind === "knowledge");
  const knowledgeInScope = knowledgeAll.filter((n) => {
    if (initiativeFilter && n.initiative !== initiativeFilter) return false;
    if (kindFilter && n.kind !== "knowledge") return false;
    return true;
  });
  const activeKnowledge = knowledgeInScope.filter((k) => (k.status || "active") === "active").length;

  const cap = (arr) => (limit !== null ? arr.slice(0, limit) : arr);

  const result = {
    summary: {
      ready: readyAll.length,
      in_progress: inProgressScoped.length,
      blocked: blockedAll.length,
      backlog: backlogAll.length,
      open_gates: openGates.length,
      active_knowledge: activeKnowledge,
    },
    tasks: {
      ready: cap(readyAll).map((id) => nodeSummary(nodes[id])),
      in_progress: cap(inProgressScoped).map((id) => nodeSummary(nodes[id])),
      blocked: cap(blockedAll).map((id) => {
        const node = nodes[id];
        const blocking = blockingForNode(s, id)
          .map((b) => ({ id: b.node && b.node.id, kind: b.node && b.node.kind, satisfied: b.satisfied }));
        return {
          ...nodeSummary(node),
          unsatisfied_blockers: blocking.filter((b) => b.satisfied === false).map((b) => b.id).filter(Boolean),
        };
      }),
      backlog: cap(backlogAll).map((id) => nodeSummary(nodes[id])),
    },
    gates: {
      open: cap(openGates).map((id) => nodeSummary(nodes[id])),
    },
    knowledge_count: knowledgeInScope.length,
    alerts: [],
  };

  // --all: dump knowledge items; surface done/canceled/resolved/superseded/deprecated groups
  if (all) {
    result.knowledge = knowledgeInScope.map((n) => ({
      id: n.id,
      title: n.title || "",
      status: n.status || "active",
      initiative: n.initiative,
      scope: n.scope || {},
      knowledge_type: n.knowledge_type,
      deprecation_reason: n.deprecation_reason,
      deprecated_at: n.deprecated_at,
      deprecated_by: n.deprecated_by,
    }));
  } else if (kindFilter === "knowledge") {
    // --kind knowledge alone: keep count only (per spec).
  }

  // Stale-claim alerts (always-on when in_progress exists).
  const stale = detectStaleClaims(s, staleMs, initiativeFilter);
  for (const s of stale) {
    if (claimedByFilter && s.claimed_by !== claimedByFilter) continue;
    if (asFilter && s.claimed_by !== asFilter) continue;
    result.alerts.push({
      kind: "stale-claim",
      severity: "warning",
      task_id: s.id,
      claimed_by: s.claimed_by,
      age_ms: s.age_ms,
      message: `${s.id} claimed by ${s.claimed_by} is stale (${Math.round(s.age_ms / 60000)}m old)`,
    });
  }

  if (all) {
    const doneTasks = Object.values(nodes).filter((n) =>
      n.kind === "resolvable" && n.subkind === "task" && n.status === "done"
      && (!initiativeFilter || n.initiative === initiativeFilter)
    );
    const canceledTasks = Object.values(nodes).filter((n) =>
      n.kind === "resolvable" && n.subkind === "task" && n.status === "canceled"
      && (!initiativeFilter || n.initiative === initiativeFilter)
    );
    const resolvedGates = Object.values(nodes).filter((n) =>
      n.kind === "resolvable" && n.subkind === "gate" && n.status === "resolved"
      && (!initiativeFilter || n.initiative === initiativeFilter)
    );
    const supersededNodes = Object.values(nodes).filter((n) => n.status === "superseded" && (!initiativeFilter || n.initiative === initiativeFilter));
    const deprecatedKnowledge = knowledgeInScope.filter((n) => n.status === "deprecated");
    result.done = {
      tasks: doneTasks.map(nodeSummary),
    };
    result.canceled = { tasks: canceledTasks.map(nodeSummary) };
    result.resolved = { gates: resolvedGates.map(nodeSummary) };
    result.superseded = {
      nodes: supersededNodes.map(nodeSummary),
    };
    result.deprecated = {
      knowledge: deprecatedKnowledge.map((n) => ({
        id: n.id,
        title: n.title || "",
        deprecation_reason: n.deprecation_reason,
        deprecated_at: n.deprecated_at,
        deprecated_by: n.deprecated_by,
      })),
    };
  }

  return result;
}
