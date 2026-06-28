// done: mark a claimed task complete.
import { readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";

export default async function done({ statePath, flags, positional }) {
  const [id, ...rest] = positional;
  if (!id) throw new Error("done: task id required");
  const note = rest.join(" ").trim();
  if (!note) throw new Error("done: a note is required (e.g. done T1 'shipped')");
  const as = flags.as;
  if (!as) throw new Error("done: --as <agent> required");

  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("done: state file missing");
    const t = s.tasks[id];
    if (!t) throw new Error(`done: task ${id} not found`);
    if (t.status !== "in_progress") {
      throw new Error(`done: task ${id} is not in_progress (status: ${t.status || "ready"})`);
    }
    if (t.claimed_by !== as) {
      throw new Error(`done: task ${id} is not yours (claimed by ${t.claimed_by})`);
    }
    const done_at = new Date().toISOString();
    const updated = await updateState(projectDir, (st) => {
      st.tasks[id].status = "done";
      st.tasks[id].done_at = done_at;
      st.tasks[id].done_by = as;
      st.tasks[id].note = note;
      delete st.tasks[id].claimed_by;
      delete st.tasks[id].claimed_at;
      delete st.tasks[id].block_reason;
      return st;
    });
    await append(projectDir, { agent: as, action: "done", task: id, note });
    return { task: updated.tasks[id] };
  });
}
