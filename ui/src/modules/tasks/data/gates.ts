import { gatePurposeLabel, gatePurposeStyle } from "./gatePurposes";
import { statusLabel } from "./statuses";
import { taskFromNode } from "./climier/projection";
import type { ClimierEdge, ClimierNode, ClimierSnapshot } from "./climier/contract";
import type { BoardStatus, Task, TaskGroupView } from "../types";

export type GateRelation = Task & { edgeType?: ClimierEdge["type"] };

export type GateRecord = {
  task: Task;
  id: string;
  title: string;
  status: BoardStatus;
  statusLabel: string;
  purpose: string;
  purposeLabel: string;
  initiative: string | null;
  context: string;
  choice: string;
  rationale: string;
  blockedBy: GateRelation[];
  unblocks: GateRelation[];
  downstreamGates: GateRelation[];
  supersedeChain: GateRelation[];
  impactedTasks: GateRelation[];
  impactTasks: number;
  impactGates: number;
  totalImpact: number;
};

export type GateGroupMode = "initiative" | "purpose" | "chain";
export type GateRegistryGroup = TaskGroupView & { gates: GateRecord[]; totalImpact: number };

const GATE_STATUSES = new Set(["open", "resolved", "superseded", "canceled"]);
const GRAPH_EDGE_TYPES = new Set(["BLOCKS", "SUPERSEDES"]);
const nodesOf = (snapshot: ClimierSnapshot) => snapshot.nodes ?? {};
const edgesOf = (snapshot: ClimierSnapshot) => Array.isArray(snapshot.edges) ? snapshot.edges : [];

function relation(snapshot: ClimierSnapshot, node: ClimierNode, edgeType?: ClimierEdge["type"]): GateRelation {
  return { ...taskFromNode(snapshot, node), edgeType };
}

function supersedeMembers(snapshot: ClimierSnapshot, gateId: string): ClimierNode[] {
  const nodes = nodesOf(snapshot);
  const adjacent = new Map<string, Set<string>>();
  // Build an undirected supersede chain among gate nodes only.
  for (const edge of edgesOf(snapshot).filter((item) => item.type === "SUPERSEDES")) {
    if (nodes[edge.from]?.subkind !== "gate" || nodes[edge.to]?.subkind !== "gate") continue;
    if (!adjacent.has(edge.from)) adjacent.set(edge.from, new Set());
    if (!adjacent.has(edge.to)) adjacent.set(edge.to, new Set());
    adjacent.get(edge.from)?.add(edge.to);
    adjacent.get(edge.to)?.add(edge.from);
  }
  const seen = new Set<string>([gateId]);
  const queue = [gateId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of adjacent.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen].filter((id) => id !== gateId).map((id) => nodes[id]).filter((node): node is ClimierNode => Boolean(node)).sort((left, right) => left.id.localeCompare(right.id));
}

