import { outgoing } from "../kernel/graph.ts";
import {
  blockingForNode,
  derive,
  informingForNode,
  isCurrent,
  knowledgeForNode,
  statusOf,
  supersededBy,
} from "./core.ts";
import type { ReadModelLogEntry, ReadModelNode, ReadModelRef, ReadModelSnapshot } from "./types.ts";

const DEFAULT_ACTIVITY_LIMIT = 50;

type UiProject = string | null | undefined | {
  id?: string;
  project_id?: string;
  name?: string;
  revision?: number;
  generated_at?: string;
};

interface UiDerived {
  ready: string[];
  blocked: string[];
  backlog: string[];
  openGates: string[];
  submitted: string[];
}

export interface UiAlert {
  kind: string;
  severity: string;
  node_id: string;
  claimed_by: string;
  age_ms: number;
  message: string;
}

export interface UiSummary {
  ready: number;
  in_progress: number;
  submitted: number;
  blocked: number;
  backlog: number;
  placeholders: number;
  stale: number;
  open_gates: number;
  open_decisions: number;
  done: number;
  archived: number;
  canceled: number;
  resolved_gates: number;
  superseded: number;
  active_knowledge: number;
  deprecated_knowledge: number;
  total_nodes: number;
}

export interface InitiativeSlot {
  initiative: string;
  total: number;
  by_kind: {
    tasks: Record<string, number>;
    gates: Record<string, number>;
    knowledge: Record<string, number>;
  };
}

interface ActivityFilters {
  action?: string;
  agent?: string;
  node?: string;
  initiative?: string;
  q?: string;
}

interface RefDefaults {
  type?: string;
  source?: string;
}

interface UiProjectSnapshotArgs {
  snapshot?: ReadModelSnapshot;
  project?: UiProject;
  now?: number;
  activityLimit?: number;
  staleMs?: number;
}

interface UiNodeArgs {
  snapshot?: ReadModelSnapshot;
  id?: string;
}

interface UiActivityArgs {
  snapshot?: ReadModelSnapshot;
  filters?: ActivityFilters;
  limit?: number;
  offset?: number;
}
const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

function nodesOf(snapshot: ReadModelSnapshot | undefined): Record<string, ReadModelNode> {
  return snapshot?.nodes && typeof snapshot.nodes === "object" && !Array.isArray(snapshot.nodes)
    ? snapshot.nodes
    : {};
}

function edgesOf(snapshot: ReadModelSnapshot | undefined) {
  return Array.isArray(snapshot?.edges) ? snapshot.edges : [];
}

