// status: global view of the project.
// Output is shaped so an agent can read it without having to assemble the
// picture from raw sections. `summary.text` is a one-line plain-English
// narrative; `alerts` is a prioritized list of things needing attention
// (open decisions gating work, stale claims); `blocked` and
// `open_decisions` carry titles and reasons inline; `ready` carries the
// skills/effort/domain/gotcha context an agent needs before claiming.
import { readState } from "../state.mjs";
import { derive, blockedByDecision, blockedByDecisionInBacklog, staleClaims, statusOf } from "../dag.mjs";
import { forTask } from "../gotchas.mjs";

export const knownFlags = ["initiative", "staleMs"];

function isPlaceholder(id, task) {
  if (!id) return false;
  if (task && task.placeholder === true) return true;
  return id.split(".").pop() === "OPEN";
}

function phaseOf(id, task) {
  if (task && task.phase) return task.phase;
  if (!id) return undefined;
  const i = id.lastIndexOf(".");
  return i >= 0 ? id.slice(0, i) : undefined;
}

function describeDep(state, dep) {
  const t = state.tasks[dep];
  if (t) {
    const st = t.status || (t.backlog === true ? "backlog" : "ready");
    return {
      id: dep,
      kind: "task",
      status: st,
      title: t.title || "",
      claimed_by: t.claimed_by || null,
    };
  }
  const d = state.decisions[dep];
  if (d) {
    return {
      id: dep,
      kind: "decision",
      status: d.status || "open",
      title: d.title || "",
    };
  }
  return { id: dep, kind: "unknown", status: "unknown", title: "" };
}

function enrichTask(state, id) {
  const t = state.tasks[id] || {};
  return {
    id,
    title: t.title || "",
    initiative: t.initiative,
    phase: phaseOf(id, t),
    placeholder: isPlaceholder(id, t),
    reason: {
      unsatisfied_deps: (t.depends_on || []).map((dep) => describeDep(state, dep)),
    },
  };
}

function buildSummary(counts, placeholders, staleCount, openDecisionCount) {
  const total = Object.values(counts).reduce(
    (acc, c) => {
      acc.ready += c.ready || 0;
      acc.in_progress += c.in_progress || 0;
      acc.blocked += c.blocked || 0;
      acc.backlog += c.backlog || 0;
      acc.done += c.done || 0;
      acc.archived += c.archived || 0;
      return acc;
    },
    { ready: 0, in_progress: 0, blocked: 0, backlog: 0, done: 0, archived: 0 }
  );
  // ready + blocked are always shown (the two main questions: what's next
  // + what's stuck). Other counts only when nonzero.
  const parts = [];
  parts.push(`${total.ready} ready`);
  parts.push(
    placeholders > 0
      ? `${total.blocked} blocked (${placeholders} placeholder${placeholders === 1 ? "" : "s"})`
      : `${total.blocked} blocked`
  );
  if (total.in_progress > 0) parts.push(`${total.in_progress} in progress`);
  if (total.backlog > 0) parts.push(`${total.backlog} in backlog`);
  if (staleCount > 0) parts.push(`${staleCount} stale`);
  if (openDecisionCount > 0) {
    parts.push(`${openDecisionCount} open decision${openDecisionCount === 1 ? "" : "s"} gate work`);
  }
  return {
    text: parts.length > 0 ? parts.join("; ") : "empty state",
    ...total,
    placeholders,
    stale: staleCount,
    open_decisions: openDecisionCount,
  };
}

function buildAlerts(state, blockedByDec, blockedByDecInBacklog, stale) {
  const alerts = [];
  for (const d of Object.values(state.decisions)) {
    if (d.status === "decided") continue;
    const did = d.id;
    const blocked = blockedByDec[did] || [];
    const backlog = blockedByDecInBacklog[did] || [];
    if (blocked.length === 0 && backlog.length === 0) continue;
    const exampleIds = [...blocked.slice(0, 3), ...backlog.slice(0, 3)];
    const total = blocked.length + backlog.length;
    const title = d.title || "(no title)";
    alerts.push({
      severity: "info",
      kind: "decision-gate",
      decision_id: did,
      title,
      blocks: { ready: 0, blocked: blocked.length, backlog: backlog.length },
      message: `${did} (${title}) is OPEN and blocks ${total} task${total === 1 ? "" : "s"}: ${exampleIds.join(", ")}`,
    });
  }
  for (const s of stale) {
    alerts.push({
      severity: "warning",
      kind: "stale-claim",
      task_id: s.id,
      claimed_by: s.claimed_by || null,
      age_ms: s.age_ms,
      message: `${s.id} claimed by ${s.claimed_by || "(unknown)"} is stale (${Math.round(s.age_ms / 60000)}m old)`,
    });
  }
  return alerts;
}

function emptyStatus() {
  return {
    summary: { text: "empty state", ready: 0, in_progress: 0, blocked: 0, backlog: 0, done: 0, archived: 0, placeholders: 0, stale: 0, open_decisions: 0 },
    alerts: [],
    counts: {},
    in_progress: [],
    ready: [],
    blocked: [],
    backlog: [],
    blocked_by_decision: {},
    blocked_by_decision_in_backlog: {},
    stale: [],
    active_gotchas: [],
    open_decisions: [],
  };
}

