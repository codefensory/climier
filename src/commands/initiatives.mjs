// initiatives: list registered initiatives with usage counts.
// v1: also surfaces orphan (unregistered) references in tasks/decisions/gotchas.
// v2: only v2 nodes exist; counts both resolvable and knowledge nodes per initiative.
// --all includes initiatives with zero live nodes (default hides them, per the
// v2 design doc: "Por defecto muestra solo initiatives con nodos vivos").
import { readState, isV2State } from "../state.mjs";

export const knownFlags = ["all"];

export default async function initiatives({ statePath, flags }) {
  const projectDir = statePath;
  const s = await readState(projectDir);
  if (!s) {
    return { initiatives: [], unregistered: { nodes: 0, values: [] } };
  }

  if (isV2State(s)) {
    const usage = new Map();
    for (const node of Object.values(s.nodes || {})) {
      const name = node && node.initiative;
      if (!name) continue;
      const cur = usage.get(name) || { tasks: 0, knowledge: 0, nodes: 0 };
      if (node.kind === "knowledge") cur.knowledge += 1;
      else cur.tasks += 1;
      cur.nodes += 1;
      usage.set(name, cur);
    }
    const registered = Object.keys(s.initiatives || {}).map((name) => {
      const u = usage.get(name) || { tasks: 0, knowledge: 0, nodes: 0 };
      return {
        name,
        desc: s.initiatives[name]?.desc || "",
        created_at: s.initiatives[name]?.created_at || null,
        nodes: u.nodes,
        tasks: u.tasks,
        knowledge: u.knowledge,
      };
    });
    const all = flags.all === true || flags.all === "true";
    const visible = all ? registered : registered.filter((r) => r.nodes > 0);
    visible.sort((a, b) => {
      if (b.nodes !== a.nodes) return b.nodes - a.nodes;
      return a.name.localeCompare(b.name);
    });
    return {
      initiatives: visible,
      unregistered: { nodes: 0, values: [] },
      all: !!all,
    };
  }

  // v1 path (unchanged)
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
