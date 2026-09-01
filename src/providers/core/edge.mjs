// src/providers/core/edge.mjs — pure provider for `edge.add`.
//
// Provides the graph kernel's edge-only operation, mirroring the public
// `add-edge` CLI contract while running through `kernel.mutate`.
//
// Contract (ADR-011 §1):
//   - `prepare` is read-only. It validates the input shape, normalizes
//     the edge type to the canonical uppercase whitelist, validates
//     both endpoints against the snapshot, rejects self-edges and
//     duplicates already present in the snapshot, and returns an
//     immutable plan carrying `{ target, policyAction, logAction,
//     edge }` for the kernel to consume.
//   - `apply` only mutates the in-memory tx draft: exactly one
//     `tx.addEdge` call with the normalized edge. No revision writes,
//     no second persistence path, no fs/lock/state/log/handler calls.
//   - The provider is provider-only: it does NOT reach for argv, never
//     resolves to a command handler, and never imports filesystem,
//     lock, state, log, policy, commands, registry, adapter, CLI or
//     UI.

import { throwV2 } from "../../contracts/errors.mjs";

// EDGE_TYPES — local mirror of the kernel whitelist (BLOCKS,
// SUPERSEDES, DERIVED_FROM). Duplicated here intentionally: this
// module is a leaf provider and must not pull the kernel transaction
// surface into its import graph. `tx.addEdge` re-validates the type
// against its own whitelist under the lock, so any drift here
// surfaces immediately as INVALID_EDGE_TYPE at apply time.
const EDGE_TYPES = Object.freeze(["BLOCKS", "SUPERSEDES", "DERIVED_FROM"]);

const OP = "edge.add";
const REMOVE_OP = "edge.remove";
const LOG_ACTION = "add-edge";
const REMOVE_LOG_ACTION = "remove-edge";

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
  const from = asNonEmptyString(input.from);
  if (!from) {
    throwV2("MISSING_FIELD", `${OP}: --from required`, { field: "from" });
  }
  const to = asNonEmptyString(input.to);
  if (!to) {
    throwV2("MISSING_FIELD", `${OP}: --to required`, { field: "to" });
  }
  const type = asNonEmptyString(input.type);
  if (!type) {
    throwV2("MISSING_FIELD", `${OP}: --type required`, { field: "type" });
  }
  return { from, to, rawType: type };
}

function normalizeType(rawType) {
  const upper = rawType.toUpperCase();
  if (!EDGE_TYPES.includes(upper)) {
    throwV2(
      "INVALID_EDGE_TYPE",
      `${OP}: edge type '${rawType}' is not allowed (allowed: ${EDGE_TYPES.join(", ")})`,
      { type: rawType, allowed: EDGE_TYPES.slice() },
    );
  }
  return upper;
}

function validateEndpoints(from, to, snapshot) {
  const nodes = readSnapshotNodes(snapshot);
  if (from === to) {
    throwV2(
      "SELF_EDGE",
      `${OP}: edge ${from} -> ${to} is a self-edge`,
      { from, to, type: undefined },
    );
  }
  if (!nodes[from] || !nodes[to]) {
    const missing = !nodes[from] ? from : to;
    throwV2(
      "INVALID_EDGE_TARGET",
      `${OP}: edge references missing node '${missing}'`,
      { from, to, missing },
    );
  }
}

function validateNoSnapshotDuplicate(from, to, type, snapshot) {
  const edges = readSnapshotEdges(snapshot);
  const dup = edges.find((e) => e.from === from && e.to === to && e.type === type);
  if (dup) {
    throwV2(
      "DUPLICATE_EDGE",
      `${OP}: edge ${type} ${from} -> ${to} already exists`,
      { from, to, type, existing: { ...dup } },
    );
  }
}

/**
 * Pure `prepare` for edge.add.
 *
 * Contract:
 *   - read-only: never mutates the snapshot, never reaches outside the
 *     provided arguments;
 *   - validates input shape, normalizes type to uppercase, validates
 *     endpoints against the snapshot, rejects self-edges and
 *     duplicates already present in the snapshot;
 *   - returns a frozen plan: `{ target, policyAction, logAction,
 *     edge }`. `target.id` is the BLOCKS `to` endpoint so
 *     `kernel.mutate` can build its log entry without learning about
 *     the edge-only domain; the normalized `edge` is what apply feeds
 *     to `tx.addEdge`.
 *
 * @param {{ snapshot: object, input: object, request: object }} args
 * @returns {object} frozen plan
 */
