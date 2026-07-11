// reopen-gotcha: undo a close. Removes the resolved status so the gotcha
// surfaces again in forTask and the `gotchas` view. No-op (no log entry)
// if the gotcha is not currently resolved.
import { readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";

export const knownFlags = ["as"];

export default async function reopenGotcha({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throw new Error("reopen-gotcha: id required (e.g. reopen-gotcha G1 --as alice)");
  const as = flags.as;
  if (as === true) throw new Error("reopen-gotcha: --as requires a value (e.g. --as alice)");
  if (!as) throw new Error("reopen-gotcha: --as <agent> required");

  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("reopen-gotcha: state file missing; run `climier init` first");
    const g = s.gotchas && s.gotchas[id];
    if (!g) throw new Error(`reopen-gotcha: gotcha ${id} not found`);
    if (g.status !== "resolved") {
      return { gotcha: g };
    }
    const updated = await updateState(projectDir, (st) => {
      delete st.gotchas[id].status;
      return st;
    });
    await append(projectDir, { agent: as, action: "reopen-gotcha", gotcha: id });
    return { gotcha: updated.gotchas[id] };
  });
}
