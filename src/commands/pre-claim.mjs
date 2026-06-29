// pre-claim: read-only pre-flight check before claiming a task.
// Surfaces task definition, gotchas, derived status, current claim info,
// and a clear GO / NO-GO verdict.
import { readState } from "../state.mjs";
import { derive } from "../dag.mjs";
import { forTask } from "../gotchas.mjs";

export const knownFlags = ["staleMs"];

const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

export default async function preClaim({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throw new Error("pre-claim: task id required");
  let staleMs = DEFAULT_STALE_MS;
  if (flags.staleMs !== undefined && flags.staleMs !== true) {
    const n = Number(flags.staleMs);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`pre-claim: --staleMs must be a non-negative number (got '${flags.staleMs}')`);
    }
    staleMs = n;
  }
  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");
  const s = await readState(projectDir);
  if (!s) throw new Error("pre-claim: state file missing");
  const t = s.tasks[id];
  if (!t) throw new Error(`pre-claim: task ${id} not found`);

  const title = (t.title && t.title.trim()) || "(no title)";
  const gotchas = forTask(s, t);
  const d = derive(s);

  let derived_status;
  const blockers = [];
  const warnings = [];
  let claim = null;

  if (t.status === "done" || t.status === "skipped") {
    derived_status = t.status;
    blockers.push(`task is ${t.status}`);
  } else if (t.status === "in_progress") {
    derived_status = "in_progress";
    const age_ms = t.claimed_at ? Date.now() - t.claimed_at : null;
    claim = { by: t.claimed_by || null, age_ms, block_reason: t.block_reason || null };
    blockers.push(`task is in_progress${t.claimed_by ? ` by ${t.claimed_by}` : ""}`);
    if (age_ms !== null && age_ms > staleMs) {
      warnings.push(`claim is ${Math.round(age_ms / 60000)}m old (stale; orchestrator can release --as orchestrator)`);
    }
  } else if (d.ready.includes(id)) {
    derived_status = "ready";
  } else {
    derived_status = "blocked";
    const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
    const unsatisfied = [];
    for (const dep of deps) {
      if (s.tasks[dep]) {
        const st = s.tasks[dep].status;
        if (st !== "done" && st !== "skipped") unsatisfied.push(`${dep} (task: ${st || "ready"})`);
      } else if (s.decisions[dep]) {
        if (s.decisions[dep].status !== "decided") unsatisfied.push(`${dep} (decision: ${s.decisions[dep].status || "open"})`);
      } else {
        unsatisfied.push(`${dep} (unknown)`);
      }
    }
    blockers.push(unsatisfied.length ? `deps not satisfied: ${unsatisfied.join(", ")}` : "task is blocked (unknown reason)");
  }

  return {
    id: t.id,
    title,
    initiative: t.initiative,
    definition: t.definition || title || "(no definition)",
    acceptance: t.acceptance || "(no acceptance criteria defined)",
    depends_on: t.depends_on || [],
    skills: t.skills || [],
    domain: t.domain,
    gotchas,
    derived_status,
    can_claim: derived_status === "ready",
    blockers,
    warnings,
    claim,
  };
}