function downstream(snapshot: ClimierSnapshot, gateId: string): { tasks: GateRelation[]; gates: GateRelation[] } {
  const nodes = nodesOf(snapshot);
  const outgoing = new Map<string, ClimierEdge[]>();
  for (const edge of edgesOf(snapshot).filter((item) => item.type === "BLOCKS")) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from)?.push(edge);
  }
  const seen = new Set<string>([gateId]);
  const queue = [gateId];
  const tasks: GateRelation[] = [];
  const gates: GateRelation[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of outgoing.get(current) ?? []) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      const node = nodes[edge.to];
      if (!node) continue;
      if (node.kind === "resolvable" && node.subkind === "task") tasks.push(relation(snapshot, node, edge.type));
      if (node.kind === "resolvable" && node.subkind === "gate") gates.push(relation(snapshot, node, edge.type));
      queue.push(edge.to);
    }
  }
  return {
    tasks: tasks.sort((left, right) => left.id.localeCompare(right.id)),
    gates: gates.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

/** Connected gate threads over BLOCKS and SUPERSEDES, counting each graph component once. */
export function gateThreadCount(snapshot: ClimierSnapshot, includedGateIds?: Set<string>): number {
  const nodes = nodesOf(snapshot);
  const adjacent = new Map<string, Set<string>>();
  for (const edge of edgesOf(snapshot).filter((item) => GRAPH_EDGE_TYPES.has(item.type))) {
    if (!nodes[edge.from] || !nodes[edge.to]) continue;
    if (!adjacent.has(edge.from)) adjacent.set(edge.from, new Set());
    if (!adjacent.has(edge.to)) adjacent.set(edge.to, new Set());
    adjacent.get(edge.from)?.add(edge.to);
    adjacent.get(edge.to)?.add(edge.from);
  }
  const seen = new Set<string>();
  let count = 0;
  for (const node of Object.values(nodes).filter((item) => item.kind === "resolvable" && item.subkind === "gate" && (!includedGateIds || includedGateIds.has(item.id)))) {
    if (seen.has(node.id)) continue;
    const queue = [node.id];
    seen.add(node.id);
    while (queue.length) {
      for (const next of adjacent.get(queue.shift()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    count += 1;
  }
  return count;
}

/** Full gate history, including resolved, superseded and canceled nodes. */
export function projectGateRegistry(snapshot: ClimierSnapshot): GateRecord[] {
  const nodes = nodesOf(snapshot);
  const allEdges = edgesOf(snapshot);
  return Object.values(nodes)
    .filter((node) => node.kind === "resolvable" && node.subkind === "gate")
    .map((node) => {
      const task = taskFromNode(snapshot, node);
      const impact = downstream(snapshot, node.id);
      const blockedBy = allEdges
        .filter((edge) => edge.type === "BLOCKS" && edge.to === node.id)
        .map((edge) => nodes[edge.from])
        .filter((item): item is ClimierNode => Boolean(item))
        .map((item) => relation(snapshot, item, "BLOCKS"));
      const unblocks = allEdges
        .filter((edge) => edge.type === "BLOCKS" && edge.from === node.id)
        .map((edge) => nodes[edge.to])
        .filter((item): item is ClimierNode => Boolean(item))
        .map((item) => relation(snapshot, item, "BLOCKS"));
      const purpose = node.purpose ?? "";
      return {
        task,
        id: node.id,
        title: node.title || node.id,
        status: task.status,
        statusLabel: statusLabel(task.status),
        purpose,
        purposeLabel: gatePurposeLabel(purpose),
        initiative: node.initiative ?? null,
        context: String(node.body ?? "").split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim(),
        choice: node.resolution?.choice ?? "",
        rationale: node.resolution?.rationale ?? "",
        blockedBy,
        unblocks,
        downstreamGates: impact.gates,
        supersedeChain: supersedeMembers(snapshot, node.id).map((item) => relation(snapshot, item, "SUPERSEDES")),
        impactedTasks: impact.tasks,
        impactTasks: impact.tasks.length,
        impactGates: impact.gates.length,
        totalImpact: impact.tasks.length + impact.gates.length,
      } satisfies GateRecord;
    })
    .filter((gate) => GATE_STATUSES.has(String(gate.status)));
}

/** Group and rank gates by their total downstream impact. */
export function groupGateRecords(gates: GateRecord[], mode: GateGroupMode): GateRegistryGroup[] {
  const buckets = new Map<string, GateRecord[]>();
  const chainKeys = (gate: GateRecord) => [gate.id, ...gate.supersedeChain.map((item) => item.id)].sort();
  for (const gate of gates) {
    let key: string;
    if (mode === "initiative") key = gate.initiative ?? "none";
    else if (mode === "purpose") key = gate.purpose || "unspecified";
    else key = chainKeys(gate).join("|");
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)?.push(gate);
  }

  return [...buckets.entries()].map(([key, members]) => {
    const ordered = [...members].sort((left, right) => right.totalImpact - left.totalImpact || left.id.localeCompare(right.id));
    const closed = ordered.filter((gate) => gate.status === "resolved" || gate.status === "superseded").length;
    const progress = ordered.length ? Math.round((closed / ordered.length) * 100) : 0;
    const label = mode === "initiative"
      ? key === "none" ? "No initiative" : key
      : mode === "purpose"
        ? gatePurposeLabel(key === "unspecified" ? undefined : key)
        : ordered.length > 1 ? `${ordered[0].id} · ${ordered.length} gates` : ordered[0].title;
    const color = mode === "purpose"
      ? gatePurposeStyle(key).color
      : mode === "chain" ? "var(--color-tone-amber-ink)" : "var(--color-tone-blue-ink)";
    return {
      key,
      label,
      color,
      glyph: mode === "initiative" ? { kind: "initiative" as const, initiative: key } : { kind: "gate" as const },
      tasks: ordered.map((gate) => gate.task),
      gates: ordered,
      totalImpact: ordered.reduce((total, gate) => total + gate.totalImpact, 0),
      progress,
    };
  }).sort((left, right) => right.totalImpact - left.totalImpact || left.label.localeCompare(right.label));
}

export function blockedGateTaskCount(gates: GateRecord[]): number {
  return new Set(gates.flatMap((gate) => gate.impactedTasks.filter((task) => task.status === "blocked").map((task) => task.id))).size;
}
