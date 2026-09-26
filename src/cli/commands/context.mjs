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
import { readState, assertStateVersion, isFencedState } from "../../storage/state.mjs";
import { projectContextView } from "../../read-model/index.mjs";
import { throwV2 } from "../../contracts/errors.mjs";

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

export default async function context({ statePath, positional, flags, backendClient }) {
  const [id] = positional;
  if (!id) throwV2("MISSING_FIELD", "context: node id required", { field: "id" });
  if (backendClient?.type === "remote") {
    return backendClient.readContext({
      id,
      as: flags.as && flags.as !== true ? String(flags.as) : undefined,
      staleMs: parseStaleMs(flags),
    });
  }

  const staleMs = parseStaleMs(flags);
  const projectDir = statePath;
  const s = await readState(projectDir);
  if (!s) throw new Error("context: state file missing");
  assertStateVersion(s, isFencedState(s) ? 5 : 2, "context");
  const agent = flags.as && flags.as !== true ? String(flags.as) : undefined;
  const view = projectContextView({ snapshot: s, id, agent, staleMs, now: Date.now() });
  if (!view) throwV2("NODE_NOT_FOUND", `context: node ${id} not found`, { id });
  return view;
}
