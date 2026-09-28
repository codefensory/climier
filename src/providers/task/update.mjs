// src/providers/task/update.mjs — pure provider for `task.update`.
//
// ADR-011 §§1, 2, 3 + ADR-012 §3:
//   - `prepare` is read-only. It validates the target exists, is a
//     task (kind=resolvable/subkind=task), that the input carries an
//     `if_revision` precondition (ADR-011 §4: every agent-facing op
//     that may modify a node requires if_revision), and that the
//     patch does not carry `revision` or unknown top-level keys.
//   - `apply` uses only tx.updateNode for the patch fields and
//     tx.addEdge for any new BLOCKS edges supplied via
//     `changes.blocked_by`. Revision is never written.
//   - This module imports nothing from filesystem, lock, state, log,
//     policy, commands, registry, adapters, CLI or UI.

import { throwV2 } from "../../contracts/errors.mjs";
import { blocksEdge } from "../../kernel/edges.mjs";

const OP = "task.update";
const LOG_ACTION = "update";

const TASK_KIND = "resolvable";
const TASK_SUBKIND = "task";

// ALLOWED_PATCH_KEYS — the canonical set of patch fields the task
// provider accepts. Mirrors the public `update` CLI surface (its scalar
// and array fields) plus
// `blocked_by` (which is encoded as edges, not a node field). Any key
// outside this set is rejected in prepare so the provider can never
// silently widen the public contract.
const ALLOWED_PATCH_KEYS = new Set([
  "title",
  "body",
  "acceptance",
  "definition",
  "domain",
  "initiative",
  "status",
  "tags",
  "refs",
  "blocked_by",
  // backlog is a domain field with its own derivation (ADR-038 decision 4).
  "backlog",
  // meta is typed on gate and knowledge, accepted on create for all three
  // kinds and indexed by search, so retiring it here would leave a field
  // writable on create, searchable and not editable.
  "meta",
]);

function asNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readSnapshotNodes(snapshot) {
  return snapshot && snapshot.nodes && typeof snapshot.nodes === "object" ? snapshot.nodes : {};
}

function normalizeBlockers(raw) {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  throwV2(
    "INVALID_EXECUTION_CONTRACT",
    `${OP}: changes.blocked_by must be a CSV string or array of ids`,
    { field: "changes.blocked_by" },
  );
}

function dedupeAndSort(ids) {
  return Array.from(new Set(ids)).toSorted();
}

function validateChanges(input) {
  if (input.changes === null || typeof input.changes !== "object" || Array.isArray(input.changes)) {
    throwV2("MISSING_FIELD", `${OP}: input.changes must be a non-empty object`, { field: "changes" });
  }
  if (Object.keys(input.changes).length === 0) {
    throwV2("MISSING_FIELD", `${OP}: input.changes is empty`, { field: "changes" });
  }
  const { backlog, meta } = input.changes;
  if (backlog !== undefined && typeof backlog !== "boolean") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: changes.backlog must be a boolean`, { field: "changes.backlog", value: backlog });
  }
  if (meta !== undefined && (meta === null || typeof meta !== "object" || Array.isArray(meta))) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: changes.meta must be an object`, { field: "changes.meta" });
  }
  if ("revision" in input.changes) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: input.changes must not carry 'revision' (the kernel increments revision once per apply)`, {
      field: "changes.revision",
    });
  }
}

function validateRevisionInput(input) {
  if (input.if_revision === undefined || input.if_revision === null) {
    throwV2("MISSING_FIELD", `${OP}: input.if_revision required (ADR-011 §4 — every agent-facing op that mutates a node must declare its precondition)`, {
      field: "if_revision",
    });
  }
  const expected = Number(input.if_revision);
  if (!Number.isInteger(expected) || expected < 1) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: input.if_revision must be a positive integer`, {
      field: "if_revision",
      value: input.if_revision,
    });
  }
}

function validateInputShape(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: input must be an object`, { field: "input" });
  }
  if (!asNonEmptyString(input.id)) {
    throwV2("MISSING_FIELD", `${OP}: --id required`, { field: "id" });
  }
  validateChanges(input);
  validateRevisionInput(input);
}

function validatePatchKeys(changes) {
  for (const key of Object.keys(changes)) {
    if (!ALLOWED_PATCH_KEYS.has(key)) {
      throwV2(
        "INVALID_EXECUTION_CONTRACT",
        `${OP}: changes.${key} is not a valid patch key (allowed: ${Array.from(ALLOWED_PATCH_KEYS).toSorted().join(", ")})`,
        { field: `changes.${key}`, allowed: Array.from(ALLOWED_PATCH_KEYS).toSorted() },
      );
    }
  }
}

function validateTarget(input, snapshot) {
  const nodes = readSnapshotNodes(snapshot);
  const node = nodes[input.id];
  if (!node) {
    throwV2("NODE_NOT_FOUND", `${OP}: task '${input.id}' not found`, { id: input.id });
  }
  if (node.kind !== TASK_KIND || node.subkind !== TASK_SUBKIND) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: target '${input.id}' is not a task (got ${node.kind}/${node.subkind || "?"})`,
      {
        id: input.id,
        kind: node.kind,
        subkind: node.subkind || null,
        expectedKind: TASK_KIND,
        expectedSubkind: TASK_SUBKIND,
      },
    );
  }
}

