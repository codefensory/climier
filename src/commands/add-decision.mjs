// add-decision: register a new decision in the state.
import { updateState, readState, assertInitiativeRegistered, isV2State } from "../state.mjs";
import { withLock } from "../lock.mjs";

export const knownFlags = ["title", "initiative", "applies-to", "description"];

export default async function addDecision({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throw new Error("add-decision: decision id required (e.g. add-decision D1 --title 'pick library')");
  if (!flags.title) throw new Error("add-decision: --title required");
  const projectDir = statePath;

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    // v2 projects model decisions as gates (kind=resolvable, subkind=gate,
    // purpose=decision). Reject before any state write so v2 callers get a
    // clear pointer to the right command instead of a silent v1-style field.
    if (s && isV2State(s)) {
      throw new Error("add-decision: v1-only command; on v2 use `add-gate --purpose decision` instead");
    }
    if (s && s.decisions && s.decisions[id]) throw new Error(`add-decision: ${id} already exists`);
    // initiative is optional (decisions can be transversal), but if given
    // it must refer to a registered initiative.
    if (flags.initiative) {
      assertInitiativeRegistered(s, flags.initiative, "add-decision");
    }
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
