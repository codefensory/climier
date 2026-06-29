// decide: close a decision; unblocks tasks that depend on it.
import { readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";

export const knownFlags = ["as", "because"];

export default async function decide({ statePath, flags, positional }) {
  const [id, ...rest] = positional;
  if (!id) throw new Error("decide: decision id required");
  if (rest.length === 0) throw new Error("decide: a choice is required (e.g. decide D1 'raw-postgres')");
  const choice = rest.join(" ");
  // --as is optional for decide (defaults to orchestrator) but if provided must be a non-empty string.
  if (flags.as === true) {
    throw new Error("decide: --as requires a value (e.g. --as orchestrator or --as alice)");
  }
  if (flags.as !== undefined && flags.as === "") {
    throw new Error("decide: --as cannot be empty");
  }
  const as = flags.as || "orchestrator";
  const because = flags.because || "";

  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("decide: state file missing");
    const d = s.decisions[id];
    if (!d) throw new Error(`decide: decision ${id} not found`);
    if (d.status === "decided") {
      throw new Error(`decide: ${id} is already decided (${d.choice})`);
    }
    const decided_at = new Date().toISOString();
    const updated = await updateState(projectDir, (st) => {
      st.decisions[id].status = "decided";
      st.decisions[id].choice = choice;
      st.decisions[id].rationale = because;
      st.decisions[id].decided_at = decided_at;
      st.decisions[id].decided_by = as;
      return st;
    });
    await append(projectDir, { agent: as, action: "decide", decision: id, note: `${choice}${because ? " — " + because : ""}` });
    return { decision: updated.decisions[id] };
  });
}
