// add-gotcha: register a new gotcha in the state.
import { addNode, updateState, readState } from "../state.mjs";
import { withLock } from "../lock.mjs";

export default async function addGotcha({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throw new Error("add-gotcha: id required (e.g. add-gotcha G1 --title 'trap' --applies-to domain:db)");
  if (!flags.title) throw new Error("add-gotcha: --title required");
  if (!flags["applies-to"]) throw new Error("add-gotcha: --applies-to required (e.g. --applies-to domain:db or --applies-to T1)");
  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (s && s.gotchas && s.gotchas[id]) throw new Error(`add-gotcha: ${id} already exists`);
    const appliesTo = flags["applies-to"]
      .split(",").map((x) => x.trim()).filter(Boolean);
    const node = {
      id,
      title: flags.title,
      applies_to: appliesTo,
      initiative: flags.initiative || undefined,
      mitigation: flags.mitigation || undefined,
    };
    await updateState(projectDir, (st) => {
      st.gotchas = st.gotchas || {};
      st.gotchas[id] = node;
      return st;
    });
    return { gotcha: node };
  });
}
