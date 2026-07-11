// dag.mjs: pure functions over state to derive ready/blocked/open and
// produce delegation views. No I/O.
import { emptyState } from "./state.mjs";

function isSatisfied(s, dep) {
  if (s.tasks[dep]) {
    return s.tasks[dep].status === "done" || s.tasks[dep].status === "archived";
  }
  if (s.decisions[dep]) {
    return s.decisions[dep].status === "decided";
  }
  // Unknown dep: treat as not satisfied (so the task stays blocked, doesn't crash).
  return false;
}

export function derive(state) {
  const s = state || emptyState();
  const ready = [];
  const blocked = [];
  const openDecisions = [];
  const backlog = [];

  for (const [id, t] of Object.entries(s.tasks)) {
    if (t.status === "done" || t.status === "archived" || t.status === "in_progress") continue;
    // Backlog tasks sit in their own bucket — they're persisted as "not yet
    // pulled", so they're neither ready nor blocked. The decision to claim
    // them is `promote`, not the DAG.
    if (t.backlog === true) {
      backlog.push(id);
      continue;
    }
    const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
    const ok = deps.every((d) => d != null && isSatisfied(s, d));
    if (ok) ready.push(id);
    else blocked.push(id);
  }
  for (const [id, d] of Object.entries(s.decisions)) {
    if (d.status !== "decided") openDecisions.push(id);
  }
  return { ready, blocked, openDecisions, backlog };
}

// Map: decisionId -> [taskIds blocked by it (anywhere in their deps)]
export function blockedByDecision(state, derived) {
  const d = derived || derive(state);
  const s = state;
  const m = {};
  for (const tid of d.blocked) {
    const t = s.tasks[tid];
    for (const dep of t.depends_on || []) {
      if (s.decisions[dep] && s.decisions[dep].status !== "decided") {
        (m[dep] = m[dep] || []).push(tid);
      }
    }
  }
  return m;
}

// Map: decisionId -> [taskIds in the BACKLOG pool depending on it (open only)].
// Parallel of blockedByDecision for backlog tasks. The DAG itself does not
// surface these — backlog is a parallel bucket that doesn't block — but the
// orchestrator needs to see the impact of closing a decision on future
// work, not just on the current ready/blocked pool.
export function blockedByDecisionInBacklog(state, derived) {
  const d = derived || derive(state);
  const s = state;
  const m = {};
  for (const tid of d.backlog) {
    const t = s.tasks[tid];
    for (const dep of t.depends_on || []) {
      if (s.decisions[dep] && s.decisions[dep].status !== "decided") {
        (m[dep] = m[dep] || []).push(tid);
      }
    }
  }
  return m;
}

// Stale claim: a task in_progress whose claimed_at is older than staleMs.
export function staleClaims(state, staleMs = 2 * 60 * 60 * 1000) {
  const now = Date.now();
  const out = [];
  for (const [id, t] of Object.entries(state.tasks)) {
    if (t.status === "in_progress" && t.claimed_at && now - t.claimed_at > staleMs) {
      out.push({ id, claimed_by: t.claimed_by, claimed_at: t.claimed_at, age_ms: now - t.claimed_at });
    }
  }
  return out;
}

// Derived status string for a single task.
export function statusOf(state, taskId) {
  const t = state.tasks[taskId];
  if (!t) return "unknown";
  if (t.status === "done" || t.status === "archived" || t.status === "in_progress") return t.status;
  if (t.backlog === true) return "backlog";
  const d = derive(state);
  if (d.ready.includes(taskId)) return "ready";
  if (d.blocked.includes(taskId)) return "blocked";
  return "unknown";
}

// Next free task id for a phase. Pure: no I/O.
// Convention: task ids look like "<phase>.T<num><suffix>" (e.g. "F1.T3" or "F1.T2R").
// The phase is everything before the last dot. "T" is the fixed prefix in
// the output. The number is sequential. The suffix is optional and appended
// at the end; default is "" (no suffix).
// Policy: next sequential, not fill-the-gap.
// Each (phase, suffix) pair has its own independent sequence: F1.T1 and
// F1.T1R do not block each other.
export function nextTaskId(state, phase, suffix) {
  // suffix is optional. If provided, validate it. If not provided (undefined),
  // no suffix is appended and the default-family counters are used.
  if (suffix !== undefined) {
    if (typeof suffix !== "string" || suffix.length === 0) {
      throw new Error(`nextTaskId: suffix must be a non-empty string when provided (got ${JSON.stringify(suffix)})`);
    }
    if (suffix.includes(".")) {
      throw new Error(`nextTaskId: suffix must not contain a dot (got ${JSON.stringify(suffix)})`);
    }
    if (suffix === "OPEN") {
      throw new Error(`nextTaskId: suffix "OPEN" is reserved for placeholders`);
    }
  }
  const sfx = suffix || "";
  let max = 0;
  for (const id of Object.keys((state && state.tasks) || {})) {
    const dot = id.lastIndexOf(".");
    if (dot < 0) continue;
    if (id.slice(0, dot) !== phase) continue;
    const local = id.slice(dot + 1);
    if (local === "OPEN") continue;
    // Match: <non-digits><digits><non-digits>. The first non-digits chunk
    // is the prefix (typically "T"), the last non-digits chunk is the suffix.
    const m = local.match(/^(\D*)(\d+)(\D*)$/);
    if (!m) continue;
    const [, , nStr, sFound] = m;
    if (sFound !== sfx) continue;
    const n = parseInt(nStr, 10);
    if (n > max) max = n;
  }
  return `${phase}.T${max + 1}${sfx}`;
}
