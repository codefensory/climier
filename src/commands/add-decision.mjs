// add-decision: register a new decision in the state.
import { updateState, readState } from "../state.mjs";
import { withLock } from "../lock.mjs";

export const knownFlags = ["title", "initiative", "applies-to", "description"];

export default async function addDecision({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throw new Error("add-decision: decision id required (e.g. add-decision D1 --title 'pick library')");
  if (!flags.title) throw new Error("add-decision: --title required");
  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (s && s.decisions && s.decisions[id]) throw new Error(`add-decision: ${id} already exists`);
    const appliesToRaw = flags["applies-to"];
    const appliesTo = appliesToRaw
      ? appliesToRaw.split(",").map((x) => x.trim()).filter(Boolean)
      : undefined;
    const node = {
      id,
      title: flags.title,
      initiative: flags.initiative || undefined,
      description: flags.description || undefined,
      applies_to: appliesTo,
    };
    await updateState(projectDir, (st) => {
      st.decisions = st.decisions || {};
      st.decisions[id] = node;
      return st;
    });
    return { decision: node };
  });
}
