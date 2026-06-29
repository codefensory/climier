// block: mark a blocker on a claimed task.
import { readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";

export const knownFlags = ["as"];

export default async function block({ statePath, flags, positional }) {
  const [id, ...rest] = positional;
  if (!id) throw new Error("block: task id required");
  if (rest.length === 0) throw new Error("block: a reason is required");
  const reason = rest.join(" ").trim();
  if (!reason) throw new Error("block: a non-empty reason is required");
  const as = flags.as;
  if (as === true) throw new Error("block: --as requires a value (e.g. --as alice)");
  if (!as) throw new Error("block: --as <agent> required");

  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("block: state file missing");
    const t = s.tasks[id];
    if (!t) throw new Error(`block: task ${id} not found`);
    if (t.status !== "in_progress") {
      throw new Error(`block: task ${id} is not in_progress (you can only block a claimed task)`);
    }
    if (t.claimed_by && t.claimed_by !== as) {
      throw new Error(`block: task ${id} is not yours (claimed by ${t.claimed_by})`);
    }
    await updateState(projectDir, (st) => {
      st.tasks[id].block_reason = reason;
      return st;
    });
    await append(projectDir, { agent: as, action: "block", task: id, note: reason });
    return { task: s.tasks[id] };
  });
}
