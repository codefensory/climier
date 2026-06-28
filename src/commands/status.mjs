// status: global view of the project.
import { readState } from "../state.mjs";
import { derive, blockedByDecision, staleClaims, statusOf } from "../dag.mjs";

export default async function status({ statePath, flags }) {
  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");
  const s = await readState(projectDir);
  if (!s) {
    return { counts: {}, in_progress: [], ready: [], blocked: [], blocked_by_decision: {}, stale: [], active_gotchas: [], open_decisions: [] };
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
  const done = Object.values(s.tasks).filter((t) => t.status === "done");
  const counts = {};
  for (const t of Object.values(s.tasks)) {
    const init = t.initiative || "(none)";
    counts[init] = counts[init] || { ready: 0, in_progress: 0, done: 0, blocked: 0, skipped: 0 };
    counts[init][statusOf(s, t.id)] = (counts[init][statusOf(s, t.id)] || 0) + 1;
  }
  const activeGotchas = Object.values(s.gotchas).filter((g) => g.status !== "resolved");
  return {
    counts,
    in_progress: inProgress.map((t) => ({ id: t.id, title: t.title, claimed_by: t.claimed_by, claimed_at: t.claimed_at, block_reason: t.block_reason, initiative: t.initiative })),
    ready: d.ready,
    blocked: d.blocked,
    blocked_by_decision: blockedByDecision(s, d),
    stale: staleClaims(s, staleMs),
    active_gotchas: activeGotchas,
    open_decisions: d.openDecisions,
  };
}