async function prepare({ snapshot, input, request }) {
  // `request` is accepted for symmetry with the kernel contract and
  // provider-level context. edge.add currently does not need it for
  // validation; we mark it `void` so the linter does not flag the
  // parameter and callers can read request metadata without re-plumbing
  // the call site.
  void request;
  const { from, to, rawType } = validateInputShape(input);
  const type = normalizeType(rawType);
  validateEndpoints(from, to, snapshot);
  validateNoSnapshotDuplicate(from, to, type, snapshot);

  const edge = Object.freeze({ from, to, type });
  return Object.freeze({
    target: Object.freeze({
      // The kernel uses plan.target.id as the log entry's `node`
      // field (see src/kernel/mutate.mjs#buildLogEntry). The
      // BLOCKS-direction `to` endpoint is the canonical id for an
      // edge-shaped operation; matches the canonical add-edge log shape.
      id: to,
      from,
      to,
      type,
    }),
    policyAction: Object.freeze({ action: "edge.add", pluginId: null }),
    logAction: LOG_ACTION,
    edge,
  });
}

/**
 * Pure `apply` for edge.add.
 *
 * Contract:
 *   - mutates the tx draft only via exactly one `tx.addEdge`;
 *   - never writes revision, never calls fs/lock/state/log/handler;
 *   - returns `{ result, effects }` with the persisted edge shape.
 *
 * @param {{ tx: object, plan: object, input: object, request: object, snapshot: object }} args
 * @returns {Promise<{ result: object, effects: null }>}
 */
async function apply({ tx, plan, input, request, snapshot }) {
  void input;
  void request;
  void snapshot;
  if (!tx || typeof tx.addEdge !== "function") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: apply requires a tx with addEdge accessor`,
      { field: "tx" },
    );
  }
  const persisted = tx.addEdge(plan.edge);
  return {
    result: Object.freeze({
      edge: Object.freeze({ from: persisted.from, to: persisted.to, type: persisted.type }),
    }),
    effects: null,
  };
}

export const edgeAddProvider = Object.freeze({ prepare, apply });

function validateRemoveInputShape(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${REMOVE_OP}: input must be an object`, { field: "input" });
  }
  const from = asNonEmptyString(input.from);
  if (!from) {
    throwV2("MISSING_FIELD", `${REMOVE_OP}: --from required`, { field: "from" });
  }
  const to = asNonEmptyString(input.to);
  if (!to) {
    throwV2("MISSING_FIELD", `${REMOVE_OP}: --to required`, { field: "to" });
  }
  const rawType = asNonEmptyString(input.type);
  if (!rawType) {
    throwV2("MISSING_FIELD", `${REMOVE_OP}: --type required`, { field: "type" });
  }
  return { from, to, rawType };
}

function edgeExists(from, to, type, snapshot) {
  return readSnapshotEdges(snapshot).some((edge) =>
    edge && edge.from === from && edge.to === to && edge.type === type,
  );
}

/**
 * Pure `prepare` for edge.remove. An absent exact triple is intentionally
 * represented in the plan instead of rejected so the kernel can complete an
 * idempotent no-op without creating a log entry or changing state.revision.
 */
async function prepareRemove({ snapshot, input, request }) {
  void request;
  const { from, to, rawType } = validateRemoveInputShape(input);
  const type = normalizeType(rawType);
  const edge = Object.freeze({ from, to, type });
  return Object.freeze({
    target: Object.freeze({ id: to, from, to, type }),
    policyAction: Object.freeze({ action: REMOVE_OP, pluginId: null }),
    logAction: REMOVE_LOG_ACTION,
    edge,
    removed: edgeExists(from, to, type, snapshot),
  });
}

/** Apply edge.remove to the draft only when the exact edge is present. */
async function applyRemove({ tx, plan, input, request, snapshot }) {
  void input;
  void request;
  void snapshot;
  if (!tx || typeof tx.removeEdge !== "function") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${REMOVE_OP}: apply requires a tx with removeEdge accessor`,
      { field: "tx" },
    );
  }
  if (plan.removed) tx.removeEdge(plan.edge);
  return {
    result: Object.freeze({
      edge: Object.freeze({ from: plan.edge.from, to: plan.edge.to, type: plan.edge.type }),
      removed: plan.removed === true,
    }),
    effects: null,
  };
}

export const edgeRemoveProvider = Object.freeze({
  prepare: prepareRemove,
  apply: applyRemove,
});