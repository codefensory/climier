// Pure final validation for the kernel mutation pipeline.
//
// Transaction methods enforce operation-level invariants while a provider
// applies a draft. These checks validate the complete draft before revision
// assignment and persistence, without importing storage or adapters.

import { throwV2 } from "../../contracts/errors.mjs";

const EDGE_TYPE_FIELD_RE = /^[A-Z_]+$/;

// Provider plans may add only this explicit set of operation-specific fields
// to the kernel-owned log entry. Kernel-owned fields are rejected so a
// provider cannot spoof authoritative audit metadata.
const LOG_FIELD_ALLOWLIST = new Set([
  "choice",
  "rationale",
  "reason",
  "previous_owner",
  "note",
  "scope",
  "node_id",
  "key",
]);
const LOG_FIELD_RESERVED = new Set([
  "ts",
  "action",
  "agent",
  "node",
  "revision",
  "plugin_id",
  "removed_nodes",
  "edges",
  "initiatives",
]);

export function normalizeLogFields(logFields, commandName) {
  if (logFields === undefined) return {};
  if (!logFields || typeof logFields !== "object" || Array.isArray(logFields)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: plan.logFields must be an object`, { field: "logFields" });
  }
  const allowed = {};
  for (const [key, value] of Object.entries(logFields)) {
    if (LOG_FIELD_RESERVED.has(key)) {
      throwV2(
        "INVALID_EXECUTION_CONTRACT",
        `${commandName}: plan.logFields.${key} is kernel-owned`,
        { field: `logFields.${key}` },
      );
    }
    if (LOG_FIELD_ALLOWLIST.has(key)) allowed[key] = value;
  }
  return allowed;
}

// Last line of defence after provider.apply. The transaction layer enforces
// the major structural errors; this boundary validates the full draft shape
// and keeps future tightening isolated from transaction mechanics.
export function validateDraftStructural(draftView, commandName) {
  const nodes = draftView && draftView.nodes;
  if (!nodes || typeof nodes !== "object") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: draft view missing nodes`, { field: "draft" });
  }
  for (const [id, node] of Object.entries(nodes)) {
    if (node && typeof node === "object" && "revision" in node && node.revision !== undefined) {
      throwV2(
        "INVALID_EXECUTION_CONTRACT",
        `${commandName}: draft node ${id} unexpectedly carries 'revision'`,
        { id },
      );
    }
  }
  const edges = Array.isArray(draftView.edges) ? draftView.edges : [];
  for (const e of edges) {
    if (!e || typeof e !== "object" || !EDGE_TYPE_FIELD_RE.test(e.type)) {
      throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: draft edge has invalid type`, { edge: e });
    }
    if (!Object.prototype.hasOwnProperty.call(nodes, e.from) || !Object.prototype.hasOwnProperty.call(nodes, e.to)) {
      throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: draft edge references missing draft node`, { edge: e });
    }
  }
}

export { EDGE_TYPE_FIELD_RE, LOG_FIELD_ALLOWLIST, LOG_FIELD_RESERVED };
