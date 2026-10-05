import type { ClimierKnowledgeStatus, ClimierNode, ClimierSnapshot } from "./climier/contract";
import { scopeMatches, taskFromNode } from "./climier/projection";
import type { BoardStatus, Task } from "../types";

export type KnowledgeAxis = "node" | "domain" | "tag" | "initiative";
export type KnowledgeGroupMode = "initiative" | "scope";

export type KnowledgeAxisCoverage = {
  axis: KnowledgeAxis;
  values: string[];
  nodeIds: string[];
  count: number;
};

export type KnowledgeReach = {
  id: string;
  title: string;
  kind: "task" | "gate";
  status: BoardStatus;
  task: Task;
};

export type KnowledgeRecord = {
  node: ClimierNode;
  id: string;
  title: string;
  body: string;
  knowledgeType: string;
  status: ClimierKnowledgeStatus;
  initiative: string | null;
  revision: number;
  chars: number;
  axes: KnowledgeAxisCoverage[];
  declaredAxis: KnowledgeAxis | null;
  effectiveAxis: KnowledgeAxis | null;
  coveredIds: string[];
  taskCount: number;
  gateCount: number;
  coverage: number;
  reaches: KnowledgeReach[];
  supersedeChain: KnowledgeRecord[];
};

export type KnowledgeRegistryGroup = {
  key: string;
  label: string;
  color: string;
  glyph: { kind: "initiative"; initiative: string } | { kind: "scope" };
  tasks: Task[];
  count: number;
  progress: number;
  hideProgress: true;
  knowledges: KnowledgeRecord[];
  coverage: number;
};

export type KnowledgeRegistrySummary = {
  active: number;
  superseded: number;
  deprecated: number;
  coveredNodes: number;
  resolvableNodes: number;
  supersessionChains: number;
  initiativesWithoutKnowledge: number;
};

const AXIS_ORDER: KnowledgeAxis[] = ["node", "domain", "tag", "initiative"];
const AXIS_LABELS: Record<KnowledgeAxis, string> = {
  node: "Node ids",
  domain: "Domains",
  tag: "Tags",
  initiative: "Initiatives",
};
const AXIS_SCOPE: Record<KnowledgeAxis, keyof NonNullable<ClimierNode["scope"]>> = {
  node: "node_ids",
  domain: "domains",
  tag: "tags",
  initiative: "initiatives",
};
const AXIS_ROW_LABEL: Record<KnowledgeAxis, string> = {
  node: "Node-scoped",
  domain: "Domain-scoped",
  tag: "Tag-scoped",
  initiative: "Initiative-wide",
};
const REACH_PRIORITY: Partial<Record<BoardStatus, number>> = {
  blocked: 0,
  in_progress: 1,
  submitted: 2,
  ready: 3,
  backlog: 4,
  open: 5,
  done: 6,
  resolved: 7,
  superseded: 8,
  canceled: 9,
  archived: 10,
};
const nodesOf = (snapshot: ClimierSnapshot) => snapshot.nodes ?? {};
const edgesOf = (snapshot: ClimierSnapshot) => Array.isArray(snapshot.edges) ? snapshot.edges : [];

function resolvableNodes(snapshot: ClimierSnapshot): ClimierNode[] {
  return Object.values(nodesOf(snapshot)).filter((node) => node.kind === "resolvable" && (node.subkind === "task" || node.subkind === "gate"));
}

function declaredAxes(node: ClimierNode): KnowledgeAxisCoverage[] {
  return AXIS_ORDER.flatMap((axis) => {
    const values = [...new Set(node.scope?.[AXIS_SCOPE[axis]] ?? [])];
    return values.length ? [{ axis, values, nodeIds: [], count: 0 }] : [];
  });
}

function axisMatches(node: ClimierNode, knowledge: ClimierNode, axis: KnowledgeAxis): boolean {
  return scopeMatches(node, knowledge).includes(axis);
}

function effectiveAxis(axes: KnowledgeAxisCoverage[]): KnowledgeAxis | null {
  return [...axes].sort((left, right) => right.count - left.count || AXIS_ORDER.indexOf(left.axis) - AXIS_ORDER.indexOf(right.axis))[0]?.axis ?? null;
}

function chainFor(snapshot: ClimierSnapshot, id: string): ClimierNode[] {
  const nodes = nodesOf(snapshot);
  const links = edgesOf(snapshot).filter((edge) => edge.type === "SUPERSEDES" && nodes[edge.from]?.kind === "knowledge" && nodes[edge.to]?.kind === "knowledge");
  const component = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of links) {
      if (component.has(edge.from) && !component.has(edge.to)) { component.add(edge.to); changed = true; }
      if (component.has(edge.to) && !component.has(edge.from)) { component.add(edge.from); changed = true; }
    }
  }
  if (component.size < 2) return [];
  const latest = [...component].find((member) => !links.some((edge) => edge.to === member && component.has(edge.from))) ?? id;
  const ordered: string[] = [];
  let current: string | undefined = latest;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    ordered.push(current);
    current = links.find((edge) => edge.from === current && component.has(edge.to))?.to;
  }
  return ordered.reverse().map((member) => nodes[member]).filter((node): node is ClimierNode => Boolean(node));
}

