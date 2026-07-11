// claim: atomically reserve a ready task.
import { readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { derive } from "../dag.mjs";
import { append } from "../log.mjs";

export const knownFlags = ["as"];

export default async function claim({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throw new Error("claim: task id required");
  const as = flags.as;
  if (as === true) throw new Error("claim: --as requires a value (e.g. --as alice)");
  if (!as) throw new Error("claim: --as <agent> required");

  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("claim: state file missing; run `climier init` first");
    const t = s.tasks[id];
    if (!t) throw new Error(`claim: task ${id} not found`);
    if (t.backlog === true) {
      throw new Error(`claim: task ${id} is in backlog (run 'climier promote ${id}' first)`);
    }
    if (t.status === "in_progress") {
      throw new Error(`claim: task ${id} already in progress by ${t.claimed_by || "(unknown)"}`);
    }
    if (t.status === "done" || t.status === "archived") {
      throw new Error(`claim: task ${id} is already ${t.status}`);
    }
    const d = derive(s);
    if (!d.ready.includes(id)) {
      throw new Error(`claim: task ${id} is not ready (deps not met)`);
    }
    const claimed_at = Date.now();
    const updated = await updateState(projectDir, (st) => {
      st.tasks[id].status = "in_progress";
      st.tasks[id].claimed_by = as;
      st.tasks[id].claimed_at = claimed_at;
      return st;
    });
    await append(projectDir, { agent: as, action: "claim", task: id });
    return { task: updated.tasks[id] };
  });
}
