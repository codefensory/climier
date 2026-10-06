import { derive, statusOf, blockingForNode } from "./core.ts";
import type { ReadModelNode, ReadModelSnapshot } from "./types.ts";

interface NodeFilters {
  initiative?: string | null;
  domain?: string | null;
  kind?: string | null;
}

interface RawStatusFilters extends NodeFilters {
  all?: boolean;
  status?: string;
  "claimed-by"?: string;
  "stale-ms"?: number;
  limit?: number;
}

interface StatusFilters extends NodeFilters {
  all: boolean;
  status: string | null;
  claimedBy: string | null;
  staleMs: number;
  limit: number | null;
}

interface StatusDerived {
  ready: string[];
  blocked: string[];
  backlog: string[];
  openGates: string[];
}

interface NodeSummary {
  id: string;
  kind?: string;
  subkind?: string;
  title: string;
  status: string;
  initiative?: string;
  domain?: string;
  claimed_by: string | null;
}

interface StatusAlert {
  kind: string;
  severity: string;
  task_id: string;
  claimed_by: string;
  age_ms: number;
  message: string;
}

interface StatusPools {
  knowledge: ReadModelNode[];
  activeKnowledge: number;
  submitted: string[];
  inProgress: string[];
  openGates: string[];
}

interface TaskLists {
  ready: string[];
  inProgress: string[];
  submitted: string[];
  blocked: string[];
  backlog: string[];
  cap: (items: string[]) => string[];
}

export interface StatusResult {
  summary: Record<string, number>;
  tasks: Record<string, NodeSummary[]>;
  gates: { open: NodeSummary[] };
  knowledge_count: number;
  alerts: StatusAlert[];
  [key: string]: unknown;
}

function claimBy(node: ReadModelNode): string | null {
  if (node?.claim && typeof node.claim === "object" && node.claim.by) {
    return node.claim.by;
  }
  return node?.claimed_by || null;
}