function chainCount(snapshot: ClimierSnapshot): number {
  const nodes = nodesOf(snapshot);
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edgesOf(snapshot).filter((item) => item.type === "SUPERSEDES" && nodes[item.from]?.kind === "knowledge" && nodes[item.to]?.kind === "knowledge")) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  }
  const seen = new Set<string>();
  let count = 0;
  for (const id of adjacency.keys()) {
    if (seen.has(id)) continue;
    const queue = [id];
    seen.add(id);
    let size = 0;
    while (queue.length) {
      size += 1;
      for (const next of adjacency.get(queue.shift()!) ?? []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    if (size > 1) count += 1;
  }
  return count;
}

/** Project all knowledge and its resolvable reach from the snapshot's existing scope matcher. */
export function projectKnowledgeRegistry(snapshot: ClimierSnapshot): KnowledgeRecord[] {
  const resolvables = resolvableNodes(snapshot);
  const records = Object.values(nodesOf(snapshot)).filter((node) => node.kind === "knowledge").map((node) => {
    const axes = declaredAxes(node).map((axis) => {
      const matches = resolvables.filter((candidate) => axisMatches(candidate, node, axis.axis)).map((candidate) => candidate.id);
      return { ...axis, nodeIds: matches, count: matches.length };
    });
    const coveredIds = resolvables.filter((candidate) => scopeMatches(candidate, node).length > 0).map((candidate) => candidate.id);
    const reaches = coveredIds.map((nodeId) => {
      const reached = nodesOf(snapshot)[nodeId];
      const task = taskFromNode(snapshot, reached);
      return { id: reached.id, title: reached.title || reached.id, kind: reached.subkind === "gate" ? "gate" as const : "task" as const, status: task.status, task };
    }).sort((left, right) => (REACH_PRIORITY[left.status] ?? 11) - (REACH_PRIORITY[right.status] ?? 11) || left.id.localeCompare(right.id));
    const axisOrder = axes.map((axis) => axis.axis);
    return {
      node,
      id: node.id,
      title: node.title || node.id,
      body: node.body ?? "",
      knowledgeType: node.knowledge_type ?? "note",
      status: (node.status === "deprecated" || node.status === "superseded" ? node.status : "active") as ClimierKnowledgeStatus,
      initiative: node.initiative ?? node.scope?.initiatives?.[0] ?? null,
      revision: node.revision ?? 0,
      chars: (node.body ?? "").length,
      axes,
      declaredAxis: AXIS_ORDER.find((axis) => axisOrder.includes(axis)) ?? null,
      effectiveAxis: effectiveAxis(axes),
      coveredIds,
      taskCount: reaches.filter((reach) => reach.kind === "task").length,
      gateCount: reaches.filter((reach) => reach.kind === "gate").length,
      coverage: reaches.length,
      reaches,
      supersedeChain: [] as KnowledgeRecord[],
    } satisfies KnowledgeRecord;
  });
  const byId = new Map(records.map((record) => [record.id, record]));
  return records.map((record) => ({
    ...record,
    supersedeChain: chainFor(snapshot, record.id).map((node) => byId.get(node.id)).filter((item): item is KnowledgeRecord => Boolean(item)),
  }));
}

export function knowledgeAxisLabel(axis: KnowledgeAxis | null): string {
  return axis ? AXIS_ROW_LABEL[axis] : "No declared scope";
}

export function knowledgeAxisName(axis: KnowledgeAxis): string {
  return AXIS_LABELS[axis];
}

export function knowledgeStatusLabel(status: ClimierKnowledgeStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function groupKnowledgeRecords(records: KnowledgeRecord[], mode: KnowledgeGroupMode): KnowledgeRegistryGroup[] {
  const buckets = new Map<string, KnowledgeRecord[]>();
  for (const record of records) {
    const key = mode === "initiative"
      ? record.initiative ?? "none"
      : record.axes.length ? record.axes.map((axis) => axis.axis).join("+") : "none";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)?.push(record);
  }
  return [...buckets.entries()].map(([key, members]) => {
    const ordered = [...members].sort((left, right) => right.coverage - left.coverage || left.id.localeCompare(right.id));
    const label = mode === "initiative"
      ? key === "none" ? "No initiative" : key
      : key === "none" ? "No scope" : key.split("+").map((axis, index) => {
        const label = AXIS_LABELS[axis as KnowledgeAxis].toLowerCase();
        return index === 0 ? label.charAt(0).toUpperCase() + label.slice(1) : label;
      }).join(" + ");
    const glyph = mode === "initiative" ? { kind: "initiative" as const, initiative: key } : { kind: "scope" as const };
    return {
      key,
      label,
      color: "var(--color-tone-blue-ink)",
      glyph,
      tasks: [],
      count: ordered.length,
      progress: 0,
      hideProgress: true as const,
      knowledges: ordered,
      coverage: mode === "scope"
        ? ordered.reduce((sum, item) => sum + item.coverage, 0)
        : new Set(ordered.flatMap((item) => item.coveredIds)).size,
    };
  }).sort((left, right) => right.coverage - left.coverage || left.label.localeCompare(right.label));
}

export function knowledgeRegistrySummary(snapshot: ClimierSnapshot, records = projectKnowledgeRegistry(snapshot)): KnowledgeRegistrySummary {
  const resolvables = resolvableNodes(snapshot);
  const covered = new Set(records.flatMap((record) => record.coveredIds));
  const knownInitiatives = new Set(records.map((record) => record.initiative).filter((value): value is string => Boolean(value)));
  return {
    active: records.filter((record) => record.status === "active").length,
    superseded: records.filter((record) => record.status === "superseded").length,
    deprecated: records.filter((record) => record.status === "deprecated").length,
    coveredNodes: covered.size,
    resolvableNodes: resolvables.length,
    supersessionChains: chainCount(snapshot),
    initiativesWithoutKnowledge: Object.keys(snapshot.initiatives ?? {}).filter((initiative) => !knownInitiatives.has(initiative)).length,
  };
}

export function isKnowledgeStatus(value: string): value is ClimierKnowledgeStatus {
  return value === "active" || value === "superseded" || value === "deprecated";
}

