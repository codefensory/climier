// add-task: append a new task to the state.
import { updateState, readState } from "../state.mjs";
import { withLock } from "../lock.mjs";

export const knownFlags = ["initiative", "title", "depends-on", "definition", "acceptance", "skills", "effort", "domain"];

export default async function addTask({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throw new Error("add-task: task id required (e.g. add-task F1.T1 --initiative migration --title 'monorepo')");
  if (!flags.initiative) throw new Error("add-task: --initiative required");
  if (!flags.title) throw new Error("add-task: --title required");
  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (s && s.tasks[id]) throw new Error(`add-task: ${id} already exists`);
    const deps = flags["depends-on"]
      ? flags["depends-on"].split(",").map((x) => x.trim()).filter(Boolean)
      : [];
    // Validate that every declared dep points to an existing task or decision.
    // (If the state is empty, allow it; the user is starting from scratch.)
    if (s) {
      for (const dep of deps) {
        if (!s.tasks[dep] && !s.decisions[dep]) {
          throw new Error(`add-task: depends-on '${dep}' not found in tasks or decisions`);
        }
      }
    }
    const node = {
      id,
      title: flags.title,
      initiative: flags.initiative,
      definition: flags.definition || undefined,
      acceptance: flags.acceptance || undefined,
      skills: flags.skills ? flags.skills.split(",").map((x) => x.trim()).filter(Boolean) : [],
      effort: flags.effort || undefined,
      domain: flags.domain || undefined,
      depends_on: deps,
    };
    await updateState(projectDir, (st) => {
      st.tasks[id] = node;
      return st;
    });
    return { task: node };
  });
}