function claimTimestampMs(at: unknown): number | null {
  if (typeof at === "number") {
    return at;
  }
  if (typeof at === "string") {
    const ms = Date.parse(at);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function claimAtMs(node: ReadModelNode): number | null {
  const at = (node?.claim && node.claim.at) || node?.claimed_at;
  return claimTimestampMs(at);
}

function matchesNodeFilters(node: ReadModelNode, { initiative, domain, kind }: NodeFilters): boolean {
  return (!initiative || node.initiative === initiative) &&
    (!domain || node.domain === domain) && (!kind || node.kind === kind);
}

function matchesStatus(node: ReadModelNode, id: string, snapshot: ReadModelSnapshot, status: string | null): boolean {
  return !status || (node.status || "open") === status || statusOf({ snapshot, id }) === status;
}

function isStaleClaimCandidate(node: ReadModelNode, initiative: string | null | undefined): boolean {
  return node.kind === "resolvable" && node.subkind === "task" &&
    (node.status || "open") === "in_progress" && (!initiative || node.initiative === initiative);
}

function staleClaimAge(node: ReadModelNode, now: number, staleMs: number, claimedBy: string | null): { age: number; by: string } | null {
  const at = claimAtMs(node);
  const by = claimBy(node);
  const age = at === null ? null : now - at;
  return age !== null && by && age > staleMs && (!claimedBy || by === claimedBy) ? { age, by } : null;
}

function staleClaimAlert(node: ReadModelNode, age: number, by: string): StatusAlert {
  return {
    kind: "stale-claim",
    severity: "warning",
    task_id: node.id,
    claimed_by: by,
    age_ms: age,
    message: `${node.id} claimed by ${by} is stale (${Math.round(age / 60000)}m old)`,
  };
}

function nodePools(nodes: Record<string, ReadModelNode>, { initiative, kind }: NodeFilters): {
  knowledge: ReadModelNode[];
  activeKnowledge: number;
} {
  const knowledge = Object.values(nodes).filter((node) => node.kind === "knowledge")
    .filter((node) => matchesNodeFilters(node, { initiative, kind }));
  return {
    knowledge,
    activeKnowledge: knowledge.filter((node) => (node.status || "active") === "active").length,
  };
}

function selectOpenGates(
  nodes: Record<string, ReadModelNode>,
  derived: StatusDerived,
  { initiative, kind, status }: NodeFilters & { status: string | null },
): string[] {
  const openGates = (derived.openGates || []).filter((id) => {
    const node = nodes[id];
    return Boolean(node) && matchesNodeFilters(node, { initiative, kind });
  });
  return status && status !== "open" ? [] : openGates;
}

function selectActiveTasks(nodes: Record<string, ReadModelNode>, filters: StatusFilters): string[] {
  const { initiative, domain, kind, status, claimedBy } = filters;
  const inProgressAll = selectTasks(nodes, { taskStatus: "in_progress", initiative, domain, kind });
  if (status && status !== "in_progress") {
    return [];
  }
  if (!status && claimedBy) {
    return inProgressAll.filter((id) => claimBy(nodes[id]) === claimedBy);
  }
  return inProgressAll;
}

function selectSubmittedTasks(
  nodes: Record<string, ReadModelNode>,
  { initiative, domain, kind, status }: NodeFilters & { status: string | null },
): string[] {
  const submitted = selectTasks(nodes, { taskStatus: "submitted", initiative, domain, kind });
  return status && status !== "submitted" ? [] : submitted;
}

function createTaskResult(nodes: Record<string, ReadModelNode>, id: string, snapshot: ReadModelSnapshot) {
  const summary = nodeSummary(nodes[id]);
  const unsatisfiedBlockers = blockingForNode(snapshot, id).filter((blocker) => blocker.satisfied === false)
    .map((blocker) => blocker.node && blocker.node.id).filter(Boolean);
  return { ...summary, unsatisfied_blockers: unsatisfiedBlockers };
}

function createStatusResult(
  nodes: Record<string, ReadModelNode>,
  pools: StatusPools,
  tasks: TaskLists,
  snapshot: ReadModelSnapshot,
): StatusResult {
  const { ready, inProgress, submitted, blocked, backlog, cap } = tasks;
  return {
    summary: {
      ready: ready.length,
      in_progress: inProgress.length,
      submitted: submitted.length,
      blocked: blocked.length,
      backlog: backlog.length,
      open_gates: pools.openGates.length,
      active_knowledge: pools.activeKnowledge,
    },
    tasks: {
      ready: cap(ready).map((id) => nodeSummary(nodes[id])),
      in_progress: cap(inProgress).map((id) => nodeSummary(nodes[id])),
      submitted: cap(submitted).map((id) => nodeSummary(nodes[id])),
      blocked: cap(blocked).map((id) => createTaskResult(nodes, id, snapshot)),
      backlog: cap(backlog).map((id) => nodeSummary(nodes[id])),
    },
    gates: { open: cap(pools.openGates).map((id) => nodeSummary(nodes[id])) },
    knowledge_count: pools.knowledge.length,
    alerts: [],
  };
}

function applyStatusOptions({
  result,
  pools,
  nodes,
  filters,
  now,
}: {
  result: StatusResult;
  pools: StatusPools;
  nodes: Record<string, ReadModelNode>;
  filters: StatusFilters;
  now: number;
}): StatusResult {
  if (filters.all) {
    result.knowledge = projectKnowledge(pools.knowledge);
  }
  appendStaleClaimAlerts(result, nodes, filters, now);
  if (filters.all) {
    projectHistoricalStatuses(result, nodes, filters, pools.knowledge);
  }
  return result;
}

function nodeSummary(node: ReadModelNode): NodeSummary {
  return {
    id: node.id,
    kind: node.kind,
    subkind: node.subkind,
    title: node.title || "",
    status: node.status || "open",
    initiative: node.initiative,
    domain: node.domain,
    claimed_by: claimBy(node),
  };
}

function requireNow(now: number | undefined): asserts now is number {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError("read-model: now epoch-ms is required");
  }
}

function statusFilters(filters: RawStatusFilters): StatusFilters {
  return {
    all: filters.all === true,
    initiative: filters.initiative || null,
    domain: filters.domain || null,
    kind: filters.kind || null,
    status: filters.status || null,
    claimedBy: filters["claimed-by"] || null,
    staleMs: filters["stale-ms"] === undefined ? 2 * 60 * 60 * 1000 : filters["stale-ms"],
    limit: filters.limit === undefined ? null : filters.limit,
  };
}

function matchesPool({
  id,
  nodes,
  snapshot,
  initiative,
  domain,
  kind,
  status,
}: {
  id: string;
  nodes: Record<string, ReadModelNode>;
  snapshot: ReadModelSnapshot;
} & NodeFilters & { status: string | null }): boolean {
  const node = nodes[id];
  return Boolean(node) && matchesNodeFilters(node, { initiative, domain, kind }) &&
    matchesStatus(node, id, snapshot, status);
}

function selectTasks(
  nodes: Record<string, ReadModelNode>,
  { taskStatus, initiative, domain, kind }: NodeFilters & { taskStatus: string },
): string[] {
  return Object.values(nodes)
    .filter((node) => node.kind === "resolvable" && node.subkind === "task" && (node.status || "open") === taskStatus)
    .filter((node) => !initiative || node.initiative === initiative)
    .filter((node) => !domain || node.domain === domain)
    .filter((node) => !kind || node.kind === kind)
    .map((node) => node.id);
}

function selectStatusPools(
  nodes: Record<string, ReadModelNode>,
  derived: StatusDerived,
  filters: StatusFilters,
): StatusPools {
  const { initiative, domain, kind, status } = filters;
  const taskFilters = { initiative, domain, kind, status };
  const nodeFilters = { initiative, kind };
  const nodeCounts = nodePools(nodes, nodeFilters);
  return {
    submitted: selectSubmittedTasks(nodes, taskFilters),
    inProgress: selectActiveTasks(nodes, filters),
    openGates: selectOpenGates(nodes, derived, { ...nodeFilters, status }),
    ...nodeCounts,
  };
}

function projectKnowledge(nodes: ReadModelNode[]) {
  return nodes.map((node) => ({
    id: node.id,
    title: node.title || "",
    status: node.status || "active",
    initiative: node.initiative,
    scope: node.scope || {},
    knowledge_type: node.knowledge_type,
    deprecation_reason: node.deprecation_reason,
    deprecated_at: node.deprecated_at,
    deprecated_by: node.deprecated_by,
  }));
}

function appendStaleClaimAlerts(
  result: StatusResult,
  nodes: Record<string, ReadModelNode>,
  { initiative, claimedBy, staleMs }: StatusFilters,
  now: number,
): void {
  for (const node of Object.values(nodes)) {
    if (!isStaleClaimCandidate(node, initiative)) {
      continue;
    }
    const claim = staleClaimAge(node, now, staleMs, claimedBy);
    if (claim) {
      result.alerts.push(staleClaimAlert(node, claim.age, claim.by));
    }
  }
}

function projectHistoricalStatuses(
  result: StatusResult,
  nodes: Record<string, ReadModelNode>,
  filters: StatusFilters,
  knowledge: ReadModelNode[],
): void {
  const { initiative } = filters;
  const onInitiative = (node) => !initiative || node.initiative === initiative;
  const tasks = (taskStatus) => Object.values(nodes).filter((node) =>
    node.kind === "resolvable" && node.subkind === "task" && node.status === taskStatus && onInitiative(node));
  const gates = (gateStatus) => Object.values(nodes).filter((node) =>
    node.kind === "resolvable" && node.subkind === "gate" && node.status === gateStatus && onInitiative(node));
  const superseded = Object.values(nodes).filter((node) => node.status === "superseded" && onInitiative(node));
  result.done = { tasks: tasks("done").map(nodeSummary) };
  result.canceled = { tasks: tasks("canceled").map(nodeSummary) };
  result.resolved = { gates: gates("resolved").map(nodeSummary) };
  result.superseded = { nodes: superseded.map(nodeSummary) };
  result.deprecated = {
    knowledge: knowledge.filter((node) => node.status === "deprecated").map((node) => ({
      id: node.id,
      title: node.title || "",
      deprecation_reason: node.deprecation_reason,
      deprecated_at: node.deprecated_at,
      deprecated_by: node.deprecated_by,
    })),
  };
}

function taskLists({ snapshot, nodes, pools, filters, derived }: {
  snapshot: ReadModelSnapshot;
  nodes: Record<string, ReadModelNode>;
  pools: StatusPools;
  filters: StatusFilters;
  derived: StatusDerived;
}): TaskLists {
  const cap = (items) => filters.limit === null ? items : items.slice(0, filters.limit);
  const pool = (ids) => ids.filter((id) => matchesPool({ ...filters, id, nodes, snapshot }));
  return {
    ready: pool(derived.ready),
    inProgress: pools.inProgress,
    submitted: pools.submitted,
    blocked: pool(derived.blocked),
    backlog: pool(derived.backlog),
    cap,
  };
}


interface ProjectStatusArgs {
  snapshot?: ReadModelSnapshot;
  filters?: RawStatusFilters;
  now?: number;
}

export function projectStatusView({ snapshot = {}, filters = {}, now }: ProjectStatusArgs = {}) {
  requireNow(now);
  const nodes = snapshot?.nodes || {};
  const options = statusFilters(filters);
  const derived = derive({ snapshot });
  const pools = selectStatusPools(nodes, derived, options);
  const tasks = taskLists({ snapshot, nodes, pools, filters: options, derived });
  const result = createStatusResult(nodes, pools, tasks, snapshot);
  return applyStatusOptions({ result, pools, nodes, filters: options, now });
}
