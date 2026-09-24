// `status` view: agent-first picture of the DAG.
//
// Output shape (per design doc):
//   {
//     summary: { ready, in_progress, submitted, blocked, backlog, open_gates, active_knowledge },
//     tasks: { ready: [...], in_progress: [...], submitted: [...], blocked: [...], backlog: [...] },
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
//   --claimed-by X          restrict in_progress to one agent (default: all in_progress visible)
//   --as <agent>            scopes allowed_actions in `context`; it is NOT a filter for `status`.
//                           `status` shows every in_progress task by default, regardless of caller.
//   --stale-ms N            threshold for stale-claim alerts (default 2h)
//   --limit N               cap per-bucket list sizes
//   --all                   include done / canceled / resolved / superseded / deprecated
//                           groups; dump actual knowledge items instead of count only
//
// ponytail: simplest implementation filters post-derive; no per-bucket indexes.
// The expected state of a v2 project is a few dozen nodes; O(n) scans are fine.

import { readState } from "../../storage/state.mjs";
import { derive, statusOf, blockingForNode } from "../../read-model/index.mjs";

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
  "meta",
  "meta-keys",
  "mine",
  "fields",
  "slim",
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

function resolveMineActor(flags) {
  if (flags.mine === undefined || flags.mine === false || flags.mine === null) return null;
  if (typeof flags.mine === "string" && flags.mine.trim()) {
    throw new Error("status: --mine takes no value (pass --as <agent> or set CLIMIER_AGENT)");
  }
  const fromFlag = typeof flags.as === "string" ? flags.as.trim() : "";
  if (fromFlag) return fromFlag;
  const fromEnv = typeof process.env.CLIMIER_AGENT === "string" ? process.env.CLIMIER_AGENT.trim() : "";
  if (fromEnv) return fromEnv;
  throw new Error("status: --mine requires --as <agent> or CLIMIER_AGENT");
}

const SLIM_ROW_KEYS = Object.freeze(["id", "title", "status", "claimed_by"]);

function parseFieldProjection(flags) {
  if (flags.fields !== undefined && flags.fields !== null && flags.fields !== false) {
    if (flags.fields === true) throw new Error("status: --fields requires a value (e.g. --fields id,title,status)");
    const keys = String(flags.fields).split(",").map((k) => k.trim()).filter(Boolean);
    if (keys.length === 0) throw new Error("status: --fields requires a value (e.g. --fields id,title,status)");
    return { mode: "fields", keys };
  }
  if (flags.slim === true || flags.slim === "true") return { mode: "slim", keys: SLIM_ROW_KEYS };
  return null;
}

function applyFieldProjection(row, spec) {
  if (!spec || !row || typeof row !== "object") return row;
  const out = {};
  for (const key of spec.keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) out[key] = row[key];
  }
  return out;
}

function claimBy(node) {
  if (!node) return null;
  if (node.claim && typeof node.claim === "object" && node.claim.by) return node.claim.by;
  if (node.claimed_by) return node.claimed_by;
  return null;
}

function claimAtMs(node) {
  if (!node) return null;
  // ADR-022 §C: freshness comes from the heartbeat when the owner refreshes
  // it, falling back to the claim creation instant. Without a heartbeat the
  // previous behavior is unchanged.
  const at = (node.claim && (node.claim.heartbeat_at || node.claim.at)) || node.claimed_at;
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

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseMetaProjection(flags) {
  if (flags.meta !== undefined && flags.meta !== false && flags.meta !== null) {
    return { mode: "full" };
  }
  const raw = flags["meta-keys"];
  if (raw === undefined) return null;
  if (raw === true) throw new Error("status: --meta-keys requires a value (e.g. --meta-keys pid,space)");
  const keys = String(raw).split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) throw new Error("status: --meta-keys requires a value (e.g. --meta-keys pid,space)");
  return { mode: "keys", keys };
}

