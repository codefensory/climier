// reopen: roll back a done task to in_progress. Authority: orchestrator OR the
// original done_by agent. The point is to correct the DAG: reopening T1
// re-blocks every task that depends on T1, instead of leaving them unblocked
// on a "done" foundation that is no longer true.
import { readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";

export const knownFlags = ["as"];

export default async function reopen({ statePath, flags, positional }) {
  const [id, ...rest] = positional;
  if (!id) throw new Error("reopen: task id required");
  const reason = rest.join(" ").trim();
  if (!reason) throw new Error("reopen: a reason is required");
  const as = flags.as;
  if (!as) throw new Error("reopen: --as <agent> required");

  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("reopen: state file missing");
    const t = s.tasks[id];
    if (!t) throw new Error(`reopen: task ${id} not found`);
    if (t.status !== "done") {
      throw new Error(`reopen: task ${id} is not done (status: ${t.status || "ready"})`);
    }
    const isOrchestrator = as === "orchestrator" || as === "recovery";
    const isSelf = t.done_by && t.done_by === as;
    if (!isOrchestrator && !isSelf) {
      throw new Error(
        `reopen: task ${id} is not authorized (only orchestrator or the original done_by can reopen; done_by is ${t.done_by || "(none)"})`,
      );
    }
    const claimed_at = Date.now();
    const updated = await updateState(projectDir, (st) => {
      st.tasks[id].status = "in_progress";
      st.tasks[id].claimed_by = as;
      st.tasks[id].claimed_at = claimed_at;
      delete st.tasks[id].done_at;
      delete st.tasks[id].done_by;
      delete st.tasks[id].note;
      delete st.tasks[id].block_reason;
      return st;
    });
    await append(projectDir, { agent: as, action: "reopen", task: id, note: reason });
    return { task: updated.tasks[id] };
  });
}
