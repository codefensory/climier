// pre-claim: read-only pre-flight check before claiming a task.
// Doubles as the "task detail" view: spec, gotchas, derived status, current
// claim info, structured dep details, and a clear GO / NO-GO verdict.
import { readState } from "../state.mjs";
import { derive } from "../dag.mjs";
import { forTask } from "../gotchas.mjs";

export const knownFlags = ["staleMs"];

const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

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
  const depends_on_detail = (Array.isArray(t.depends_on) ? t.depends_on : []).map((dep) => describeDep(s, dep));

  let derived_status;
  const blockers = [];
  const warnings = [];
  let claim = null;

  if (t.status === "done" || t.status === "archived") {
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
  } else if (d.backlog.includes(id)) {
    derived_status = "backlog";
    blockers.push("task is in backlog (run `climier promote <id>` to pull it into the ready pool)");
  } else {
    derived_status = "blocked";
    const unsatisfied = [];
    for (const info of depends_on_detail) {
      if (info.kind === "task") {
        if (info.status !== "done" && info.status !== "archived") {
          unsatisfied.push(`${info.id} (task: ${info.status || "ready"})`);
        }
      } else if (info.kind === "decision") {
        if (info.status !== "decided") {
          unsatisfied.push(`${info.id} (decision: ${info.status || "open"})`);
        }
      } else {
        unsatisfied.push(`${info.id} (unknown)`);
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
    depends_on_detail,
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
