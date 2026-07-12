// next: task definition + acceptance + gotchas for a given task.
import { readState } from "../state.mjs";
import { forTask } from "../gotchas.mjs";

export const knownFlags = [];

export default async function next({ statePath, positional }) {
  const [id] = positional;
  if (!id) throw new Error("next: task id required");
  const projectDir = statePath;
  const s = await readState(projectDir);
  if (!s) throw new Error("next: state file missing");
  const t = s.tasks[id];
  if (!t) throw new Error(`next: task ${id} not found`);
  const title = (t.title && t.title.trim()) || "(no title)";
  return {
    id: t.id,
    title,
    initiative: t.initiative,
    definition: t.definition || title || "(no definition)",
    acceptance: t.acceptance || "(no acceptance criteria defined)",
    depends_on: t.depends_on || [],
    skills: t.skills || [],
    domain: t.domain,
    gotchas: forTask(s, t),
  };
}