function projectMeta(node, spec) {
  if (!spec) return undefined;
  if (spec.mode === "full") {
    return isPlainObject(node.meta) ? structuredClone(node.meta) : null;
  }
  const out = {};
  if (isPlainObject(node.meta)) {
    for (const key of spec.keys) {
      if (Object.prototype.hasOwnProperty.call(node.meta, key)) out[key] = node.meta[key];
    }
  }
  return out;
}

function nodeSummary(node, metaSpec) {
  const row = {
    id: node.id,
    kind: node.kind,
    subkind: node.subkind,
    title: node.title || "",
    status: node.status || "open",
    initiative: node.initiative,
    domain: node.domain,
    claimed_by: claimBy(node),
  };
  if (metaSpec) row.meta = projectMeta(node, metaSpec);
  return row;
}

function enrichTasks(nodes, ids, kind, metaSpec) {
  return ids.map((id) => nodeSummary(nodes[id], metaSpec));
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

function detectStateInvariants(state, initiativeFilter) {
  // ADR-022 §C: corruption signals, unlike a merely old claim. A task that
  // is in_progress must hold a claim; a done task must record who
  // completed it.
  const out = [];
  for (const node of Object.values(state.nodes || {})) {
    if (node.kind !== "resolvable" || node.subkind !== "task") continue;
    if (initiativeFilter && node.initiative !== initiativeFilter) continue;
    const status = node.status || "open";
    if (status === "in_progress" && !claimBy(node)) {
      out.push({
        kind: "state-invariant",
        severity: "error",
        task_id: node.id,
        check: "missing-claim",
        message: `${node.id} is in_progress without a claim`,
      });
    }
    if (status === "done" && !node.done_by) {
      out.push({
        kind: "state-invariant",
        severity: "error",
        task_id: node.id,
        check: "missing-done-by",
        message: `${node.id} is done without done_by`,
      });
    }
  }
  return out;
}

function emptyResult() {
  return {
    summary: {
      ready: 0,
      in_progress: 0,
      submitted: 0,
      blocked: 0,
      backlog: 0,
      open_gates: 0,
      active_knowledge: 0,
    },
    tasks: { ready: [], in_progress: [], submitted: [], blocked: [], backlog: [] },
    gates: { open: [] },
    knowledge_count: 0,
    alerts: [],
  };
}

export default async function statusV2({ statePath, flags }) {
  const s = await readState(statePath);
  if (!s) return emptyResult();
  const nodes = s.nodes || {};
  const derived = derive({ snapshot: s });
  const all = flags.all === true;
  const initiativeFilter = flags.initiative || null;
  const domainFilter = flags.domain || null;
  const kindFilter = flags.kind || null; // task | gate | knowledge
  const statusFilter = flags.status || null; // rarely used; tests pass an exact match
  const mineActor = resolveMineActor(flags);
  const claimedByFilter = mineActor || flags["claimed-by"] || null;
  // `--as` is accepted (it's a known identity tag) but intentionally not a
  // filter here, unless the caller passes `--mine`. The status view is
  // global by default; see the in_progress scoping below.
  const staleMs = parseStaleMs(flags);
  const limit = parseLimit(flags);
  const metaSpec = parseMetaProjection(flags);
  const fieldSpec = parseFieldProjection(flags);

  // Filter pre-derived pools by the filter set so summary counts match lists.
  const filterByFlags = (id) => {
    const node = nodes[id];
    if (!node) return false;
    if (initiativeFilter && node.initiative !== initiativeFilter) return false;
    if (domainFilter && node.domain !== domainFilter) return false;
    if (kindFilter && node.kind !== kindFilter) return false;
    if (statusFilter && (node.status || "open") !== statusFilter && statusOf({ snapshot: s, id }) !== statusFilter) return false;
    return true;
  };

  const readyAll = derived.ready.filter(filterByFlags);
  const blockedAll = derived.blocked.filter(filterByFlags);
  const backlogAll = derived.backlog.filter(filterByFlags);

  // submitted is an explicit lifecycle state, not a derived ready/blocked pool.
  // Keep it visible regardless of --all, just like in_progress.
  const submittedAll = Object.values(nodes)
    .filter((node) => node.kind === "resolvable" && node.subkind === "task" && (node.status || "open") === "submitted")
    .filter((node) => !initiativeFilter || node.initiative === initiativeFilter)
    .filter((node) => !domainFilter || node.domain === domainFilter)
    .filter((node) => !kindFilter || node.kind === kindFilter)
    .map((node) => node.id);
  const submittedScoped = statusFilter
    ? (statusFilter === "submitted" ? submittedAll : [])
    : submittedAll;

  // in_progress comes from the persistent status, not the derived pool.
  const inProgressAll = Object.values(nodes)
    .filter((node) => node.kind === "resolvable" && node.subkind === "task" && (node.status || "open") === "in_progress")
    .filter((node) => !initiativeFilter || node.initiative === initiativeFilter)
    .filter((node) => !domainFilter || node.domain === domainFilter)
    .filter((node) => !kindFilter || node.kind === kindFilter)
    .map((node) => node.id);

  // in_progress visibility is global by default: every in_progress task is listed
  // unless the caller narrows it explicitly. `--claimed-by` is the only implicit
  // filter for claims; `--as` is an identity tag (it scopes `context`'s
  // allowed_actions) and is intentionally NOT a filter for `status`. `--status`
  // keeps its own contract: `in_progress` is the only value that surfaces the
  // bucket; any other value leaves it empty.
  let inProgressScoped;
  if (statusFilter) {
    inProgressScoped = statusFilter === "in_progress" ? inProgressAll : [];
  } else if (claimedByFilter) {
    inProgressScoped = inProgressAll.filter((id) => claimBy(nodes[id]) === claimedByFilter);
  } else {
    inProgressScoped = inProgressAll;
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
  const summarize = (id) => applyFieldProjection(nodeSummary(nodes[id], metaSpec), fieldSpec);
  const summarizeNode = (node) => applyFieldProjection(nodeSummary(node, metaSpec), fieldSpec);

  const result = {
    summary: {
      ready: readyAll.length,
      in_progress: inProgressScoped.length,
      submitted: submittedScoped.length,
      blocked: blockedAll.length,
      backlog: backlogAll.length,
      open_gates: openGates.length,
      active_knowledge: activeKnowledge,
    },
    tasks: {
      ready: cap(readyAll).map(summarize),
      in_progress: cap(inProgressScoped).map(summarize),
      submitted: cap(submittedScoped).map(summarize),
      blocked: cap(blockedAll).map((id) => {
        const node = nodes[id];
        const blocking = blockingForNode(s, id)
          .map((b) => ({ id: b.node && b.node.id, kind: b.node && b.node.kind, satisfied: b.satisfied }));
        return applyFieldProjection({
          ...nodeSummary(node, metaSpec),
          unsatisfied_blockers: blocking.filter((b) => b.satisfied === false).map((b) => b.id).filter(Boolean),
        }, fieldSpec);
      }),
      backlog: cap(backlogAll).map(summarize),
    },
    gates: {
      open: cap(openGates).map(summarize),
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

  // Stale-claim alerts (always-on when in_progress exists). They mirror the
  // in_progress bucket visibility: global by default, narrowed only by an
  // explicit `--claimed-by`. `--as` is an identity tag, not a filter here.
  const stale = detectStaleClaims(s, staleMs, initiativeFilter);
  for (const s of stale) {
    if (claimedByFilter && s.claimed_by !== claimedByFilter) continue;
    result.alerts.push({
      kind: "stale-claim",
      severity: "warning",
      task_id: s.id,
      claimed_by: s.claimed_by,
      age_ms: s.age_ms,
      message: `${s.id} claimed by ${s.claimed_by} is stale (${Math.round(s.age_ms / 60000)}m old)`,
    });
  }

  for (const inv of detectStateInvariants(s, initiativeFilter)) {
    result.alerts.push(inv);
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
      tasks: doneTasks.map(summarizeNode),
    };
    result.canceled = { tasks: canceledTasks.map(summarizeNode) };
    result.resolved = { gates: resolvedGates.map(summarizeNode) };
    result.superseded = {
      nodes: supersededNodes.map(summarizeNode),
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
