// add-note: append a timestamped comment to a task or v2 node's notes thread. Any status.
// Notes are append-only by design — they are a record, not a state mutation.
import { isV2State, readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";

export const knownFlags = ["as"];

export default async function addNote({ statePath, flags, positional }) {
  const [id, ...rest] = positional;
  if (!id) throw new Error("add-note: node id required (e.g. add-note T1 'found a blocker')");
  const text = rest.join(" ").trim();
  if (!text) throw new Error("add-note: note text required (e.g. add-note T1 '...')");
  const as = flags.as;
  if (as === true) throw new Error("add-note: --as requires a value (e.g. --as alice)");
  if (!as) throw new Error("add-note: --as <agent> required");

  const projectDir = statePath;

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("add-note: state file missing; run `climier init` first");

    const note = { ts: new Date().toISOString(), agent: as, text };

    if (isV2State(s)) {
      const node = s.nodes[id];
      if (!node) throw new Error(`add-note: node ${id} not found`);
      const updated = await updateState(projectDir, (st) => {
        st.nodes[id].notes = st.nodes[id].notes || [];
        st.nodes[id].notes.push(note);
        return st;
      });
      await append(projectDir, { agent: as, action: "add-note", node: id, note: text });
      return { node: updated.nodes[id] };
    }

    const t = s.tasks[id];
    if (!t) throw new Error(`add-note: task ${id} not found`);
    const updated = await updateState(projectDir, (st) => {
      st.tasks[id].notes = st.tasks[id].notes || [];
      st.tasks[id].notes.push(note);
      return st;
    });
    await append(projectDir, { agent: as, action: "add-note", task: id, note: text });
    return { task: updated.tasks[id] };
  });
}
