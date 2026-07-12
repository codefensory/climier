// ready: list claimable-now tasks (the orchestrator's delegation view).
import { readState } from "../state.mjs";
import { derive } from "../dag.mjs";

export const knownFlags = ["initiative"];

export default async function ready({ statePath, flags }) {
  const projectDir = statePath;
  const s = await readState(projectDir);
  if (!s) return [];
  const d = derive(s);
  let ids = d.ready;
  if (flags.initiative) ids = ids.filter((id) => s.tasks[id].initiative === flags.initiative);
  return ids.map((id) => {
    const t = s.tasks[id];
    return {
      id: t.id,
      title: t.title,
      initiative: t.initiative,
      skills: t.skills || [],
      effort: t.effort,
      domain: t.domain,
      depends_on: t.depends_on || [],
      // Absent priority is shown as "medium" so consumers don't have to
      // special-case missing. The state file itself never gets a default
      // written — the field stays absent unless the user sets it.
      priority: t.priority || "medium",
    };
  });
}
