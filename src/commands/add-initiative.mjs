// add-initiative: register an initiative with description.
import { updateState, readState } from "../state.mjs";
import { withLock } from "../lock.mjs";

export default async function addInitiative({ statePath, flags, positional }) {
  const [name] = positional;
  if (!name) throw new Error("add-initiative: name required (e.g. add-initiative migration --desc 'the big move')");
  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");

  return withLock(projectDir, async () => {
    await updateState(projectDir, (st) => {
      st.initiatives[name] = st.initiatives[name] || { desc: flags.desc || "" };
      if (flags.desc) st.initiatives[name].desc = flags.desc;
      return st;
    });
    return { initiative: { name, desc: flags.desc || "" } };
  });
}