export default async function status({ statePath, flags }) {
  const projectDir = statePath;
  let s = await readState(projectDir);
  if (!s) return emptyStatus();
  // Filter to a single initiative if requested.
  if (flags.initiative) {
    const init = flags.initiative;
    s = { ...s, tasks: Object.fromEntries(Object.entries(s.tasks).filter(([_, t]) => t.initiative === init)) };
  }
  const d = derive(s);
  const staleMs = flags.staleMs !== undefined && flags.staleMs !== true
    ? (() => {
        const n = parseInt(flags.staleMs, 10);
        if (Number.isNaN(n) || n < 0) {
          throw new Error(`status: --staleMs must be a non-negative integer (got '${flags.staleMs}')`);
        }
        return n;
      })()
    : 2 * 60 * 60 * 1000;
  const inProgress = Object.values(s.tasks).filter((t) => t.status === "in_progress");
  const counts = {};
  for (const t of Object.values(s.tasks)) {
    const init = t.initiative || "(none)";
    counts[init] = counts[init] || { ready: 0, in_progress: 0, done: 0, blocked: 0, archived: 0, backlog: 0 };
    counts[init][statusOf(s, t.id)] = (counts[init][statusOf(s, t.id)] || 0) + 1;
  }
  const activeGotchas = Object.values(s.gotchas).filter((g) => g.status !== "resolved");
  const titleOf = (id) => s.tasks[id]?.title || "";
  const blockedByDec = blockedByDecision(s, d);
  const blockedByDecInBacklog = blockedByDecisionInBacklog(s, d);
  const stale = staleClaims(s, staleMs);
  const placeholders = [...d.blocked, ...d.backlog].filter((id) => isPlaceholder(id, s.tasks[id])).length;

  // by_initiative: per-stream breakdown for the orchestrator view. Only
  // emitted when there are registered initiatives AND the caller didn't
  // already filter to a single one. Sorted by activity (ready+in_progress)
  // desc so the most "alive" stream is at the top of any UI.
  // ponytail: this is structured data, not a text blob. Agents that want a
  // human string can format it themselves; the summary.text line stays
  // one-line to preserve its existing contract.
  let byInitiative;
  if (!flags.initiative) {
    const registered = Object.keys(s.initiatives || {});
    if (registered.length > 0) {
      const openDecByInit = {};
      for (const d of Object.values(s.decisions)) {
        if (d.status === "decided") continue;
        if (d.initiative) openDecByInit[d.initiative] = (openDecByInit[d.initiative] || 0) + 1;
      }
      const staleByInit = {};
      for (const t of stale) {
        // staleClaims only returns id/claimed_by/claimed_at/age_ms; look up
        // the initiative on the actual task so we can attribute the claim.
        const init = s.tasks[t.id]?.initiative;
        if (init) staleByInit[init] = (staleByInit[init] || 0) + 1;
      }
      byInitiative = registered.map((name) => {
        const c = counts[name] || { ready: 0, in_progress: 0, done: 0, blocked: 0, archived: 0, backlog: 0 };
        return {
          name,
          desc: s.initiatives[name]?.desc || "",
          ready: c.ready || 0,
          in_progress: c.in_progress || 0,
          blocked: c.blocked || 0,
          backlog: c.backlog || 0,
          done: c.done || 0,
          archived: c.archived || 0,
          open_decisions: openDecByInit[name] || 0,
          stale: staleByInit[name] || 0,
        };
      });
      byInitiative.sort((a, b) => {
        const actA = a.ready + a.in_progress;
        const actB = b.ready + b.in_progress;
        if (actB !== actA) return actB - actA;
        return a.name.localeCompare(b.name);
      });
    }
  }

  return {
    summary: {
      ...buildSummary(counts, placeholders, stale.length, d.openDecisions.length),
      // Per-initiative breakdown (omitted when filtered or no initiatives).
      ...(byInitiative ? { by_initiative: byInitiative } : {}),
    },
    alerts: buildAlerts(s, blockedByDec, blockedByDecInBacklog, stale),
    counts,
    in_progress: inProgress.map((t) => ({ id: t.id, title: t.title, claimed_by: t.claimed_by, claimed_at: t.claimed_at, block_reason: t.block_reason, initiative: t.initiative, priority: t.priority || "medium" })),
    ready: d.ready.map((id) => {
      const t = s.tasks[id] || {};
      return {
        id,
        title: titleOf(id),
        priority: t.priority || "medium",
        skills: t.skills || [],
        effort: t.effort,
        domain: t.domain,
        phase: phaseOf(id, t),
        gotcha_count: forTask(s, t).length,
      };
    }),
    blocked: d.blocked.map((id) => enrichTask(s, id)),
    backlog: d.backlog.map((id) => {
      const t = s.tasks[id] || {};
      return { ...enrichTask(s, id), priority: t.priority || "medium" };
    }),
    blocked_by_decision: Object.fromEntries(
      Object.entries(blockedByDec).map(([did, tids]) => [did, tids.map((id) => ({ id, title: titleOf(id) }))])
    ),
    blocked_by_decision_in_backlog: Object.fromEntries(
      Object.entries(blockedByDecInBacklog).map(([did, tids]) => [did, tids.map((id) => ({ id, title: titleOf(id) }))])
    ),
    stale: stale.map((t) => ({ ...t, title: titleOf(t.id) })),
    active_gotchas: activeGotchas,
    open_decisions: d.openDecisions.map((id) => {
      const dec = s.decisions[id] || {};
      return {
        id,
        title: dec.title || "",
        initiative: dec.initiative,
        blocks: {
          ready: 0,
          blocked: (blockedByDec[id] || []).length,
          backlog: (blockedByDecInBacklog[id] || []).length,
        },
      };
    }),
  };
}
