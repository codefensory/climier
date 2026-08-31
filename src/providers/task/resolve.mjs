// src/providers/task/resolve.mjs — pure provider for `task.resolve`.
//
// ADR-011 §§1–4:
//   - `prepare` is read-only. It validates input, ensures the target
//     is a task in a resolvable status (open / in_progress) and carries
//     the required `note`.
//   - `apply` mutates only the in-memory tx draft: tx.updateNode to
//     install the resolved status (done, done_by, done_at, note) and
//     clear the claim. The provider computes `newly_ready` effects by
//     comparing ready-derivation across the snapshot and tx.view(),
//     matching the task provider's derivation semantics (no fs, no log).
//   - Imports nothing from filesystem, lock, state, log, policy,
//     commands, registry, adapters, CLI or UI. Only the v2 error
//     helpers.

import { throwV2 } from "../../contracts/errors.mjs";
import { collectReadyTasks } from "./derivation.mjs";

const OP = "task.resolve";
const LOG_ACTION = "resolve";

const TASK_KIND = "resolvable";
const TASK_SUBKIND = "task";
const ALLOWED_STATUSES = ["open", "in_progress"];
function asNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// resolveActor — host-fixed agent identity comes from request.actor
// (the kernel stamps it from createCore's agent argument); the CLI
// surface forwards --as through flags.as and may expose it as
// input.actor. Both shapes remain accepted for compatibility, but
// request.actor wins when both are present:
// the adapter is the canonical source of truth for agent identity
// in plugin-issued calls (ADR-006 §API y compatibilidad).
function resolveActor(input, request) {
  return (
    asNonEmptyString(request && request.actor) ||
    asNonEmptyString(input && input.actor) ||
    null
  );
}

function readSnapshotNodes(snapshot) {
  return snapshot && snapshot.nodes && typeof snapshot.nodes === "object" ? snapshot.nodes : {};
}

function readSnapshotEdges(snapshot) {
  return Array.isArray(snapshot && snapshot.edges) ? snapshot.edges : [];
}

function validateInputShape(input, request) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: input must be an object`, { field: "input" });
  }
  if (!asNonEmptyString(input.id)) {
    throwV2("MISSING_FIELD", `${OP}: --id required`, { field: "id" });
  }
  const actor = resolveActor(input, request);
  if (!actor) {
    throwV2("MISSING_FIELD", `${OP}: input.actor required`, { field: "actor" });
  }
  if (!asNonEmptyString(input.note)) {
    throwV2("MISSING_FIELD", `${OP}: --note required`, { field: "note" });
  }
  return actor;
}

function validateTarget(input, snapshot) {
  const node = readSnapshotNodes(snapshot)[input.id];
  if (!node) {
    throwV2("NODE_NOT_FOUND", `${OP}: task '${input.id}' not found`, { id: input.id });
  }
  if (node.kind !== TASK_KIND || node.subkind !== TASK_SUBKIND) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: node '${input.id}' is not a task (got ${node.kind}/${node.subkind || "?"})`,
      {
        id: input.id,
        kind: node.kind,
        subkind: node.subkind || null,
      },
    );
  }
  const status = node.status || "open";
  if (!ALLOWED_STATUSES.includes(status)) {
    throwV2(
      "INVALID_STATUS",
      `${OP}: task '${input.id}' cannot be resolved from status '${status}'`,
      { id: input.id, current: status, allowed: ALLOWED_STATUSES },
    );
  }
}

/**
 * Pure `prepare` for task.resolve.
 *
 * @param {{ snapshot: object, input: object, request: object }} args
 * @returns {object} frozen plan
 */
async function prepare({ snapshot, input, request }) {
  const actor = validateInputShape(input, request);
  validateTarget(input, snapshot);
  const node = readSnapshotNodes(snapshot)[input.id];
  const doneAt = input.done_at === undefined ? new Date().toISOString() : input.done_at;
  return Object.freeze({
    target: Object.freeze({
      id: input.id,
      kind: TASK_KIND,
      subkind: TASK_SUBKIND,
      status: node.status || "open",
    }),
    policyAction: Object.freeze({ action: "task.resolve", pluginId: null }),
    logAction: LOG_ACTION,
    note: input.note,
    done_by: actor,
    done_at: doneAt,
  });
}

/**
 * Pure `apply` for task.resolve. Computes `newly_ready` from the
 * snapshot vs. tx.view() comparison.
 *
 * @param {{ tx: object, plan: object, input: object, request: object, snapshot: object }} args
 * @returns {Promise<{ result: object, effects: { newly_ready: string[] } | null }>}
 */
async function apply({ tx, plan, input, request, snapshot }) {
  void input;
  void request;
  if (!tx || typeof tx.updateNode !== "function" || typeof tx.view !== "function") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: apply requires a tx with updateNode/view accessors`,
      { field: "tx" },
    );
  }
  const patch = {
    status: "done",
    done_by: plan.done_by,
    done_at: plan.done_at,
    note: plan.note,
    claim: null,
  };
  tx.updateNode(plan.target.id, patch);

  // newly_ready: tasks whose blockers all moved to satisfied in this
  // apply, and that were not ready in the original snapshot. The
  // kernel does not persist this — the adapter projects it.
  const beforeReady = new Set(collectReadyTasks({
    nodes: readSnapshotNodes(snapshot),
    edges: readSnapshotEdges(snapshot),
  }));
  const view = tx.view();
  const afterReady = collectReadyTasks(view);
  const newlyReady = afterReady.filter((rid) => !beforeReady.has(rid)).sort();

  const merged = tx.getNode(plan.target.id);
  const projection = merged
    ? Object.freeze({ ...merged, added_edges: Object.freeze([]) })
    : Object.freeze({ id: plan.target.id });
  delete projection.revision;

  return {
    result: projection,
    effects: Object.freeze({ newly_ready: Object.freeze(newlyReady.slice()) }),
  };
}

export const taskResolveProvider = Object.freeze({ prepare, apply });
