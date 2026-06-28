// release: free a claim without completing.
import { readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";

export default async function release({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throw new Error("release: task id required");
  const as = flags.as;
  if (!as) throw new Error("release: --as <agent> required");

  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("release: state file missing");
    const t = s.tasks[id];
    if (!t) throw new Error(`release: task ${id} not found`);
    if (t.status !== "in_progress") {
      throw new Error(`release: task ${id} is not in_progress`);
    }
    if (t.claimed_by !== as) {
      // Special case: orphan recovery. The orchestrator (or a designated recovery agent)
      // can release an in_progress task even if the original claimer is gone.
      const isOrphan = !t.claimed_by;
      const isRecovery = as === "orchestrator" || as === "recovery";
      if (!(isOrphan && isRecovery)) {
        throw new Error(`release: task ${id} is not yours (claimed by ${t.claimed_by})`);
      }
    }
    await updateState(projectDir, (st) => {
      delete st.tasks[id].claimed_by;
      delete st.tasks[id].claimed_at;
      delete st.tasks[id].block_reason;
      delete st.tasks[id].status;
      return st;
    });
    await append(projectDir, { agent: as, action: "release", task: id });
    return { task: s.tasks[id] };
  });
}
