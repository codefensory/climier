
import { readState, assertReadableState } from "../../storage/state.ts";
import { projectContextView } from "../../read-model/index.ts";
import { throwV2 } from "../../contracts/errors.ts";

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
