// src/providers/task/resolve.mjs — pure provider for `task.resolve`.
//
// Plan §B4-task-lifecycle + ADR-011 §§1–4:
//   - `prepare` is read-only. It validates input, ensures the target
//     is a task in a resolvable status (open / in_progress) and carries
//     the required `note`.
//   - `apply` mutates only the in-memory tx draft: tx.updateNode to
//     install the resolved status (done, done_by, done_at, note) and
//     clear the claim. The provider computes `newly_ready` effects by
//     comparing ready-derivation across the snapshot and tx.view(),
//     matching v2.mjs#deriveV2 semantics (no fs, no log).
//   - Imports nothing from filesystem, lock, state, log, policy,
//     commands, registry, adapters, CLI or UI. Only the v2 error
//     helpers.

import { throwV2 } from "../../errors.mjs";

const OP = "task.resolve";
const LOG_ACTION = "resolve";

const TASK_KIND = "resolvable";
const TASK_SUBKIND = "task";
const ALLOWED_STATUSES = ["open", "in_progress"];
const SATISFIED_TASK = new Set(["done", "archived"]);
const SATISFIED_GATE = new Set(["resolved"]);

function asNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readSnapshotNodes(snapshot) {
  return snapshot && snapshot.nodes && typeof snapshot.nodes === "object" ? snapshot.nodes : {};
}

function readSnapshotEdges(snapshot) {
  return Array.isArray(snapshot && snapshot.edges) ? snapshot.edges : [];
}

function validateInputShape(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: input must be an object`, { field: "input" });
  }
  if (!asNonEmptyString(input.id)) {
    throwV2("MISSING_FIELD", `${OP}: --id required`, { field: "id" });
  }
  if (!asNonEmptyString(input.actor)) {
    throwV2("MISSING_FIELD", `${OP}: input.actor required`, { field: "actor" });
  }
  if (!asNonEmptyString(input.note)) {
    throwV2("MISSING_FIELD", `${OP}: --note required`, { field: "note" });
  }
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

// isBlockerSatisfied — mirror of v2.mjs#isSatisfiedV2 for direct
// status only. Newly-ready computation matches the v2 derivation:
// a task is ready when status is open, not backlog, and every incoming
// BLOCKS edge has a satisfied blocker.
function isBlockerSatisfied(blocker) {
  if (!blocker) return false;
  const status = blocker.status || "open";
  if (blocker.subkind === "task") return SATISFIED_TASK.has(status);
  if (blocker.subkind === "gate") return SATISFIED_GATE.has(status);
  return false;
}

function collectReadyTasks(nodesView, edges) {
  const ready = [];
  for (const node of Object.values(nodesView || {})) {
    if (!node || node.kind !== "resolvable") continue;
    if (node.subkind !== "task") continue;
    const status = node.status || "open";
    if (status !== "open") continue;
    if (node.backlog === true) continue;
    const blockers = edges.filter((e) => e.type === "BLOCKS" && e.to === node.id);
    if (blockers.length === 0) {
      ready.push(node.id);
      continue;
    }
    const ok = blockers.every((e) => isBlockerSatisfied(nodesView[e.from]));
    if (ok) ready.push(node.id);
  }
  return ready;
}

/**
 * Pure `prepare` for task.resolve.
 *
 * @param {{ snapshot: object, input: object, request: object }} args
 * @returns {object} frozen plan
 */
async function prepare({ snapshot, input, request }) {
  void request;
  validateInputShape(input);
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
    done_by: input.actor,
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
  const beforeReady = new Set(collectReadyTasks(readSnapshotNodes(snapshot), readSnapshotEdges(snapshot)));
  const view = tx.view();
  const afterReady = collectReadyTasks(view.nodes, view.edges);
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
