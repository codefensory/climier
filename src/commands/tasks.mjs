// tasks: list all tasks with their derived status, optional filters.
import { readState } from "../state.mjs";
import { derive, statusOf } from "../dag.mjs";

export const knownFlags = ["initiative", "status"];

export default async function tasks({ statePath, flags }) {
  const projectDir = statePath;
  const s = await readState(projectDir);
  if (!s) return [];
  const out = [];
  for (const t of Object.values(s.tasks)) {
    if (flags.initiative && t.initiative !== flags.initiative) continue;
    const st = statusOf(s, t.id);
    if (flags.status && flags.status.toLowerCase() !== st) continue;
    out.push({
      id: t.id,
      title: t.title,
      initiative: t.initiative,
      status: st,
      depends_on: t.depends_on || [],
      claimed_by: t.claimed_by,
      priority: t.priority || "medium",
    });
  }
  return out;
}
