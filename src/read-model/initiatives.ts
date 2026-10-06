import type { ReadModelNode, ReadModelSnapshot } from "./types.ts";

interface InitiativeUsage {
  tasks: number;
  knowledge: number;
  nodes: number;
}

function emptyUsage(): InitiativeUsage {
  return { tasks: 0, knowledge: 0, nodes: 0 };
}

function countInitiativeUsage(nodes: Record<string, ReadModelNode> | undefined): Map<string, InitiativeUsage> {
  const usage = new Map<string, InitiativeUsage>();
  for (const node of Object.values(nodes || {})) {
    const name = node && node.initiative;
    if (!name) {
      continue;
    }
    const current = usage.get(name) || emptyUsage();
    if (node.kind === "knowledge") {
      current.knowledge += 1;
    } else {
      current.tasks += 1;
    }
    current.nodes += 1;
    usage.set(name, current);
  }
  return usage;
}

function initiativeSummary(snapshot: ReadModelSnapshot, usage: Map<string, InitiativeUsage>, name: string) {
  const counts = usage.get(name) || emptyUsage();
  return {
    name,
    desc: snapshot.initiatives![name]?.desc || "",
    created_at: snapshot.initiatives![name]?.created_at || null,
    nodes: counts.nodes,
    tasks: counts.tasks,
    knowledge: counts.knowledge,
  };
}


interface ProjectInitiativesArgs {
  snapshot?: ReadModelSnapshot;
  all?: boolean;
}

export function projectInitiativesView({ snapshot = {}, all = false }: ProjectInitiativesArgs = {}) {
  const usage = countInitiativeUsage(snapshot?.nodes);
  const initiatives = Object.keys(snapshot?.initiatives || {})
    .map((name) => initiativeSummary(snapshot, usage, name))
    .filter((initiative) => all || initiative.nodes > 0)
    .toSorted((left, right) => right.nodes - left.nodes || left.name.localeCompare(right.name));
  return { initiatives, unregistered: { nodes: 0, values: [] }, all: Boolean(all) };
}
