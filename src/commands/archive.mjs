// archive: mark a task as archived (terminal "we decided not to do this").
// Pattern is closest to done: requires a reason, clears claim metadata, appends to log.
// Authority: in_progress requires the claimer (or orchestrator/recovery escape hatch);
// ready/blocked tasks can be archived by any agent with --as.
// Once archived, the task is terminal — no command rolls it back.
import { readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";

export const knownFlags = ["as"];

export default async function archive({ statePath, flags, positional }) {
  const [id, ...rest] = positional;
  if (!id) throw new Error("archive: task id required");
  const reason = rest.join(" ").trim();
  if (!reason) throw new Error("archive: a reason is required (e.g. archive T1 \"obsolete\")");
  const as = flags.as;
  if (as === true) throw new Error("archive: --as requires a value (e.g. --as alice)");
  if (!as) throw new Error("archive: --as <agent> required");

  const projectDir = statePath;

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("archive: state file missing; run `climier init` first");
    const t = s.tasks[id];
    if (!t) throw new Error(`archive: task ${id} not found`);
    if (t.status === "archived") {
      throw new Error(`archive: task ${id} is already archived`);
    }
    if (t.status === "done") {
      // done is terminal; reopen rolls it back to in_progress if the decision was wrong.
      throw new Error(`archive: task ${id} is done (reopen it first if you want to revisit)`);
    }
    if (t.status === "in_progress") {
      // Same authority model as done/block: only the claimer, with the orchestrator/recovery
      // escape hatch (matches release/reopen). We don't let any agent silently kill
      // another agent's in-flight work.
      const isRecovery = as === "orchestrator" || as === "recovery";
      const isClaimer = t.claimed_by === as;
      if (!isClaimer && !isRecovery) {
        throw new Error(`archive: task ${id} is not yours (claimed by ${t.claimed_by || "(unknown)"})`);
      }
    }
    const archived_at = new Date().toISOString();
    const updated = await updateState(projectDir, (st) => {
      st.tasks[id].status = "archived";
      st.tasks[id].archived_at = archived_at;
      st.tasks[id].archived_by = as;
      st.tasks[id].archive_reason = reason;
      delete st.tasks[id].claimed_by;
      delete st.tasks[id].claimed_at;
      delete st.tasks[id].block_reason;
      return st;
    });
    await append(projectDir, { agent: as, action: "archive", task: id, note: reason });
    return { task: updated.tasks[id] };
  });
}
