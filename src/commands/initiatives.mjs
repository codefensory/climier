// initiatives: list registered initiatives with usage counts (tasks,
// decisions, gotchas) and detect orphan (unregistered) references —
// the smoking gun for typo-driven initiative drift. Read-only.
import { readState } from "../state.mjs";

export const knownFlags = [];

export default async function initiatives({ statePath, flags }) {
  const projectDir = statePath;
  const s = await readState(projectDir);
  if (!s) {
    return { initiatives: [], unregistered: { nodes: 0, values: [] } };
  }

  // Count usage per initiative name across tasks/decisions/gotchas.
  // `null`/undefined initiative fields (transversal nodes) are NOT counted
  // here — they're intentionally not in any initiative.
  const usage = new Map();
  const bump = (name, key) => {
    if (!name) return;
    const cur = usage.get(name) || { tasks: 0, decisions: 0, gotchas: 0 };
    cur[key] += 1;
    usage.set(name, cur);
  };
  for (const t of Object.values(s.tasks)) bump(t.initiative, "tasks");
  for (const d of Object.values(s.decisions || {})) bump(d.initiative, "decisions");
  for (const g of Object.values(s.gotchas || {})) bump(g.initiative, "gotchas");

  // Registered initiatives: always show, even with 0 usage, so you can
  // see what exists. Sort by task count desc, then name asc for stable
  // ordering when counts tie.
  const registered = Object.keys(s.initiatives || {}).map((name) => {
    const u = usage.get(name) || { tasks: 0, decisions: 0, gotchas: 0 };
    return {
      name,
      desc: s.initiatives[name]?.desc || "",
      tasks: u.tasks,
      decisions: u.decisions,
      gotchas: u.gotchas,
    };
  });
  registered.sort((a, b) => {
    if (b.tasks !== a.tasks) return b.tasks - a.tasks;
    return a.name.localeCompare(b.name);
  });

  // Unregistered: any name in `usage` that's not in `state.initiatives`.
  // This is the cleanup signal — typically caused by --initiative=qa typos
  // or by data written before validation existed.
  const registeredNames = new Set(Object.keys(s.initiatives || {}));
  const orphanValues = [...usage.keys()].filter((n) => !registeredNames.has(n)).sort();
  const orphanNodes = orphanValues.reduce((acc, n) => {
    const u = usage.get(n);
    return acc + u.tasks + u.decisions + u.gotchas;
  }, 0);

  return {
    initiatives: registered,
    unregistered: {
      nodes: orphanNodes,
      values: orphanValues,
    },
  };
}