function logOf(snapshot: ReadModelSnapshot | undefined): ReadModelLogEntry[] {
  return Array.isArray(snapshot?.log) ? snapshot.log : [];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function projectIdOf(project: UiProject): string {
  if (typeof project === "string") {
    return project;
  }
  return project?.id ?? project?.project_id ?? "";
}

function projectNameOf(project: UiProject, id: string): string {
  if (project && typeof project === "object" && typeof project.name === "string" && project.name.length > 0) {
    return project.name;
  }
  return id;
}

function revisionOf(snapshot: ReadModelSnapshot | undefined, project: UiProject): number {
  if (project && typeof project === "object" && typeof project.revision === "number" && Number.isInteger(project.revision) && project.revision >= 0) {
    return project.revision;
  }
  const revision = snapshot?.revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function generatedAt(now: number | undefined, project: UiProject): string {
  if (project && typeof project === "object" && typeof project.generated_at === "string") {
    return project.generated_at;
  }
  if (!Number.isFinite(now)) {
    throw new TypeError("read-model ui: now epoch-ms is required");
  }
  return new Date(now as number).toISOString();
}

function claimBy(node: ReadModelNode): string | null {
  if (node.claim && typeof node.claim === "object" && node.claim.by) {
    return node.claim.by;
  }
  return node.claimed_by || null;
}

function claimAtMs(node: ReadModelNode): number | null {
  const at = node?.claim?.at ?? node?.claimed_at;
  if (typeof at === "number") {
    return Number.isFinite(at) ? at : null;
  }
  if (typeof at === "string") {
    const parsed = Date.parse(at);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function staleClaim(node: ReadModelNode, now: number | undefined, staleMs: number): UiAlert | null {
  if (node?.kind !== "resolvable" || node.subkind !== "task" || (node.status || "open") !== "in_progress") {
    return null;
  }
  const by = claimBy(node);
  const at = claimAtMs(node);
  if (!by || at === null || (now as number) - at <= staleMs) {
    return null;
  }
  return {
    kind: "stale-claim",
    severity: "warning",
    node_id: node.id,
    claimed_by: by,
    age_ms: (now as number) - at,
    message: `${node.id} claimed by ${by} is stale (${Math.round(((now as number) - at) / 60000)}m old)`,
  };
}

function zeroSummary(): UiSummary {
  return {
    ready: 0,
    in_progress: 0,
    submitted: 0,
    blocked: 0,
    backlog: 0,
    placeholders: 0,
    stale: 0,
    open_gates: 0,
    open_decisions: 0,
    done: 0,
    archived: 0,
    canceled: 0,
    resolved_gates: 0,
    superseded: 0,
    active_knowledge: 0,
    deprecated_knowledge: 0,
    total_nodes: 0,
  };
}

function taskNodes(nodes: Record<string, ReadModelNode>): ReadModelNode[] {
  return Object.values(nodes).filter((node) => node?.kind === "resolvable" && node.subkind === "task");
}

function gateNodes(nodes: Record<string, ReadModelNode>): ReadModelNode[] {
  return Object.values(nodes).filter((node) => node?.kind === "resolvable" && node.subkind === "gate");
}

function knowledgeNodes(nodes: Record<string, ReadModelNode>): ReadModelNode[] {
  return Object.values(nodes).filter((node) => node?.kind === "knowledge");
}

function summaryOf(nodes: Record<string, ReadModelNode>, derived: UiDerived, alerts: UiAlert[]): UiSummary {
  const tasks = taskNodes(nodes);
  const gates = gateNodes(nodes);
  const knowledge = knowledgeNodes(nodes);
  const summary = zeroSummary();
  summary.ready = derived.ready.length;
  summary.in_progress = tasks.filter((node) => (node.status || "open") === "in_progress").length;
  summary.submitted = derived.submitted.length;
  summary.blocked = derived.blocked.length;
  summary.backlog = derived.backlog.length;
  summary.placeholders = tasks.filter((node) => node.placeholder === true).length;
  summary.stale = alerts.filter((alert) => alert.kind === "stale-claim").length;
  summary.open_gates = derived.openGates.length;
  summary.open_decisions = gates.filter((node) => (node.status || "open") === "open" && node.purpose === "decision").length;
  summary.done = tasks.filter((node) => node.status === "done").length;
  summary.archived = tasks.filter((node) => node.status === "archived").length;
  summary.canceled = tasks.filter((node) => node.status === "canceled").length;
  summary.resolved_gates = gates.filter((node) => node.status === "resolved").length;
  summary.superseded = Object.values(nodes).filter((node) => node.status === "superseded").length;
  summary.active_knowledge = knowledge.filter((node) => (node.status || "active") !== "deprecated").length;
  summary.deprecated_knowledge = knowledge.filter((node) => node.status === "deprecated").length;
  summary.total_nodes = Object.values(nodes).length;
  return summary;
}

function initiativeSlot(name: string): InitiativeSlot {
  return {
    initiative: name,
    total: 0,
    by_kind: {
      tasks: { total: 0, ready: 0, in_progress: 0, submitted: 0, blocked: 0, backlog: 0, done: 0, archived: 0, canceled: 0 },
      gates: { total: 0, open: 0, resolved: 0, superseded: 0 },
      knowledge: { total: 0, active: 0, deprecated: 0 },
    },
  };
}

function initiativeSummary(snapshot: ReadModelSnapshot | undefined, derived: UiDerived): InitiativeSlot[] {
  const nodes = nodesOf(snapshot);
  const ready = new Set(derived.ready);
  const blocked = new Set(derived.blocked);
  const backlog = new Set(derived.backlog);
  const submitted = new Set(derived.submitted);
  const byInitiative = new Map<string, InitiativeSlot>();
  for (const node of Object.values(nodes)) {
    if (!node?.initiative) {
      continue;
    }
    const current = byInitiative.get(node.initiative) || initiativeSlot(node.initiative);
    current.total += 1;
    if (node.kind === "knowledge") {
      current.by_kind.knowledge.total += 1;
      if ((node.status || "active") === "deprecated") {
        current.by_kind.knowledge.deprecated += 1;
      } else {
        current.by_kind.knowledge.active += 1;
      }
    } else if (node.kind === "resolvable" && node.subkind === "gate") {
      current.by_kind.gates.total += 1;
      const status = node.status || "open";
      if (status === "resolved") {
        current.by_kind.gates.resolved += 1;
      } else if (status === "superseded") {
        current.by_kind.gates.superseded += 1;
      } else {
        current.by_kind.gates.open += 1;
      }
    } else if (node.kind === "resolvable" && node.subkind === "task") {
      const tasks = current.by_kind.tasks;
      tasks.total += 1;
      const status = node.status || "open";
      if (status === "in_progress") tasks.in_progress += 1;
      else if (status === "submitted") tasks.submitted += 1;
      else if (status === "done") tasks.done += 1;
      else if (status === "archived") tasks.archived += 1;
      else if (status === "canceled") tasks.canceled += 1;
      else if (backlog.has(node.id)) tasks.backlog += 1;
      else if (ready.has(node.id)) tasks.ready += 1;
      else if (blocked.has(node.id)) tasks.blocked += 1;
      else if (submitted.has(node.id)) tasks.submitted += 1;
    }
    byInitiative.set(node.initiative, current);
  }
  return [...byInitiative.values()].sort((left, right) => right.total - left.total || left.initiative.localeCompare(right.initiative));
}

function normalizeActivityEntry(
  snapshot: ReadModelSnapshot | undefined,
  entry: ReadModelLogEntry,
): ReadModelLogEntry & { node_id: string | null; node_title: string | null } {
  const nodes = nodesOf(snapshot);
  const id = entry?.node || entry?.task || null;
  const node = id ? nodes[id] : null;
  return {
    ...clone(entry),
    node_id: id,
    node_title: node ? node.title || null : null,
  };
}

function recentActivity(snapshot: ReadModelSnapshot | undefined, limit: number) {
  return logOf(snapshot).slice(-limit).reverse().map((entry) => normalizeActivityEntry(snapshot, entry));
}

function lastActivity(snapshot: ReadModelSnapshot | undefined): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const entry of logOf(snapshot)) {
    const id = entry?.node || entry?.task;
    if (!id) {
      continue;
    }
    const activity: Record<string, unknown> = {};
    for (const key of ["action", "agent", "ts", "note"]) {
      if (entry[key] !== undefined) {
        activity[key] = entry[key];
      }
    }
    result[id] = activity;
  }
  return result;
}

function normalizeRef(input: unknown, defaults: RefDefaults = {}): ReadModelRef | null {
  if (input == null) {
    return null;
  }
  if (typeof input === "string") {
    return { target: input, type: defaults.type || "doc", source: defaults.source || "explicit" };
  }
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    return {
      target: String(record.target || ""),
      type: String(record.type || defaults.type || "doc"),
      source: String(record.source || defaults.source || "explicit"),
    };
  }
  return null;
}

function refsOf(node: ReadModelNode): ReadModelRef[] {
  const result: ReadModelRef[] = [];
  const seen = new Set<string>();
  const push = (value: unknown, defaults: RefDefaults = {}): void => {
    const ref = normalizeRef(value, defaults);
    if (!ref || !ref.target) {
      return;
    }
    const key = `${ref.target}::${ref.type}::${ref.source}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(ref);
    }
  };
  for (const ref of node.refs || []) {
    push(ref);
  }
  for (const [source, text] of [["body", node.body], ["definition", node.definition], ["acceptance", node.acceptance]]) {
    if (!text) {
      continue;
    }
    for (const match of String(text).matchAll(/(?:\.decisions\/|\.adrs\/|docs\/)[A-Za-z0-9_./-]+\.md/g)) {
      push({ target: match[0], type: "doc", source });
    }
  }
  for (const note of node.notes || []) {
    if (!note?.text) {
      continue;
    }
    for (const match of String(note.text).matchAll(/(?:\.decisions\/|\.adrs\/|docs\/)[A-Za-z0-9_./-]+\.md/g)) {
      push({ target: match[0], type: "doc", source: "notes" });
    }
  }
  return result;
}

function inlineNode(snapshot: ReadModelSnapshot | undefined, id: string): Record<string, unknown> {
  const node = nodesOf(snapshot)[id];
  if (!node) {
    return { id, status: "missing", is_current: true, superseded_by: null };
  }
  return { ...clone(node), is_current: isCurrent(snapshot, id), superseded_by: supersededBy(snapshot, id) };
}

function dependentsForNode(snapshot: ReadModelSnapshot | undefined, id: string) {
  return outgoing(snapshot, id, undefined).map((edge) => ({ edge_type: edge.type, node: inlineNode(snapshot, edge.to) }));
}

function logForNode(snapshot: ReadModelSnapshot | undefined, id: string) {
  return logOf(snapshot)
    .filter((entry) => entry?.node === id || entry?.task === id)
    .slice(-DEFAULT_ACTIVITY_LIMIT)
    .map((entry) => normalizeActivityEntry(snapshot, entry));
}

function applyActivityFilters(
  snapshot: ReadModelSnapshot | undefined,
  entries: ReadModelLogEntry[],
  filters: ActivityFilters = {},
): ReadModelLogEntry[] {
  const nodes = nodesOf(snapshot);
  let result = entries;
  if (filters.action) result = result.filter((entry) => entry.action === filters.action);
  if (filters.agent) result = result.filter((entry) => entry.agent === filters.agent);
  if (filters.node) result = result.filter((entry) => entry.node === filters.node || entry.task === filters.node);
  if (filters.initiative) {
    result = result.filter((entry) => {
      const id = entry.node || entry.task;
      return Boolean(id && nodes[id] && nodes[id].initiative === filters.initiative);
    });
  }
  if (filters.q) {
    const query = String(filters.q).toLowerCase();
    result = result.filter((entry) => {
      const id = entry.node || entry.task || "";
      const node = id ? nodes[id] : null;
      return [entry.note, entry.agent, entry.action, id, node?.title]
        .filter((value) => value !== undefined && value !== null)
        .join("\n")
        .toLowerCase()
        .includes(query);
    });
  }
  return result;
}

function facet(entries: ReadModelLogEntry[], key: "action" | "agent"): Array<Record<string, unknown> & { count: number }> {
  const counts = new Map<unknown, number>();
  for (const entry of entries) {
    if (entry[key] == null) {
      continue;
    }
    counts.set(entry[key], (counts.get(entry[key]) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ [key]: value, count }))
    .sort((left, right) => right.count - left.count || String(left[key]).localeCompare(String(right[key])));
}

function activityFacets(
  snapshot: ReadModelSnapshot | undefined,
  entries: ReadModelLogEntry[],
  filters: ActivityFilters,
): { actions: Array<Record<string, unknown> & { count: number }>; agents: Array<Record<string, unknown> & { count: number }> } {
  return {
    actions: facet(applyActivityFilters(snapshot, entries, { ...filters, action: undefined }), "action"),
    agents: facet(applyActivityFilters(snapshot, entries, { ...filters, agent: undefined }), "agent"),
  };
}

function numericOption(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function projectUiSnapshot({
  snapshot = {},
  project = {},
  now,
  activityLimit = DEFAULT_ACTIVITY_LIMIT,
  staleMs = DEFAULT_STALE_MS,
}: UiProjectSnapshotArgs = {}) {
  const nodes = nodesOf(snapshot);
  const derivedBase = derive({ snapshot }) as Partial<UiDerived>;
  const submitted = taskNodes(nodes)
    .filter((node) => (node.status || "open") === "submitted")
    .map((node) => node.id);
  const derived = {
    ready: [...(derivedBase.ready || [])],
    blocked: [...(derivedBase.blocked || [])],
    backlog: [...(derivedBase.backlog || [])],
    openGates: [...(derivedBase.openGates || [])],
    submitted,
  };
  const alerts = Object.values(nodes)
    .map((node) => staleClaim(node, now, staleMs))
    .filter((alert): alert is UiAlert => alert !== null);
  const id = projectIdOf(project);
  const recentLimit = Math.min(DEFAULT_ACTIVITY_LIMIT, numericOption(activityLimit, DEFAULT_ACTIVITY_LIMIT));
  return {
    project: {
      id,
      name: projectNameOf(project, id),
      revision: revisionOf(snapshot, project),
      generated_at: generatedAt(now, project),
    },
    initiatives: clone(snapshot.initiatives || {}),
    nodes: clone(nodes),
    edges: clone(edgesOf(snapshot)),
    derived,
    last_activity: lastActivity(snapshot),
    initiative_summary: initiativeSummary(snapshot, derived),
    summary: summaryOf(nodes, derived, alerts),
    alerts,
    recent_activity: recentActivity(snapshot, recentLimit),
  };
}

export function projectUiNode({ snapshot = {}, id }: UiNodeArgs = {}) {
  const node = nodesOf(snapshot)[id as string];
  if (!node) {
    return null;
  }
  return {
    node: clone(node),
    blocking: clone(blockingForNode({ snapshot, id })),
    dependents: dependentsForNode(snapshot, id as string),
    informing: clone(informingForNode({ snapshot, id })),
    knowledge: clone(knowledgeForNode({ snapshot, id })),
    history: logForNode(snapshot, id as string),
    refs: refsOf(node),
    derived_status: statusOf({ snapshot, id }),
    is_current: isCurrent(snapshot, id),
    superseded_by: supersededBy(snapshot, id),
  };
}

export function projectUiActivity({
  snapshot = {},
  filters = {},
  limit = DEFAULT_ACTIVITY_LIMIT,
  offset = 0,
}: UiActivityArgs = {}) {
  const source = logOf(snapshot);
  const filtered = applyActivityFilters(snapshot, source, filters);
  const pageLimit = numericOption(limit, DEFAULT_ACTIVITY_LIMIT);
  const pageOffset = numericOption(offset, 0);
  const start = Math.max(0, filtered.length - pageLimit - pageOffset);
  const end = Math.max(0, filtered.length - pageOffset);
  return {
    entries: filtered.slice(start, end).reverse().map((entry) => normalizeActivityEntry(snapshot, entry)),
    total: filtered.length,
    limit: pageLimit,
    offset: pageOffset,
    facets: activityFacets(snapshot, source, filters),
  };
}
