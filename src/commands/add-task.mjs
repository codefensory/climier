// add-task: append a new task to the state.
import { updateState, readState } from "../state.mjs";
import { withLock } from "../lock.mjs";

export default async function addTask({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throw new Error("add-task: task id required (e.g. add-task F1.T1 --initiative migration --title 'monorepo')");
  if (!flags.initiative) throw new Error("add-task: --initiative required");
  if (!flags.title) throw new Error("add-task: --title required");
  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (s && s.tasks[id]) throw new Error(`add-task: ${id} already exists`);
    const node = {
      id,
      title: flags.title,
      initiative: flags.initiative,
      definition: flags.definition || undefined,
      acceptance: flags.acceptance || undefined,
      skills: flags.skills ? flags.skills.split(",").map((x) => x.trim()).filter(Boolean) : [],
      effort: flags.effort || undefined,
      domain: flags.domain || undefined,
      depends_on: flags["depends-on"] ? flags["depends-on"].split(",").map((x) => x.trim()).filter(Boolean) : [],
    };
    await updateState(projectDir, (st) => {
      st.tasks[id] = node;
      return st;
    });
    return { task: node };
  });
}
