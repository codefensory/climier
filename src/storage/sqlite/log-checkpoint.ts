export const DEFAULT_LOG_RETENTION = 1000;
const CHECKPOINT_SUMMARY_ACTION = "checkpoint.summary";

type Checkpoint = {
  count: number;
  firstTs: unknown;
  lastTs: unknown;
  actions: Map<string, number>;
  agents: Map<string, number>;
};

type LogEntry = Record<string, unknown>;
type CheckpointSummaryEntry = LogEntry & { checkpoint: Record<string, unknown> & { count: number } };

function isRecord(value: unknown): value is LogEntry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCheckpointSummary(entry: unknown): entry is CheckpointSummaryEntry {
  if (!isRecord(entry) || entry.action !== CHECKPOINT_SUMMARY_ACTION || !isRecord(entry.checkpoint)) { return false; }
  const { count } = entry.checkpoint;
  return typeof count === "number" && count > 0;
}

function newCheckpoint(): Checkpoint {
  return { count: 0, firstTs: null, lastTs: null, actions: new Map(), agents: new Map() };
}

function getCheckpoint(checkpoints: Map<string | null, Checkpoint>, node: string | null): Checkpoint {
  if (!checkpoints.has(node)) { checkpoints.set(node, newCheckpoint()); }
  return checkpoints.get(node)!;
}

function addCount(target: Map<string, number>, key: string, count = 1) {
  target.set(key, (target.get(key) || 0) + count);
}

function addEntry(checkpoint: Checkpoint, entry: LogEntry) {
  const action = typeof entry.action === "string" ? entry.action : "unknown";
  const agent = typeof entry.agent === "string" ? entry.agent : "unknown";
  const ts = entry.ts ?? entry.at ?? null;
  if (checkpoint.count === 0) { checkpoint.firstTs = ts; }
  checkpoint.count += 1;
  checkpoint.lastTs = ts;
  addCount(checkpoint.actions, action);
  addCount(checkpoint.agents, agent);
}

function mergeCounts(target: Map<string, number>, source: unknown) {
  if (!isRecord(source)) { return; }
  for (const [key, count] of Object.entries(source)) {
    if (typeof count === "number" && Number.isSafeInteger(count) && count > 0) { addCount(target, key, count); }
  }
}

function mergeSummary(checkpoint: Checkpoint, entry: CheckpointSummaryEntry) {
  const summary = entry.checkpoint;
  if (checkpoint.count === 0) { checkpoint.firstTs = summary.first_ts ?? null; }
  checkpoint.count += summary.count;
  checkpoint.lastTs = summary.last_ts ?? null;
  mergeCounts(checkpoint.actions, summary.actions);
  mergeCounts(checkpoint.agents, summary.agents);
}

function compareNodes(left: [string | null, Checkpoint], right: [string | null, Checkpoint]) {
  const [a] = left;
  const [b] = right;
  if (a === b) { return 0; }
  if (a === null) { return -1; }
  if (b === null) { return 1; }
  return a < b ? -1 : 1;
}

function compareCountKeys([a]: [string, number], [b]: [string, number]) {
  if (a < b) { return -1; }
  if (a > b) { return 1; }
  return 0;
}

function countObject(counts: Map<string, number>) {
  return Object.fromEntries([...counts].toSorted(compareCountKeys));
}

function checkpointSummaries(checkpoints: Map<string | null, Checkpoint>) {
  return [...checkpoints]
    .filter(([, checkpoint]) => checkpoint.count > 0)
    .toSorted(compareNodes)
    .map(([node, checkpoint]) => ({
      action: CHECKPOINT_SUMMARY_ACTION,
      agent: "checkpoint",
      node,
      ts: new Date().toISOString(),
      checkpoint: {
        count: checkpoint.count,
        first_ts: checkpoint.firstTs,
        last_ts: checkpoint.lastTs,
        actions: countObject(checkpoint.actions),
        agents: countObject(checkpoint.agents),
      },
    }));
}

function nodesForEntry(entry: LogEntry, nodeIds: Set<string>) {
  const nodes = new Set<string>();
  if (typeof entry.node === "string") { nodes.add(entry.node); }
  if (typeof entry.note === "string") {
    for (const token of entry.note.split(/\s+/)) {
      if (nodeIds.has(token)) { nodes.add(token); }
    }
  }
  return nodes.size > 0 ? [...nodes] : [null];
}

function buildCheckpoints(log: unknown[], dropped: unknown[], nodeIds: Set<string>) {
  const checkpoints = new Map<string | null, Checkpoint>();
  for (const entry of log) {
    if (isCheckpointSummary(entry)) {
      mergeSummary(getCheckpoint(checkpoints, typeof entry.node === "string" ? entry.node : null), entry);
    }
  }
  for (const entry of dropped) {
    const record = isRecord(entry) ? entry : {};
    for (const node of nodesForEntry(record, nodeIds)) { addEntry(getCheckpoint(checkpoints, node), record); }
  }
  return checkpoints;
}

export function compactLog(log: unknown[], keep = DEFAULT_LOG_RETENTION, nodeIds: string[] = []) {
  if (!Array.isArray(log)) { throw new Error("state.compact: log must be an array"); }
  if (!Number.isSafeInteger(keep) || keep < 0) { throw new Error("state.compact: --keep must be a non-negative integer"); }
  const entries = log.filter((entry) => !isCheckpointSummary(entry));
  const retained = keep === 0 ? [] : entries.slice(-keep);
  const dropped = entries.slice(0, entries.length - retained.length);
  const checkpoints = buildCheckpoints(log, dropped, new Set(nodeIds));
  return {
    log: [...checkpointSummaries(checkpoints), ...retained],
    retained: retained.length,
    summarized: dropped.length,
    nodes: checkpoints.size - Number(checkpoints.has(null)),
  };
}
