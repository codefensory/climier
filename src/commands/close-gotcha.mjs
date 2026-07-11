// close-gotcha: mark a gotcha as resolved. Soft delete: the node stays in
// state for the audit trail, but forTask and the `gotchas` view filter it out.
// Reopen with `reopen-gotcha` if you closed it by mistake. Idempotent:
// closing a gotcha that is already resolved is a no-op (no log entry).
import { readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";

export const knownFlags = ["as"];

export default async function closeGotcha({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throw new Error("close-gotcha: id required (e.g. close-gotcha G1 --as alice)");
  const as = flags.as;
  if (as === true) throw new Error("close-gotcha: --as requires a value (e.g. --as alice)");
  if (!as) throw new Error("close-gotcha: --as <agent> required");

  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("close-gotcha: state file missing; run `climier init` first");
    const g = s.gotchas && s.gotchas[id];
    if (!g) throw new Error(`close-gotcha: gotcha ${id} not found`);
    if (g.status === "resolved") {
      return { gotcha: g };
    }
    const updated = await updateState(projectDir, (st) => {
      st.gotchas[id].status = "resolved";
      return st;
    });
    await append(projectDir, { agent: as, action: "close-gotcha", gotcha: id });
    return { gotcha: updated.gotchas[id] };
  });
}
