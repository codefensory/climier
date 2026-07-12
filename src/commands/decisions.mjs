// decisions: list all decisions, with title, status, choice, rationale.
// Each OPEN decision also reports `blocks: { ready, blocked, backlog }` —
// the count of tasks in each pool that depend on it. This lets the
// orchestrator see the full impact of `climier decide` (not just the
// ready/blocked slice; the backlog slice is the new addition).
// Open decisions with zero dependents omit `blocks` (no noise).
import { readState } from "../state.mjs";
import { derive } from "../dag.mjs";

export const knownFlags = ["initiative"];

function countByPool(state, derived, decisionId) {
  let ready = 0, blocked = 0, backlog = 0;
  const targets = [...derived.ready, ...derived.blocked, ...derived.backlog];
  for (const tid of targets) {
    const t = state.tasks[tid];
    if (!t) continue;
    if (Array.isArray(t.depends_on) && t.depends_on.includes(decisionId)) {
      if (derived.ready.includes(tid)) ready++;
      else if (derived.blocked.includes(tid)) blocked++;
      else if (derived.backlog.includes(tid)) backlog++;
    }
  }
  return { ready, blocked, backlog };
}

export default async function decisions({ statePath, flags }) {
  const projectDir = statePath;
  const s = await readState(projectDir);
  if (!s) return [];
  const wantInit = flags.initiative;
  const derived = derive(s);
  const out = [];
  for (const d of Object.values(s.decisions)) {
    if (wantInit && d.initiative !== wantInit) continue;
    // Normalize: every decision has a status; default to "open" if absent.
    const node = { status: "open", ...d };
    // For open decisions, count how many tasks in each pool depend on it.
    // Omit the field when nothing depends on it (avoids noise on a long
    // list of open decisions, most of which gate nothing yet).
    if (node.status !== "decided") {
      const blocks = countByPool(s, derived, node.id);
      if (blocks.ready > 0 || blocks.blocked > 0 || blocks.backlog > 0) {
        node.blocks = blocks;
      }
    }
    out.push(node);
  }
  return out;
}
