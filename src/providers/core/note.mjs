// src/providers/core/note.mjs — pure provider for `note.add`.
//
// T-graph-kernel-provider-core-ops: completes the public surface of the
// graph kernel with a note-only operation that mirrors the public
// `add-note` CLI contract while running through `kernel.mutate`.
//
// Contract (ADR-011 §1 + §B6B):
//   - `prepare` is read-only. It validates the target id, the text
//     payload, and the `if_revision` precondition (ADR-011 §4 — every
//     agent-facing op that mutates a node requires if_revision). The
//     plan carries `{ target, if_revision, policyAction, logAction,
//     note }`.
//   - `apply` only mutates the in-memory tx draft: exactly one
//     `tx.updateNode` call that appends a single note to the
//     existing notes array. The note is timestamped with the current
//     ISO instant and stamped with the agent from `request.actor`
//     (matching the historical add-note CLI shape). The kernel owns
//     revision; the provider never writes or carries a `revision`
//     field.
//   - The provider is provider-only: it does NOT reach for argv, never
//     resolves to a legacy `handler`, and never imports filesystem,
//     lock, state, log, policy, commands, registry, adapter, CLI or
//     UI.

import { throwV2 } from "../../errors.mjs";

const OP = "note.add";
const LOG_ACTION = "add-note";

function asNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readSnapshotNodes(snapshot) {
  return snapshot && snapshot.nodes && typeof snapshot.nodes === "object" ? snapshot.nodes : {};
}

function validateInputShape(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: input must be an object`, { field: "input" });
  }
  const id = asNonEmptyString(input.id);
  if (!id) {
    throwV2("MISSING_FIELD", `${OP}: --id required (target node id)`, { field: "id" });
  }
  const text = asNonEmptyString(input.text);
  if (!text) {
    throwV2("MISSING_FIELD", `${OP}: --text required (note body)`, { field: "text" });
  }
  if (input.if_revision === undefined || input.if_revision === null) {
    throwV2(
      "MISSING_FIELD",
      `${OP}: input.if_revision required (ADR-011 §4 — every agent-facing op that mutates a node must declare its precondition)`,
      { field: "if_revision" },
    );
  }
  const expected = Number(input.if_revision);
  if (!Number.isInteger(expected) || expected < 1) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: input.if_revision must be a positive integer`,
      { field: "if_revision", value: input.if_revision },
    );
  }
  return { id, text, ifRevision: expected };
}

function validateTarget(id, snapshot) {
  const nodes = readSnapshotNodes(snapshot);
  const node = nodes[id];
  if (!node) {
    throwV2("NODE_NOT_FOUND", `${OP}: target node '${id}' not found`, { id });
  }
  return node;
}

function validateRevision(id, expected, snapshot) {
  const node = readSnapshotNodes(snapshot)[id];
  if (!node || !Number.isInteger(node.revision) || node.revision !== expected) {
    throwV2(
      "REVISION_CONFLICT",
      `${OP}: target node '${id}' changed since revision ${expected}`,
      { id, expected, current: Number.isInteger(node && node.revision) ? node.revision : null },
    );
  }
}

function validateRequestActor(request) {
  const actor = request && typeof request.actor === "string" ? request.actor : null;
  if (!actor) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: apply requires request.actor (kernel populates it from the calling agent)`,
      { field: "request.actor" },
    );
  }
  return actor;
}

/**
 * Pure `prepare` for note.add.
 *
 * Contract:
 *   - read-only: never mutates the snapshot, never reaches outside
 *     the provided arguments;
 *   - validates id, text and if_revision; resolves the target node
 *     and checks the CAS precondition;
 *   - returns a frozen plan: `{ target, if_revision, policyAction,
 *     logAction, note }`. `if_revision` is the single-CAS shape that
 *     `kernel.mutate` validates under the lock. `note` carries the
 *     agent from `request.actor` and the ISO timestamp captured at
 *     prepare time so apply does not need to re-read clock state.
 *
 * @param {{ snapshot: object, input: object, request: object }} args
 * @returns {object} frozen plan
 */
async function prepare({ snapshot, input, request }) {
  const { id, text, ifRevision } = validateInputShape(input);
  validateTarget(id, snapshot);
  validateRevision(id, ifRevision, snapshot);
  // request.actor is the canonical agent identity; captured in prepare
  // so apply never has to re-validate it under the lock. Note: we
  // intentionally do NOT fail here if the agent is missing — apply
  // raises INVALID_EXECUTION_CONTRACT so the error surfaces from the
  // single place the kernel reaches the provider.
  const actor = request && typeof request.actor === "string" && request.actor.length > 0
    ? request.actor
    : null;

  const note = Object.freeze({
    ts: new Date().toISOString(),
    agent: actor,
    text,
  });

  return Object.freeze({
    target: Object.freeze({
      id,
      kind: "node",
      revision: ifRevision,
    }),
    if_revision: Object.freeze({ kind: "single", id, value: ifRevision }),
    policyAction: Object.freeze({ action: "note.add", pluginId: null }),
    logAction: LOG_ACTION,
    note,
  });
}

/**
 * Pure `apply` for note.add.
 *
 * Contract:
 *   - mutates the tx draft only via exactly one `tx.updateNode`;
 *   - reads the existing notes array via `tx.getNode` so the patch
 *     can append without losing history;
 *   - never writes `revision` (the kernel diff assigns it once per
 *     node per apply);
 *   - returns `{ result, effects }` with the projected notes_count
 *     for the caller.
 *
 * @param {{ tx: object, plan: object, input: object, request: object, snapshot: object }} args
 * @returns {Promise<{ result: object, effects: null }>}
 */
async function apply({ tx, plan, input, request, snapshot }) {
  void input;
  void snapshot;
  if (!tx || typeof tx.updateNode !== "function" || typeof tx.getNode !== "function") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: apply requires a tx with updateNode/getNode accessors`,
      { field: "tx" },
    );
  }
  // Resolve the agent at apply time so request.actor — which the
  // kernel validates before invoking the provider — is the single
  // source of truth for the stamped author of the note.
  const actor = validateRequestActor(request);
  const existing = tx.getNode(plan.target.id);
  const previousNotes = Array.isArray(existing && existing.notes) ? existing.notes : [];
  const newNote = Object.freeze({
    ts: plan.note.ts,
    agent: actor,
    text: plan.note.text,
  });
  const nextNotes = Object.freeze([...previousNotes, newNote]);

  // Patch carries the new notes array only. `tx.updateNode` enforces
  // the no-revision rule on its own; the provider explicitly avoids
  // any `revision` field in the patch.
  tx.updateNode(plan.target.id, { notes: nextNotes });

  return {
    result: Object.freeze({
      id: plan.target.id,
      notes_count: nextNotes.length,
    }),
    effects: null,
  };
}

export const noteAddProvider = Object.freeze({ prepare, apply });