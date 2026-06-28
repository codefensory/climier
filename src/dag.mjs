// dag.mjs: pure functions over state to derive ready/blocked/open and
// produce delegation views. No I/O.
import { emptyState } from "./state.mjs";

function isSatisfied(s, dep) {
  if (s.tasks[dep]) {
    return s.tasks[dep].status === "done" || s.tasks[dep].status === "skipped";
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

  for (const [id, t] of Object.entries(s.tasks)) {
    if (t.status === "done" || t.status === "skipped" || t.status === "in_progress") continue;
    const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
    const ok = deps.every((d) => d != null && isSatisfied(s, d));
    if (ok) ready.push(id);
    else blocked.push(id);
  }
  for (const [id, d] of Object.entries(s.decisions)) {
    if (d.status !== "decided") openDecisions.push(id);
  }
  return { ready, blocked, openDecisions };
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
  if (t.status === "done" || t.status === "skipped" || t.status === "in_progress") return t.status;
  const d = derive(state);
  if (d.ready.includes(taskId)) return "ready";
  if (d.blocked.includes(taskId)) return "blocked";
  return "unknown";
}
