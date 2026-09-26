// `status` view: agent-first picture of the DAG.
//
// Output shape (per design doc):
//   {
//     summary: { ready, in_progress, submitted, blocked, backlog, open_gates, active_knowledge },
//     tasks: { ready: [...], in_progress: [...], submitted: [...], blocked: [...], backlog: [...] },
//     gates: { open: [...] },
//     knowledge_count: number,            // default
//     knowledge: [...]   (only when --kind knowledge + --all, or just --all)
//     alerts: [...],
//     ... // --all adds done / canceled / resolved / superseded / deprecated groups
//   }
//
// Filters:
//   --initiative X          narrow to one initiative (matches the node's own field)
//   --kind task|gate|knowledge    restrict task buckets AND/OR scope knowledge
//   --status X              restrict the in_progress / blocked / ready buckets by
//                           exact status (rare; mainly 'in_progress' / 'ready' / 'blocked')
//   --domain X              narrow by node.domain
//   --claimed-by X          restrict in_progress to one agent (default: all in_progress visible)
//   --as <agent>            scopes allowed_actions in `context`; it is NOT a filter for `status`.
//                           `status` shows every in_progress task by default, regardless of caller.
//   --stale-ms N            threshold for stale-claim alerts (default 2h)
//   --limit N               cap per-bucket list sizes
//   --all                   include done / canceled / resolved / superseded / deprecated
//                           groups; dump actual knowledge items instead of count only
//
// ponytail: simplest implementation filters post-derive; no per-bucket indexes.
// The expected state of a v2 project is a few dozen nodes; O(n) scans are fine.

import { readState } from "../../storage/state.mjs";
import { projectStatusView } from "../../read-model/index.mjs";

export const knownFlags = [
  "initiative",
  "kind",
  "status",
  "domain",
  "claimed-by",
  "stale-ms",
  "limit",
  "all",
  "as",
];

const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

function parseStaleMs(flags) {
  if (flags["stale-ms"] === undefined || flags["stale-ms"] === true) return DEFAULT_STALE_MS;
  const n = parseInt(flags["stale-ms"], 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`status: --stale-ms must be a non-negative integer (got '${flags["stale-ms"]}')`);
  }
  return n;
}

function parseLimit(flags) {
  if (flags.limit === undefined || flags.limit === true) return null;
  const n = parseInt(flags.limit, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`status: --limit must be a non-negative integer (got '${flags.limit}')`);
  }
  return n;
}

function emptyResult() {
  return {
    summary: {
      ready: 0,
      in_progress: 0,
      submitted: 0,
      blocked: 0,
      backlog: 0,
      open_gates: 0,
      active_knowledge: 0,
    },
    tasks: { ready: [], in_progress: [], submitted: [], blocked: [], backlog: [] },
    gates: { open: [] },
    knowledge_count: 0,
    alerts: [],
  };
}

export default async function statusV2({ statePath, flags, backendClient }) {
  if (backendClient?.type === "remote") {
    const staleMs = parseStaleMs(flags);
    const limit = parseLimit(flags);
    return backendClient.readStatus({
      initiative: flags.initiative || undefined,
      kind: flags.kind || undefined,
      status: flags.status || undefined,
      domain: flags.domain || undefined,
      claimedBy: flags["claimed-by"] || undefined,
      staleMs: flags["stale-ms"] === undefined || flags["stale-ms"] === true ? undefined : staleMs,
      limit: limit === null ? undefined : limit,
      all: flags.all === true || flags.all === "true",
      as: flags.as && flags.as !== true ? String(flags.as) : undefined,
    });
  }

  const s = await readState(statePath);
  if (!s) return emptyResult();
  const staleMs = parseStaleMs(flags);
  const limit = parseLimit(flags);
  const filters = {
    initiative: flags.initiative || undefined,
    kind: flags.kind || undefined,
    status: flags.status || undefined,
    domain: flags.domain || undefined,
    "claimed-by": flags["claimed-by"] || undefined,
    "stale-ms": staleMs,
    limit,
    all: flags.all === true,
  };
  return projectStatusView({ snapshot: s, filters, now: Date.now() });
}
