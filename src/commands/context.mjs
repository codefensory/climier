// F10 — `context`: agent-first view of a v2 node, shaped per the design doc.
//
// Output shape:
//   { node, derived_status, revision, claim, blocking, knowledge, alerts,
//     allowed_actions, ... }
//
// `scope_matches` (per knowledge item) is an array — a single knowledge can
// arrive via multiple scopes (node_id + domain + tag + initiative) and the
// caller ranks them by specificity.
//
// `allowed_actions` is computed from (kind, derived_status, claim, agent).
// Pass --as <agent> to surface actions available to a specific agent.
//
// `claim` is `{ by, at, stale }` when the node is currently claimed (either
// via F9 take.mjs's structured claim or via legacy claimed_by/claimed_at),
// else `null`.
import { readState, assertStateVersion } from "../state.mjs";
import {
  blockingForNode,
  informingForNode,
  knowledgeForNode,
  statusOfV2,
} from "../v2.mjs";
import { throwV2 } from "../errors.mjs";

export const knownFlags = ["as", "staleMs"];

const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

function parseStaleMs(flags) {
  if (flags.staleMs === undefined || flags.staleMs === true) return DEFAULT_STALE_MS;
  const n = Number(flags.staleMs);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`context: --staleMs must be a non-negative number (got '${flags.staleMs}')`);
  }
  return n;
}

// Coerce a `claim.at` / `claimed_at` value to an epoch-ms number, regardless
// of whether it's stored as a number (v1 style) or an ISO string (F9 take).
function parseAtMs(at) {
  if (at == null) return null;
  if (typeof at === "number") return at;
  if (typeof at === "string") {
    const ms = Date.parse(at);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function buildClaim(node, staleMs) {
  // F9 take.mjs writes a structured claim object. Tests / older code may
  // write flat claimed_by + claimed_at (number). Handle either.
  if (node.claim && typeof node.claim === "object" && node.claim.by) {
    const atMs = parseAtMs(node.claim.at);
    return {
      by: node.claim.by,
      at: node.claim.at ?? null,
      stale: atMs !== null && Date.now() - atMs > staleMs,
    };
  }
  if (node.claimed_by && node.claimed_at !== undefined) {
    const atMs = parseAtMs(node.claimed_at);
    return {
      by: node.claimed_by,
      at: node.claimed_at ?? null,
      stale: atMs !== null && Date.now() - atMs > staleMs,
    };
  }
  return null;
}

function buildAlerts(id, blocking, knowledge, claim) {
  const alerts = [];
  if (claim && claim.stale) {
    alerts.push({
      kind: "STALE_CLAIM",
      node_id: id,
      claimed_by: claim.by,
      message: `${id} claimed by ${claim.by} is stale`,
    });
  }
  for (const blocker of blocking) {
    const bn = blocker.node;
    if (bn && bn.status === "superseded") {
      alerts.push({
        kind: "SUPERSEDED_BLOCKER",
        node_id: id,
        blocker_id: bn.id,
        superseded_by: bn.superseded_by || null,
        message: `blocker ${bn.id} is superseded${bn.superseded_by ? ` by ${bn.superseded_by}` : ""}`,
      });
    }
  }
  for (const k of knowledge) {
    if (k.status === "deprecated") {
      alerts.push({
        kind: "KNOWLEDGE_DEPRECATED_SOON",
        node_id: id,
        knowledge_id: k.id,
        message: `matching knowledge ${k.id} is deprecated`,
      });
    }
  }
  return alerts;
}

function allowedActions(node, derivedStatus, claim, agent) {
  const actions = [];
  if (!node) return actions;
  const claimer = claim && claim.by;
  const isOwner = !!agent && claimer === agent;
  const isOrchestrator = agent === "orchestrator";
  const isAnonymous = !agent;

  if (node.kind === "resolvable" && node.subkind === "task") {
    if (derivedStatus === "ready") {
      if (!isAnonymous) actions.push("claim");
      actions.push("update", "add-note", "cancel");
    } else if (derivedStatus === "in_progress") {
      if (isOwner) {
        actions.push("resolve", "release", "add-note", "update");
      } else if (isOrchestrator) {
        actions.push("release", "add-note");
      } else if (isAnonymous) {
        actions.push("add-note");
      } else {
        // Some other agent: they can release only via the orchestrator hatch.
        actions.push("add-note", "release --as orchestrator");
      }
    } else if (derivedStatus === "done") {
      actions.push("add-note");
      if (!isAnonymous) actions.push("reopen");
    } else if (derivedStatus === "canceled") {
      actions.push("add-note", "update");
    }
  } else if (node.kind === "resolvable" && node.subkind === "gate") {
    if (derivedStatus === "open") {
      // ponytail: list the required flags inline so the agent doesn't have to
      // read the source to learn that gate-resolve needs --choice AND --rationale.
      actions.push("resolve --choice <X> --rationale <Y>", "add-note", "supersede");
      if (!isAnonymous) actions.push("cancel");
    } else if (derivedStatus === "resolved") {
      actions.push("reopen", "supersede");
    } else if (derivedStatus === "superseded") {
      actions.push("add-note");
    }
  } else if (node.kind === "knowledge") {
    const kstatus = node.status || "active";
    if (kstatus === "active") {
      actions.push("update", "add-note", "deprecate-knowledge");
    } else if (kstatus === "deprecated") {
      actions.push("update", "add-note");
    }
  }
  return actions;
}

export default async function context({ statePath, positional, flags }) {
  const [id] = positional;
  if (!id) throwV2("MISSING_FIELD", "context: node id required", { field: "id" });
  const projectDir = statePath;
  const s = await readState(projectDir);
  if (!s) throw new Error("context: state file missing");
  assertStateVersion(s, 2, "context");
  const node = s.nodes[id];
  if (!node) throwV2("NODE_NOT_FOUND", `context: node ${id} not found`, { id });

  const staleMs = parseStaleMs(flags);
  const claim = buildClaim(node, staleMs);
  const blocking = blockingForNode(s, id);
  const informing = informingForNode(s, id);
  const knowledge = knowledgeForNode(s, id);
  const alerts = buildAlerts(id, blocking, knowledge, claim);
  const derived_status = statusOfV2(s, id);
  const agent = flags.as && flags.as !== true ? String(flags.as) : null;
  const allowed_actions = allowedActions(node, derived_status, claim, agent);

  return {
    node,
    derived_status,
    can_claim: derived_status === "ready" && node.kind === "resolvable" && node.subkind === "task",
    revision: node.revision || 1,
    claim,
    blocking,
    knowledge,
    informing, // retained for callers that still expect it (existing tests).
    alerts,
    allowed_actions,
  };
}