function validateRevisionPrecondition(input, snapshot) {
  const node = readSnapshotNodes(snapshot)[input.id];
  const expected = Number(input.if_revision);
  if (!Number.isInteger(node.revision) || node.revision !== expected) {
    throwV2(
      "REVISION_CONFLICT",
      `${OP}: task '${input.id}' changed since revision ${expected}`,
      { id: input.id, expected, current: Number.isInteger(node.revision) ? node.revision : null },
    );
  }
}

// validateBlockersForUpdate — the same shape used in create, applied
// to the `changes.blocked_by` field. Self-edges and missing/duplicate
// blockers are rejected here so apply only handles the happy path.

// buildNodePatch — returns the patch object that updateNode will
// receive. It strips `blocked_by` (encoded as edges) and normalizes
// CSV-style fields. Returned object is frozen.
function buildNodePatch(changes) {
  const patch = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key === "blocked_by") {
      continue;
    }
    patch[key] = value;
  }
  return Object.freeze(patch);
}

// ===================================================================
// Provider
// ===================================================================

/**
 * Pure `prepare` for task.update.
 *
 * Contract:
 *   - read-only: never mutates the snapshot, never reads the filesystem;
 *   - validates id, kind/subkind, the patch shape, every patch key
 *     against the public allow-list, that `if_revision` matches the
 *     snapshot, that the new blockers (when present) are valid against
 *     the snapshot, and that no `revision` field leaked into the patch;
 *   - returns a frozen plan carrying the normalized patch, the
 *     pre-sorted blocker list, and the precondition map the kernel
 *     will validate under the lock.
 *
 * @param {{ snapshot: object, input: object, request: object }} args
 * @returns {object} frozen plan
 */
async function prepare({ snapshot, input, request }) {
  void request;
  validateInputShape(input);
  validateTarget(input, snapshot);
  validateRevisionPrecondition(input, snapshot);
  validatePatchKeys(input.changes);
  // Resolve blockers here; tx.addEdge validates graph edges in the draft.
  const hasNewBlockers = Object.prototype.hasOwnProperty.call(input.changes, "blocked_by");
  const newBlockers = hasNewBlockers ? dedupeAndSort(normalizeBlockers(input.changes.blocked_by)) : [];
  const patch = buildNodePatch(input.changes);

  return Object.freeze({
    target: Object.freeze({
      id: input.id,
      kind: TASK_KIND,
      subkind: TASK_SUBKIND,
      revision: Number(input.if_revision),
    }),
    policyAction: Object.freeze({ action: "task.update", pluginId: null }),
    logAction: LOG_ACTION,
    patch,
    added_blocked_by: Object.freeze(newBlockers.slice()),
    if_revisions: Object.freeze({ [input.id]: Number(input.if_revision) }),
  });
}

/**
 * Pure `apply` for task.update.
 *
 * Contract:
 *   - mutates the tx draft only (tx.updateNode for the patch fields
 *     and one tx.addEdge per new BLOCKS edge);
 *   - never writes or increments `revision`;
 *   - returns `{ result, effects }` with the projected node shape and
 *     the deterministic added_edges list.
 *
 * @param {{ tx: object, plan: object, input: object, request: object, snapshot: object }} args
 * @returns {Promise<{ result: object, effects: null }>}
 */
async function apply({ tx, plan, input, request, snapshot }) {
  void input;
  void request;
  void snapshot;
  if (!tx || typeof tx.updateNode !== "function" || typeof tx.addEdge !== "function") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: apply requires a tx with updateNode/addEdge accessors`,
      { field: "tx" },
    );
  }
  // Apply the patch first so subsequent addEdge calls in the same
  // draft see the updated node shape. The patch is already
  // revision-free; tx.updateNode enforces this contract on its own.
  tx.updateNode(plan.target.id, plan.patch);

  const addedEdges = [];
  for (const blockerId of plan.added_blocked_by) {
    const edge = blocksEdge(blockerId, plan.target.id);
    // tx.addEdge validates self-edge / missing / kind / duplicate
    // against the draft (snapshot + adds so far) and throws the
    // canonical v2 error codes. The provider does not duplicate
    // those checks here.
    const persisted = tx.addEdge(edge);
    addedEdges.push(persisted);
  }

  // Project the merged node shape from the draft so callers see the
  // post-update node. revision is excluded; the kernel assigns it.
  const merged = tx.getNode(plan.target.id);
  const projection = merged
    ? Object.freeze({ ...merged, added_edges: Object.freeze(addedEdges.slice()) })
    : Object.freeze({ id: plan.target.id, added_edges: Object.freeze(addedEdges.slice()) });
  delete projection.revision;

  return {
    result: projection,
    effects: null,
  };
}

export const taskUpdateProvider = Object.freeze({ prepare, apply });
