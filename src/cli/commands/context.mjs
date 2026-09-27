// `context`: agent-first view of a v2 node, shaped per the design doc.
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
//
// ADR-009 §"Contexto y documentación": `allowed_actions` describes the
// actions the node's state permits. It MUST NOT project ownership
// (claim.by vs actor), actor roles (`isOrchestrator`), or hatch-shaped
// commands like `"release --as orchestrator"`. The only actor signal
// reflected here is whether the caller identified themselves with
// `--as` / `CLIMIER_AGENT`; mutating actions that record the actor
// (claim, resolve, release, reopen, cancel, supersede) are surfaced
// when an actor is present, otherwise only read-shaped actions
// (add-note, update) remain. Plugins that authorise takeovers do so
// dynamically and are not projected here.
//
// `claim` is `{ by, at, stale }` when the node is currently claimed (either
// via the take command's structured claim or via legacy claimed_by/claimed_at),
// else `null`.
import { readState, assertReadableState } from "../../storage/state.mjs";
import { projectContextView } from "../../read-model/index.mjs";
import { throwV2 } from "../../contracts/errors.mjs";

export const knownFlags = ["as", "staleMs"];

const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

function parseStaleMs(flags) {
  if (flags.staleMs === undefined || flags.staleMs === true) {return DEFAULT_STALE_MS;}
  const n = Number(flags.staleMs);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`context: --staleMs must be a non-negative number (got '${flags.staleMs}')`);
  }
  return n;
}

function contextAgent(flags) {
  return flags.as && flags.as !== true ? String(flags.as) : undefined;
}

async function readRemoteContext(id, flags, backendClient) {
  return backendClient.readContext({ id, as: contextAgent(flags), staleMs: parseStaleMs(flags) });
}

async function readLocalContext(statePath, id, flags) {
  const snapshot = await readState(statePath);
  if (!snapshot) {throw new Error("context: state file missing");}
  assertReadableState(snapshot, "context");
  const view = projectContextView({
    snapshot,
    id,
    agent: contextAgent(flags),
    staleMs: parseStaleMs(flags),
    now: Date.now(),
  });
  if (!view) {throwV2("NODE_NOT_FOUND", `context: node ${id} not found`, { id });}
  return view;
}

async function readContext({ statePath, id, flags, backendClient }) {
  if (backendClient?.type === "remote") {return readRemoteContext(id, flags, backendClient);}
  return readLocalContext(statePath, id, flags);
}

export default async function context({ statePath, positional, flags, backendClient }) {
  const [id] = positional;
  if (!id) {throwV2("MISSING_FIELD", "context: node id required", { field: "id" });}
  return readContext({ statePath, id, flags, backendClient });
}
