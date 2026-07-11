// promote: move a task out of the backlog. Removes the `backlog: true` flag.
// Atomic + audited. Authority: any agent (--as required for the audit log).
// After promote, the task enters the normal DAG flow: ready if no unmet
// deps, blocked otherwise. The `promote` command is the only way to clear
// the flag — `update --backlog false` is a fine alternative for editing.
import { readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";

export const knownFlags = ["as"];

export default async function promote({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throw new Error("promote: task id required (e.g. promote T1 --as alice)");
  const as = flags.as;
  if (as === true) throw new Error("promote: --as requires a value (e.g. --as alice)");
  if (!as) throw new Error("promote: --as <agent> required (for the audit log)");

  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("promote: state file missing; run `climier init` first");
    const t = s.tasks[id];
    if (!t) throw new Error(`promote: task ${id} not found`);
    if (t.status === "in_progress") {
      throw new Error(`promote: task ${id} is in_progress (release it first)`);
    }
    if (t.status === "done") {
      throw new Error(`promote: task ${id} is done (reopen it first)`);
    }
    if (t.status === "archived") {
      throw new Error(`promote: task ${id} is archived (terminal)`);
    }
    if (!t.backlog) {
      throw new Error(`promote: task ${id} is not in backlog`);
    }
    const updated = await updateState(projectDir, (st) => {
      delete st.tasks[id].backlog;
      return st;
    });
    await append(projectDir, { agent: as, action: "promote", task: id });
    return { task: updated.tasks[id] };
  });
}
